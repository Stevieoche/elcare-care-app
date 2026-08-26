/**
 * cache-service.ts
 *
 * Thundering-herd protection for the Redis cache layer.
 *
 * Problem
 * -------
 * When a popular key expires, many concurrent requests all miss the cache at
 * the same moment and simultaneously hit PostgreSQL (the "thundering herd" or
 * "cache stampede"). The existing getCached() helper in routes.ts has no
 * protection: every concurrent miss fires an independent DB query.
 *
 * Solution — two complementary layers
 * ------------------------------------
 * 1. In-process promise coalescing (always active)
 *    A Map<key, Promise> tracks in-flight fetches. While a fetch is running,
 *    all subsequent callers for the same key receive the same Promise.
 *    This is zero-overhead and works even when Redis is unavailable.
 *    Scope: single Node.js instance.
 *
 * 2. Distributed Redis lock (when Redis is available, opt-in per call)
 *    Uses SET NX PX (atomic set-if-not-exists with TTL) to elect exactly one
 *    instance across a cluster to run the origin fetch. Losers wait and then
 *    re-read from Redis. If the winner fails or the lock expires, losers fall
 *    through to their own fetch — correctness is preserved.
 *    Scope: all instances sharing the same Redis.
 *
 * Safety properties
 * -----------------
 * - Origin fetch timeout: configurable, defaults 30 s. Slow fetches are
 *   cancelled and the error is propagated to all waiting callers.
 * - Poisoning prevention: only successful results are written to Redis.
 *   A failed origin fetch clears the in-process inflight entry immediately so
 *   the next request gets a fresh try.
 * - Lock TTL: set to fetchTimeoutMs + 1 s so a crashed winner always releases
 *   its lock before the TTL fires.
 * - Graceful Redis outage: all Redis errors are caught; the service falls back
 *   to in-process coalescing (or direct DB) silently.
 * - No deadlock risk: locks are TTL-bound and never held beyond fetchTimeoutMs.
 *
 * Metrics
 * -------
 * Increments Prometheus counters for coalesced requests, lock acquisitions,
 * lock contentions, and fetch timeouts — all observable via /metrics.
 *
 * Usage
 * -----
 *   import { getCached } from './cache-service.js';
 *
 *   // Simple in-process coalescing + Redis read/write
 *   const result = await getCached('listings:active', 30, () => prisma.listing.findMany(...));
 *
 *   // With distributed lock (multi-instance deployments)
 *   const result = await getCached('stats:global', 60, () => expensiveQuery(), { distributed: true });
 */

import redis from '../redis.js';
import { logger } from '../logger.js';
import client from 'prom-client';

// ── Metrics ───────────────────────────────────────────────────────────────────

export const cacheCoalescedRequestsTotal = new client.Counter({
  name: 'elcarehub_cache_coalesced_requests_total',
  help: 'Requests that joined an in-flight cache fetch rather than issuing their own DB query',
  labelNames: ['key_prefix'],
});

export const cacheLockAcquisitionsTotal = new client.Counter({
  name: 'elcarehub_cache_lock_acquisitions_total',
  help: 'Successful Redis distributed lock acquisitions for cache fills',
  labelNames: ['key_prefix'],
});

export const cacheLockContentionsTotal = new client.Counter({
  name: 'elcarehub_cache_lock_contentions_total',
  help: 'Requests that lost a distributed lock race and waited for the winner',
  labelNames: ['key_prefix'],
});

export const cacheFetchTimeoutsTotal = new client.Counter({
  name: 'elcarehub_cache_fetch_timeouts_total',
  help: 'Origin fetches that exceeded the configured timeout and were aborted',
  labelNames: ['key_prefix'],
});

export const cacheFetchErrorsTotal = new client.Counter({
  name: 'elcarehub_cache_fetch_errors_total',
  help: 'Origin fetches that failed with an error (not timeout)',
  labelNames: ['key_prefix'],
});

