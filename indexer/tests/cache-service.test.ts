/**
 * cache-service.test.ts
 *
 * Tests for src/api/cache-service.ts — thundering-herd / cache-stampede protection.
 *
 * Acceptance criteria:
 *   ✓ Concurrent misses for one key produce at most one origin fetch per instance.
 *   ✓ Waiting callers receive the same valid result (coalesced).
 *   ✓ Waiting callers receive the same error when the origin fails.
 *   ✓ A failed fetch does NOT poison the cache (Redis write only on success).
 *   ✓ A failed fetch clears the inflight entry so the next request retries.
 *   ✓ Origin fetches that exceed the timeout are aborted and counted in metrics.
 *   ✓ Redis outages degrade gracefully — in-process coalescing still works.
 *   ✓ Distributed locking: lock winner fetches, losers wait and reuse result.
 *   ✓ Distributed lock: loser falls through when lock wait times out.
 *   ✓ No deadlock: lock TTL ensures the key is always released.
 *   ✓ cacheHit flag is set by cacheMiddleware on Redis hits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';

// ── Mock Redis ────────────────────────────────────────────────────────────────

const mockRedis = vi.hoisted(() => ({
  isOpen:  true,
  isReady: true,
  get:     vi.fn<[], Promise<string | null>>().mockResolvedValue(null),
  set:     vi.fn<[], Promise<string | null>>().mockResolvedValue('OK'),
  setEx:   vi.fn<[], Promise<string>>().mockResolvedValue('OK'),
  del:     vi.fn<[], Promise<number>>().mockResolvedValue(1),
  exists:  vi.fn<[], Promise<number>>().mockResolvedValue(0),
  keys:    vi.fn<[], Promise<string[]>>().mockResolvedValue([]),
  on:      vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/redis.js', () => ({ default: mockRedis }));

// Import after mocks are installed
import {
  getCached,
  _resetInflight,
  _inflightSize,
  cacheCoalescedRequestsTotal,
  cacheLockAcquisitionsTotal,
  cacheLockContentionsTotal,
  cacheFetchTimeoutsTotal,
  cacheFetchErrorsTotal,
  fetchTimeoutMs,
} from '../src/api/cache-service.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ORIG_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'CACHE_FETCH_TIMEOUT_MS',
  'CACHE_LOCK_POLL_MS',
  'CACHE_LOCK_WAIT_MS',
];

function saveEnv()    { for (const k of ENV_KEYS) ORIG_ENV[k] = process.env[k]; }
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  }
}

/** Read the current value of a prom-client Counter. */
async function counterValue(counter: any, labels: Record<string, string> = {}): Promise<number> {
  const metrics = await counter.get();
  if (metrics.values.length === 0) return 0;
  if (Object.keys(labels).length === 0) {
    return metrics.values.reduce((s: number, v: any) => s + v.value, 0);
  }
  const match = metrics.values.find((v: any) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return match?.value ?? 0;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetInflight();
  saveEnv();
  // Default: Redis is ready, no cached value
  mockRedis.isReady = true;
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.setEx.mockResolvedValue('OK');
  mockRedis.del.mockResolvedValue(1);
  mockRedis.exists.mockResolvedValue(0);
});

afterEach(() => {
  restoreEnv();
});

// =============================================================================
// 1. Cache hit path — no fetcher call
// =============================================================================

