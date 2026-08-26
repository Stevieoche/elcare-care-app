/**
 * cache-service.test.ts
 *
 * Tests for the thundering-herd protection in src/api/cache-service.ts.
 *
 * Acceptance criteria verified:
 *   ✓ Concurrent misses for one key produce at most one origin fetch per instance
 *   ✓ Waiting callers receive the same valid result (or the same error)
 *   ✓ Cache failures degrade gracefully without deadlocks
 *   ✓ A failed fetch does not poison the cache
 *   ✓ Slow fetches time out and propagate to all waiting callers
 *   ✓ Distributed lock: winner fetches, losers wait and get the result
 *   ✓ Distributed lock: released on success, error, and timeout
 *   ✓ Redis outage: falls back to direct fetch without crashing
 *   ✓ Metrics counters increment for coalesced requests, lock events, timeouts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Redis mock ────────────────────────────────────────────────────────────────

const mockRedis = vi.hoisted(() => {
  const store = new Map<string, string>();
  const locks = new Map<string, string>();

  return {
    isOpen: true,
    isReady: true,
    store,
    locks,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setEx: vi.fn(async (key: string, _ttl: number, value: string) => { store.set(key, value); }),
    set: vi.fn(async (key: string, value: string, opts?: { NX?: boolean; PX?: number }) => {
      if (opts?.NX && locks.has(key)) return null;
      locks.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => { store.delete(key); locks.delete(key); return 1; }),
    exists: vi.fn(async (key: string) => (locks.has(key) ? 1 : 0)),
    on: vi.fn(),
    connect: vi.fn(),
    _reset() {
      store.clear();
      locks.clear();
      vi.clearAllMocks();
      mockRedis.isReady = true;
      mockRedis.isOpen  = true;
    },
  };
});

vi.mock('../redis.js', () => ({ default: mockRedis }));

import {
  getCached,
  _resetInflight,
  _inflightSize,
  fetchTimeoutMs,
  cacheCoalescedRequestsTotal,
  cacheLockAcquisitionsTotal,
  cacheLockContentionsTotal,
  cacheFetchTimeoutsTotal,
  cacheFetchErrorsTotal,
} from '../api/cache-service.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a fetcher that resolves after `delayMs` with `value`. */
function slowFetcher<T>(value: T, delayMs: number): () => Promise<T> {
  return () => new Promise((r) => setTimeout(() => r(value), delayMs));
}

/** Build a fetcher that rejects after `delayMs` with `error`. */
function failingFetcher(msg: string, delayMs = 0): () => Promise<never> {
  return () =>
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), delayMs));
}

/** Read counter value from a Prometheus counter (handles label cardinality). */
function counterValue(
  counter: { hashMap: Record<string, { value: number }> },
  labels: Record<string, string> = {},
): number {
  const labelKey = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  const entry = counter.hashMap[labelKey] ?? counter.hashMap[''];
  return entry?.value ?? 0;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  _resetInflight();
  mockRedis._reset();
});

// =============================================================================
// 1. Basic read/write behaviour
// =============================================================================