// ── Configuration ─────────────────────────────────────────────────────────────

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = parseInt(v, 10);
  return isNaN(n) ? def : n;
}

/** Maximum time (ms) to wait for an origin fetch before aborting. */
export function fetchTimeoutMs(): number {
  return envInt('CACHE_FETCH_TIMEOUT_MS', 30_000);
}

/** Time (ms) a distributed lock loser waits between Redis re-reads. */
export function lockPollIntervalMs(): number {
  return envInt('CACHE_LOCK_POLL_MS', 50);
}

/** Maximum time (ms) a lock loser waits before issuing its own fetch. */
export function lockWaitTimeoutMs(): number {
  return envInt('CACHE_LOCK_WAIT_MS', 5_000);
}

/** Lock key TTL = fetchTimeoutMs + 1 s (ensures the lock always expires). */
function lockTtlMs(): number {
  return fetchTimeoutMs() + 1_000;
}

// ── In-process coalescing map ─────────────────────────────────────────────────
//
// Maps cache key → active Promise<unknown>. Entries are deleted when the
// promise settles (success or error).

const inflight = new Map<string, Promise<unknown>>();

// ── Redis helpers ─────────────────────────────────────────────────────────────

function isRedisReady(r: any): boolean {
  if (typeof r?.isReady === 'boolean') return r.isReady;
  if (typeof r?.status === 'string') return r.status === 'ready';
  return Boolean(r?.isOpen);
}

async function redisGet(key: string): Promise<string | null> {
  try {
    if (!isRedisReady(redis)) return null;
    return await (redis as any).get(key);
  } catch {
    return null;
  }
}

async function redisSetEx(key: string, ttlSeconds: number, value: string): Promise<void> {
  try {
    if (!isRedisReady(redis)) return;
    await (redis as any).setEx(key, ttlSeconds, value);
  } catch {
    // Non-fatal — caller continues without cache
  }
}

/**
 * Attempt to acquire a Redis distributed lock.
 * Returns true if the lock was acquired (this instance is the fetch winner).
 */