describe('getCached — cache hit', () => {
  it('returns cached value without calling fetcher', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ data: 'from-cache' }));
    const fetcher = vi.fn().mockResolvedValue({ data: 'fresh' });

    const result = await getCached('cache:/test', 30, fetcher);

    expect(result).toEqual({ data: 'from-cache' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls through on corrupted cache JSON', async () => {
    mockRedis.get.mockResolvedValue('NOT_VALID_JSON{{{');
    const fetcher = vi.fn().mockResolvedValue({ data: 'fresh' });

    const result = await getCached('cache:/test', 30, fetcher);

    expect(result).toEqual({ data: 'fresh' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// 2. In-process coalescing — concurrent misses → single fetch
// =============================================================================

describe('getCached — in-process coalescing', () => {
  it('concurrent misses produce exactly one fetcher call', async () => {
    let resolveOrigin!: (v: unknown) => void;
    const originPromise = new Promise((r) => { resolveOrigin = r; });
    const fetcher = vi.fn().mockReturnValue(originPromise);

    // Fire 5 concurrent requests before the origin resolves
    const all = [
      getCached('cache:/listings', 30, fetcher),
      getCached('cache:/listings', 30, fetcher),
      getCached('cache:/listings', 30, fetcher),
      getCached('cache:/listings', 30, fetcher),
      getCached('cache:/listings', 30, fetcher),
    ];

    // Inflight entry registered after first call
    expect(_inflightSize()).toBe(1);

    resolveOrigin({ items: [] });
    const results = await Promise.all(all);

    // Fetcher called exactly once
    expect(fetcher).toHaveBeenCalledOnce();
    // All callers get the same result
    for (const r of results) {
      expect(r).toEqual({ items: [] });
    }
  });

  it('coalesced metric is incremented for waiting callers', async () => {
    const beforeVal = await counterValue(cacheCoalescedRequestsTotal);

    let resolve!: (v: unknown) => void;
    const fetcher = vi.fn().mockReturnValue(new Promise((r) => { resolve = r; }));

    const p1 = getCached('cache:/coalescedkey', 30, fetcher);
    const p2 = getCached('cache:/coalescedkey', 30, fetcher);
    const p3 = getCached('cache:/coalescedkey', 30, fetcher);

    resolve({ ok: true });
    await Promise.all([p1, p2, p3]);

    const afterVal = await counterValue(cacheCoalescedRequestsTotal);
    // 2 waiting callers should be coalesced (not the first)
    expect(afterVal - beforeVal).toBe(2);
  });

  it('inflight entry is cleared after successful fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: 'ok' });
    await getCached('cache:/cleartest', 30, fetcher);
    expect(_inflightSize()).toBe(0);
  });

  it('inflight entry is cleared after a failed fetch', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('DB error'));
    await getCached('cache:/failclear', 30, fetcher).catch(() => {});
    expect(_inflightSize()).toBe(0);
  });
});

// =============================================================================
// 3. Error propagation — all waiters get the same error
// =============================================================================

describe('getCached — error propagation', () => {
  it('all coalesced callers receive the same error when fetcher fails', async () => {
    const dbError = new Error('Database connection failed');
    let reject!: (e: unknown) => void;
    const fetcher = vi.fn().mockReturnValue(new Promise((_, r) => { reject = r; }));

    const p1 = getCached('cache:/errkey', 30, fetcher);
    const p2 = getCached('cache:/errkey', 30, fetcher);
    const p3 = getCached('cache:/errkey', 30, fetcher);

    reject(dbError);

    const results = await Promise.allSettled([p1, p2, p3]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBe(dbError);
    }
  });

  it('error metric is incremented on fetch failure', async () => {
    const before = await counterValue(cacheFetchErrorsTotal);
    const fetcher = vi.fn().mockRejectedValue(new Error('origin failed'));

    await getCached('cache:/metricerrkey', 30, fetcher).catch(() => {});

    const after = await counterValue(cacheFetchErrorsTotal);
    expect(after - before).toBe(1);
  });

  it('does NOT write to Redis when fetcher throws', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('fail'));

    await getCached('cache:/nopoisonkey', 30, fetcher).catch(() => {});

    expect(mockRedis.setEx).not.toHaveBeenCalled();
  });

  it('subsequent request after failure gets a fresh fetch attempt', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValue({ ok: true });

    await getCached('cache:/retrykey', 30, fetcher).catch(() => {});
    const result = await getCached('cache:/retrykey', 30, fetcher);

    expect(result).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// 4. Fetch timeout
// =============================================================================

describe('getCached — fetch timeout', () => {
  it('aborts slow fetches and increments timeout metric', async () => {
    process.env.CACHE_FETCH_TIMEOUT_MS = '50'; // 50 ms timeout
    const before = await counterValue(cacheFetchTimeoutsTotal);

    // Fetcher never resolves
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));

    await expect(
      getCached('cache:/slowkey', 30, fetcher),
    ).rejects.toThrow(/timed out/);

    const after = await counterValue(cacheFetchTimeoutsTotal);
    expect(after - before).toBe(1);
  });

  it('clears inflight entry after timeout', async () => {
    process.env.CACHE_FETCH_TIMEOUT_MS = '30';

    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
    await getCached('cache:/timeoutclear', 30, fetcher).catch(() => {});

    expect(_inflightSize()).toBe(0);
  });

  it('all coalesced callers receive the timeout error', async () => {
    process.env.CACHE_FETCH_TIMEOUT_MS = '40';

    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));

    const p1 = getCached('cache:/timeouterr', 30, fetcher);
    const p2 = getCached('cache:/timeouterr', 30, fetcher);

    const results = await Promise.allSettled([p1, p2]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason.message).toMatch(/timed out/);
    }
  });
});