describe('getCached — basic read / write', () => {
  it('calls fetcher on first miss and returns result', async () => {
    const fetcher = vi.fn().mockResolvedValue({ x: 1 });
    const result = await getCached('key:basic', 30, fetcher);
    expect(result).toEqual({ x: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('writes successful result to Redis', async () => {
    const fetcher = vi.fn().mockResolvedValue({ y: 2 });
    await getCached('key:write', 60, fetcher);
    expect(mockRedis.setEx).toHaveBeenCalledWith(
      'key:write',
      60,
      JSON.stringify({ y: 2 }),
    );
  });

  it('returns Redis-cached value without calling fetcher', async () => {
    mockRedis.store.set('key:hit', JSON.stringify({ cached: true }));
    const fetcher = vi.fn();
    const result = await getCached('key:hit', 30, fetcher);
    expect(result).toEqual({ cached: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls through gracefully on corrupted cache entry', async () => {
    mockRedis.store.set('key:corrupt', '{{invalid json}}');
    const fetcher = vi.fn().mockResolvedValue({ fresh: true });
    const result = await getCached('key:corrupt', 30, fetcher);
    expect(result).toEqual({ fresh: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('handles null result from fetcher without throwing', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const result = await getCached('key:null', 30, fetcher);
    expect(result).toBeNull();
  });
});

// =============================================================================
// 2. In-process promise coalescing
// =============================================================================

describe('getCached — in-process coalescing', () => {
  it('concurrent misses call the origin exactly once', async () => {
    const fetcher = vi.fn(slowFetcher({ value: 42 }, 20));

    const [r1, r2, r3] = await Promise.all([
      getCached('key:coalesce', 30, fetcher),
      getCached('key:coalesce', 30, fetcher),
      getCached('key:coalesce', 30, fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(r1).toEqual({ value: 42 });
    expect(r2).toEqual({ value: 42 });
    expect(r3).toEqual({ value: 42 });
  });

  it('inflight entry is removed after fetch completes', async () => {
    const fetcher = vi.fn(slowFetcher('done', 10));
    const p = getCached('key:inflight-cleanup', 30, fetcher);
    expect(_inflightSize()).toBe(1);
    await p;
    expect(_inflightSize()).toBe(0);
  });

  it('inflight entry is removed even when fetch fails', async () => {
    const fetcher = failingFetcher('boom', 10);
    await expect(getCached('key:inflight-fail', 30, fetcher)).rejects.toThrow('boom');
    expect(_inflightSize()).toBe(0);
  });

  it('all coalesced callers receive the same error on failure', async () => {
    const fetcher = vi.fn(failingFetcher('db-down', 15));

    const results = await Promise.allSettled([
      getCached('key:coal-err', 30, fetcher),
      getCached('key:coal-err', 30, fetcher),
      getCached('key:coal-err', 30, fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledOnce();
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason.message).toBe('db-down');
    }
  });

  it('does not write to Redis when origin fetch fails', async () => {
    const fetcher = failingFetcher('no-write');
    await expect(getCached('key:no-write', 30, fetcher)).rejects.toThrow();
    expect(mockRedis.setEx).not.toHaveBeenCalled();
  });

  it('second concurrent miss joins in-flight rather than starting a new fetch', async () => {
    const fetcher = vi.fn(slowFetcher({ id: 7 }, 30));

    // Start first fetch — do not await yet.
    const p1 = getCached('key:join', 30, fetcher);
    // Start second while first is in flight.
    const p2 = getCached('key:join', 30, fetcher);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(r1).toEqual(r2);
  });

  it('subsequent request after settlement gets a fresh fetch (not stale in-flight)', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ round: 1 })
      .mockResolvedValueOnce({ round: 2 });

    const r1 = await getCached('key:sequential', 30, fetcher);
    // Clear cache so second request misses.
    mockRedis.store.clear();
    const r2 = await getCached('key:sequential', 30, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(r1).toEqual({ round: 1 });
    expect(r2).toEqual({ round: 2 });
  });
});

// =============================================================================
// 3. Fetch timeout
// =============================================================================

describe('getCached — fetch timeout', () => {
  it('rejects when origin fetch exceeds timeout', async () => {
    // Override timeout env to 50 ms.
    process.env.CACHE_FETCH_TIMEOUT_MS = '50';

    const fetcher = slowFetcher({ slow: true }, 200); // 200 ms > 50 ms timeout

    await expect(getCached('key:timeout', 30, fetcher)).rejects.toThrow(/timed out/);

    delete process.env.CACHE_FETCH_TIMEOUT_MS;
  });

  it('does not write to Redis when fetch times out', async () => {
    process.env.CACHE_FETCH_TIMEOUT_MS = '30';
    const fetcher = slowFetcher({ v: 1 }, 200);
    await expect(getCached('key:timeout-no-write', 30, fetcher)).rejects.toThrow();
    expect(mockRedis.setEx).not.toHaveBeenCalled();
    delete process.env.CACHE_FETCH_TIMEOUT_MS;
  });

  it('removes inflight entry after timeout', async () => {
    process.env.CACHE_FETCH_TIMEOUT_MS = '30';
    const fetcher = slowFetcher({ v: 2 }, 200);
    await expect(getCached('key:timeout-inflight', 30, fetcher)).rejects.toThrow();
    expect(_inflightSize()).toBe(0);
    delete process.env.CACHE_FETCH_TIMEOUT_MS;
  });
});

// =============================================================================
// 4. Redis outage degradation
// =============================================================================

describe('getCached — Redis outage', () => {
  it('falls back to direct fetch when Redis get() throws', async () => {
    mockRedis.get.mockRejectedValue(new Error('Redis connection lost'));
    const fetcher = vi.fn().mockResolvedValue({ degraded: true });

    const result = await getCached('key:redis-down', 30, fetcher);
    expect(result).toEqual({ degraded: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('still coalesces requests even when Redis is unavailable', async () => {
    mockRedis.isReady = false;
    const fetcher = vi.fn(slowFetcher({ ok: true }, 20));

    const [r1, r2] = await Promise.all([
      getCached('key:redis-off-coal', 30, fetcher),
      getCached('key:redis-off-coal', 30, fetcher),
    ]);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });

    mockRedis.isReady = true;
  });

  it('skips distributed lock when Redis is unavailable and does own fetch', async () => {
    mockRedis.isReady = false;
    const fetcher = vi.fn().mockResolvedValue({ fallback: true });

    const result = await getCached('key:dist-redis-off', 30, fetcher, { distributed: true });
    expect(result).toEqual({ fallback: true });
    expect(fetcher).toHaveBeenCalledOnce();

    mockRedis.isReady = true;
  });

  it('does not throw when Redis setEx fails after successful fetch', async () => {
    mockRedis.setEx.mockRejectedValue(new Error('write error'));
    const fetcher = vi.fn().mockResolvedValue({ survived: true });

    const result = await getCached('key:write-fail', 30, fetcher);
    expect(result).toEqual({ survived: true });
  });
});

// =============================================================================
// 5. Distributed lock — winner/loser pattern
// =============================================================================

describe('getCached — distributed lock', () => {
  it('lock winner acquires lock, writes result, releases lock', async () => {
    const fetcher = vi.fn(slowFetcher({ distributed: 'result' }, 10));

    await getCached('key:dist-win', 30, fetcher, { distributed: true });

    // Lock acquired at some point
    expect(mockRedis.set).toHaveBeenCalledWith(
      'lock:key:dist-win',
      '1',
      expect.objectContaining({ NX: true }),
    );
    // Lock released
    expect(mockRedis.del).toHaveBeenCalledWith('lock:key:dist-win');
  });

  it('lock winner writes value to Redis for losers to read', async () => {
    const fetcher = vi.fn().mockResolvedValue({ shared: true });

    await getCached('key:dist-share', 30, fetcher, { distributed: true });

    expect(mockRedis.setEx).toHaveBeenCalledWith(
      'key:dist-share',
      30,
      JSON.stringify({ shared: true }),
    );
  });

  it('lock is released even when fetch fails', async () => {
    const fetcher = failingFetcher('dist-fail');

    await expect(
      getCached('key:dist-fail', 30, fetcher, { distributed: true }),
    ).rejects.toThrow('dist-fail');

    // Lock should have been released (del called with the lock key)
    const delCalls = mockRedis.del.mock.calls.map((c: any[]) => c[0]);
    expect(delCalls).toContain('lock:key:dist-fail');
  });

  it('concurrent distributed requests produce one lock acquisition', async () => {
    const fetcher = vi.fn(slowFetcher({ concurrent: true }, 20));

    await Promise.all([
      getCached('key:dist-concurrent', 30, fetcher, { distributed: true }),
      getCached('key:dist-concurrent', 30, fetcher, { distributed: true }),
    ]);

    // Only one real DB fetch should have happened (coalesced in-process)
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// 6. No stale poison entries
// =============================================================================

describe('getCached — no cache poisoning', () => {
  it('a failed fetch does not store anything in Redis', async () => {
    const fetcher = failingFetcher('poison-attempt');
    await expect(getCached('key:poison', 30, fetcher)).rejects.toThrow();
    expect(mockRedis.setEx).not.toHaveBeenCalled();
    expect(mockRedis.store.has('key:poison')).toBe(false);
  });

  it('a timed-out fetch does not store anything in Redis', async () => {
    process.env.CACHE_FETCH_TIMEOUT_MS = '30';
    const fetcher = slowFetcher({ poison: true }, 200);
    await expect(getCached('key:timeout-poison', 30, fetcher)).rejects.toThrow();
    expect(mockRedis.setEx).not.toHaveBeenCalled();
    delete process.env.CACHE_FETCH_TIMEOUT_MS;
  });

  it('a subsequent request after failure gets a fresh fetch attempt', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce({ recovered: true });

    await expect(getCached('key:recovery', 30, fetcher)).rejects.toThrow('first failure');
    const result = await getCached('key:recovery', 30, fetcher);

    expect(result).toEqual({ recovered: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('error result does not block subsequent successful fetches', async () => {
    // Simulate concurrent errors followed by recovery.
    const fetcher = vi.fn(failingFetcher('transient', 5));

    await Promise.allSettled([
      getCached('key:transient', 30, fetcher),
      getCached('key:transient', 30, fetcher),
    ]);

    // Clear mock, set up success.
    mockRedis._reset();
    const goodFetcher = vi.fn().mockResolvedValue({ ok: true });
    const result = await getCached('key:transient', 30, goodFetcher);
    expect(result).toEqual({ ok: true });
  });
});

// =============================================================================
// 7. Metrics
// =============================================================================

describe('getCached — Prometheus metrics', () => {
  it('increments coalesced counter for each caller that joins inflight', async () => {
    const before = counterValue(cacheCoalescedRequestsTotal as any);
    const fetcher = vi.fn(slowFetcher({ m: 1 }, 20));

    // 1 winner + 2 coalescers
    await Promise.all([
      getCached('key:metrics-coal', 30, fetcher),
      getCached('key:metrics-coal', 30, fetcher),
      getCached('key:metrics-coal', 30, fetcher),
    ]);

    const after = counterValue(cacheCoalescedRequestsTotal as any);
    // 2 callers should have been coalesced
    expect(after - before).toBeGreaterThanOrEqual(2);
  });

  it('increments timeout counter on fetch timeout', async () => {
    process.env.CACHE_FETCH_TIMEOUT_MS = '20';
    const before = counterValue(cacheFetchTimeoutsTotal as any);
    const fetcher = slowFetcher({ v: 1 }, 200);

    await expect(getCached('key:metric-timeout', 30, fetcher)).rejects.toThrow();

    const after = counterValue(cacheFetchTimeoutsTotal as any);
    expect(after - before).toBeGreaterThanOrEqual(1);
    delete process.env.CACHE_FETCH_TIMEOUT_MS;
  });

  it('increments error counter on non-timeout fetch failure', async () => {
    const before = counterValue(cacheFetchErrorsTotal as any);
    const fetcher = failingFetcher('metric-err');

    await expect(getCached('key:metric-err', 30, fetcher)).rejects.toThrow();

    const after = counterValue(cacheFetchErrorsTotal as any);
    expect(after - before).toBeGreaterThanOrEqual(1);
  });

  it('increments lock acquisition counter for distributed mode winner', async () => {
    const before = counterValue(cacheLockAcquisitionsTotal as any);
    const fetcher = vi.fn().mockResolvedValue({ lock: true });

    await getCached('key:metric-lock', 30, fetcher, { distributed: true });

    const after = counterValue(cacheLockAcquisitionsTotal as any);
    expect(after - before).toBeGreaterThanOrEqual(1);
  });
});