async function acquireLock(lockKey: string): Promise<boolean> {
  try {
    if (!isRedisReady(redis)) return false;
    // SET lockKey "1" NX PX <ttlMs>  — atomic, returns "OK" or null
    const result = await (redis as any).set(lockKey, '1', {
      NX: true,
      PX: lockTtlMs(),
    });
    return result === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock(lockKey: string): Promise<void> {
  try {
    if (!isRedisReady(redis)) return;
    await (redis as any).del(lockKey);
  } catch {
    // Ignore — TTL will clean it up
  }
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[cache-service] Origin fetch timed out after ${timeoutMs}ms (${label})`));
    }, timeoutMs);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── Key prefix for metrics labels ─────────────────────────────────────────────

function keyPrefix(key: string): string {
  // Use the first two slash-separated segments as label to bound cardinality.
  const parts = key.replace(/^cache:/, '').split('/').filter(Boolean);
  return parts.slice(0, 2).join('/') || key.slice(0, 20);
}

// ── Core getCached ────────────────────────────────────────────────────────────

export interface GetCachedOptions {
  /**
   * When true, uses a Redis distributed lock to ensure at most one instance
   * runs the origin fetch per lock window. Recommended for very popular keys
   * (stats, listings first page) in multi-instance deployments.
   * Default: false (in-process coalescing only).
   */
  distributed?: boolean;
}

/**
 * Fetch a value from Redis cache, coalescing concurrent misses.
 *
 * @param key        Redis cache key (e.g. "cache:/listings?limit=20")
 * @param ttl        Cache TTL in seconds for successful results
 * @param fetcher    Async function that reads from the origin (DB, RPC, etc.)
 * @param opts       Optional coalescing/locking options
 * @returns          The cached or freshly-fetched value
 */
export async function getCached<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
  opts: GetCachedOptions = {},
): Promise<T> {
  const prefix = keyPrefix(key);

  // ── 1. Fast path: check Redis cache ──────────────────────────────────────
  const cached = await redisGet(key);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      // Corrupted cache entry — fall through to origin fetch
      logger.warn('cache-service.corrupt_entry', { key });
    }
  }

  // ── 2. In-process coalescing: join an in-flight fetch if one exists ───────
  const existing = inflight.get(key);
  if (existing) {
    cacheCoalescedRequestsTotal.labels(prefix).inc();
    return existing as Promise<T>;
  }

  // ── 3. Distributed lock (optional, multi-instance) ────────────────────────
  if (opts.distributed && isRedisReady(redis)) {
    const lockKey = `lock:${key}`;
    const acquired = await acquireLock(lockKey);

    if (!acquired) {
      // Another instance is filling this key — wait and re-read.
      cacheLockContentionsTotal.labels(prefix).inc();
      const waitResult = await waitForCachedValue<T>(key, lockKey, prefix);
      if (waitResult !== undefined) return waitResult;
      // Lock wait timed out or value still absent — fall through to our own fetch.
    } else {
      cacheLockAcquisitionsTotal.labels(prefix).inc();
      // We hold the lock — do the fetch and release when done.
      return runFetch<T>(key, ttl, fetcher, prefix, lockKey);
    }
  }

  // ── 4. In-process fetch: register promise, run fetcher ───────────────────
  return runFetch<T>(key, ttl, fetcher, prefix, undefined);
}

// ── runFetch ──────────────────────────────────────────────────────────────────
//
// Registers the fetch promise in the inflight map, executes the origin fetcher
// with a timeout, writes successes to Redis, and always removes the inflight
// entry on completion. Releases the distributed lock on completion if held.

async function runFetch<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
  prefix: string,
  lockKey: string | undefined,
): Promise<T> {
  const timeout = fetchTimeoutMs();

  const promise = (async () => {
    try {
      const result = await withTimeout(fetcher(), timeout, key);

      // Write to Redis only on success — never poison the cache with errors.
      await redisSetEx(key, ttl, JSON.stringify(result));

      return result;
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes('timed out');
      if (isTimeout) {
        cacheFetchTimeoutsTotal.labels(prefix).inc();
      } else {
        cacheFetchErrorsTotal.labels(prefix).inc();
      }

      logger.warn('cache-service.fetch_failed', {
        event: 'cache-service.fetch_failed',
        key,
        isTimeout,
        error: err instanceof Error ? err.message : String(err),
      });

      // Re-throw so callers (including coalesced waiters) get the error.
      throw err;
    } finally {
      // Remove in-flight entry immediately — next caller gets a fresh fetch.
      inflight.delete(key);
      // Release distributed lock if we hold one.
      if (lockKey) {
        await releaseLock(lockKey);
      }
    }
  })();

  inflight.set(key, promise);
  return promise as Promise<T>;
}

// ── waitForCachedValue ────────────────────────────────────────────────────────
//
// Polls Redis until the key appears (another instance wrote it) or the wait
// timeout expires. Returns undefined when the value never appeared.

async function waitForCachedValue<T>(
  key: string,
  lockKey: string,
  prefix: string,
): Promise<T | undefined> {
  const deadline = Date.now() + lockWaitTimeoutMs();
  const pollInterval = lockPollIntervalMs();

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const value = await redisGet(key);
    if (value !== null) {
      try {
        return JSON.parse(value) as T;
      } catch {
        return undefined;
      }
    }

    // Check if the lock was released (winner finished or crashed).
    try {
      if (!isRedisReady(redis)) break;
      const lockExists = await (redis as any).exists(lockKey);
      if (!lockExists) break; // Winner is done — fall through to our own fetch.
    } catch {
      break;
    }
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Exposed for testing ───────────────────────────────────────────────────────

/** Reset the in-process inflight map. Call in beforeEach for isolation. */
export function _resetInflight(): void {
  inflight.clear();
}

/** Snapshot the inflight map size (for assertions). */
export function _inflightSize(): number {
  return inflight.size;
}