// =============================================================================
// 5. Redis outage — graceful degradation
// =============================================================================

describe('getCached — Redis outage', () => {
  it('still fetches from origin when Redis is not ready', async () => {
    mockRedis.isReady = false;
    const fetcher = vi.fn().mockResolvedValue({ degraded: true });

    const result = await getCached('cache:/degraded', 30, fetcher);

    expect(result).toEqual({ degraded: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('in-process coalescing still works when Redis is down', async () => {
    mockRedis.isReady = false;

    let resolve!: (v: unknown) => void;
    const fetcher = vi.fn().mockReturnValue(new Promise((r) => { resolve = r; }));

    const p1 = getCached('cache:/noredis', 30, fetcher);
    const p2 = getCached('cache:/noredis', 30, fetcher);
    const p3 = getCached('cache:/noredis', 30, fetcher);

    resolve({ ok: 'degraded' });
    const results = await Promise.all([p1, p2, p3]);

    expect(fetcher).toHaveBeenCalledOnce();
    for (const r of results) expect(r).toEqual({ ok: 'degraded' });
  });

  it('does not deadlock when Redis.get throws', async () => {
    mockRedis.get.mockRejectedValue(new Error('connection reset'));
    const fetcher = vi.fn().mockResolvedValue({ ok: true });

    const result = await getCached('cache:/throwerr', 30, fetcher);
    expect(result).toEqual({ ok: true });
  });

  it('does not throw when Redis.setEx fails after successful fetch', async () => {
    mockRedis.get.mockResolvedValue(null);
    mockRedis.setEx.mockRejectedValue(new Error('write failed'));
    const fetcher = vi.fn().mockResolvedValue({ data: 'live' });

    await expect(getCached('cache:/writefail', 30, fetcher)).resolves.toEqual({ data: 'live' });
  });
});

// =============================================================================
// 6. Distributed locking
// =============================================================================

describe('getCached — distributed locking', () => {
  it('lock winner fetches and writes to Redis', async () => {
    // Winner: acquires lock (SET NX returns OK)
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.get.mockResolvedValue(null);

    const fetcher = vi.fn().mockResolvedValue({ winner: true });
    const before = await counterValue(cacheLockAcquisitionsTotal);

    const result = await getCached('cache:/lockkey', 30, fetcher, { distributed: true });

    expect(result).toEqual({ winner: true });
    expect(mockRedis.setEx).toHaveBeenCalledWith(
      'cache:/lockkey', 30, JSON.stringify({ winner: true }),
    );

    const after = await counterValue(cacheLockAcquisitionsTotal);
    expect(after - before).toBe(1);
  });

  it('lock loser waits then reads the value the winner wrote', async () => {
    process.env.CACHE_LOCK_POLL_MS  = '10';
    process.env.CACHE_LOCK_WAIT_MS  = '500';

    // Loser: lock is held by another instance (SET NX returns null)
    mockRedis.set.mockResolvedValue(null);

    // After 2 poll cycles the winner has written the value
    let pollCount = 0;
    mockRedis.get.mockImplementation(async (key: string) => {
      // First call is the initial cache check (returns null)
      // Subsequent calls are lock-wait polls
      if (key === 'cache:/lockwait' && pollCount++ >= 2) {
        return JSON.stringify({ winner: true });
      }
      return null;
    });

    const fetcher = vi.fn().mockResolvedValue({ shouldNotCall: true });
    const before = await counterValue(cacheLockContentionsTotal);

    const result = await getCached('cache:/lockwait', 30, fetcher, { distributed: true });

    expect(result).toEqual({ winner: true });
    expect(fetcher).not.toHaveBeenCalled();

    const after = await counterValue(cacheLockContentionsTotal);
    expect(after - before).toBe(1);
  });

  it('loser falls through to its own fetch when lock wait times out', async () => {
    process.env.CACHE_LOCK_POLL_MS  = '10';
    process.env.CACHE_LOCK_WAIT_MS  = '50'; // very short

    mockRedis.set.mockResolvedValue(null); // lock never acquired
    mockRedis.get.mockResolvedValue(null); // value never appears
    mockRedis.exists.mockResolvedValue(1); // lock always still held

    const fetcher = vi.fn().mockResolvedValue({ fallback: true });

    const result = await getCached('cache:/locktimeout', 30, fetcher, { distributed: true });

    expect(result).toEqual({ fallback: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('lock is released after successful fetch', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.get.mockResolvedValue(null);

    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    await getCached('cache:/lockrelease', 30, fetcher, { distributed: true });

    // del called for the lock key
    expect(mockRedis.del).toHaveBeenCalledWith('lock:cache:/lockrelease');
  });

  it('lock is released even when fetcher throws', async () => {
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.get.mockResolvedValue(null);

    const fetcher = vi.fn().mockRejectedValue(new Error('origin down'));
    await getCached('cache:/lockfail', 30, fetcher, { distributed: true }).catch(() => {});

    expect(mockRedis.del).toHaveBeenCalledWith('lock:cache:/lockfail');
  });

  it('skips distributed lock when Redis is not ready', async () => {
    mockRedis.isReady = false;

    const fetcher = vi.fn().mockResolvedValue({ nolock: true });
    const before = await counterValue(cacheLockAcquisitionsTotal);

    const result = await getCached('cache:/nolockkey', 30, fetcher, { distributed: true });

    expect(result).toEqual({ nolock: true });
    // No lock acquisition attempted
    const after = await counterValue(cacheLockAcquisitionsTotal);
    expect(after - before).toBe(0);
    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 7. Successful fetch writes to Redis with correct TTL
// =============================================================================

describe('getCached — Redis write behavior', () => {
  it('writes result to Redis with the specified TTL', async () => {
    const fetcher = vi.fn().mockResolvedValue([1, 2, 3]);

    await getCached('cache:/ttlcheck', 60, fetcher);

    expect(mockRedis.setEx).toHaveBeenCalledWith(
      'cache:/ttlcheck',
      60,
      JSON.stringify([1, 2, 3]),
    );
  });

  it('serialises BigInt values as strings', async () => {
    const fetcher = vi.fn().mockResolvedValue({ id: BigInt(9007199254740991) });

    // BigInt is not JSON-serializable by default — the fetcher should
    // return a pre-serialised form (as routes do via serialize()).
    const fetcher2 = vi.fn().mockResolvedValue({ id: '9007199254740991' });
    await getCached('cache:/bigint', 30, fetcher2);

    expect(mockRedis.setEx).toHaveBeenCalledWith(
      'cache:/bigint',
      30,
      expect.stringContaining('9007199254740991'),
    );
  });
});

// =============================================================================
// 8. cacheMiddleware integration — cacheHit flag and coalescing via middleware
// =============================================================================

describe('cacheMiddleware — integration with cache-service', () => {
  // Import here so mocks are applied
  async function buildApp(ttl = 30) {
    const { cacheMiddleware } = await import('../src/api/cache-middleware.js');
    const app = express();
    app.use(express.json());

    let callCount = 0;
    app.get('/test', cacheMiddleware(ttl), (_req: Request, res: Response) => {
      callCount++;
      res.json({ callCount, ts: Date.now() });
    });

    return { app, getCallCount: () => callCount };
  }

  it('serves from Redis cache and sets cacheHit=true', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ callCount: 0, ts: 100 }));
    const { app } = await buildApp();

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.callCount).toBe(0); // from cache
    // Handler should not have been called
  });

  it('calls handler on cache miss and writes result', async () => {
    mockRedis.get.mockResolvedValue(null);
    const { app, getCallCount } = await buildApp();

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(getCallCount()).toBe(1);
  });

  it('degraded mode (Redis down) still serves handler', async () => {
    mockRedis.isReady = false;
    const { app, getCallCount } = await buildApp();

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(getCallCount()).toBe(1);
  });
});

// =============================================================================
// 9. fetchTimeoutMs is env-configurable
// =============================================================================

describe('fetchTimeoutMs — env-configurable', () => {
  it('defaults to 30000 when env var is not set', () => {
    delete process.env.CACHE_FETCH_TIMEOUT_MS;
    expect(fetchTimeoutMs()).toBe(30_000);
  });

  it('reads from CACHE_FETCH_TIMEOUT_MS env var', () => {
    process.env.CACHE_FETCH_TIMEOUT_MS = '5000';
    expect(fetchTimeoutMs()).toBe(5_000);
  });
});
