/**
 * query-cost.test.ts
 *
 * Tests for the query cost model (src/api/query-cost.ts).
 *
 * Acceptance criteria:
 *   ✓ Over-budget queries fail before expensive execution (status 400,
 *     code QUERY_TOO_EXPENSIVE, stable error).
 *   ✓ Equivalent cached requests do not incur database cost (cacheHit bypass).
 *   ✓ Limits and costs are documented, observable, and adjustable without
 *     code changes (operator /admin/query-cost endpoint).
 *   ✓ Cost combinations across endpoints: listings, auctions, search, stats,
 *     wallets, royalty breakdown.
 *   ✓ Operator token raises the budget so operators can run expensive queries.
 *   ✓ COST_WEIGHTS are env-overridable; budgets follow env vars.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import {
  estimateCost,
  queryCostGuard,
  COST_WEIGHTS,
  publicBudget,
  operatorBudget,
  QUERY_TOO_EXPENSIVE_CODE,
  QueryTooExpensiveError,
  handleQueryCostDiagnostics,
  type CostOptions,
} from '../src/api/query-cost.js';
import { errorHandler } from '../src/api/errors.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ORIG_ENV: Record<string, string | undefined> = {};
const COST_ENV_KEYS = [
  'QUERY_COST_BUDGET_PUBLIC',
  'QUERY_COST_BUDGET_OPERATOR',
  'QUERY_COST_LARGE_PAGE',
  'QUERY_COST_MEDIUM_PAGE',
  'QUERY_COST_DEEP_OFFSET',
  'QUERY_COST_FTS_SEARCH',
  'QUERY_COST_ILIKE_SEARCH',
  'QUERY_COST_PRICE_RANGE',
  'QUERY_COST_MULTI_FILTER',
  'QUERY_COST_SORT',
  'QUERY_COST_TIME_RANGE',
  'QUERY_COST_JOIN',
  'QUERY_COST_STATS_AGGREGATION',
  'QUERY_COST_CROSS_ENTITY',
];

function saveEnv() {
  for (const k of COST_ENV_KEYS) ORIG_ENV[k] = process.env[k];
}

function restoreEnv() {
  for (const k of COST_ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  }
}

/** Build a minimal Express app with the queryCostGuard under test. */
function makeApp(opts: Parameters<typeof queryCostGuard>[0] = {}) {
  const app = express();
  app.use(express.json());
  app.get('/test', queryCostGuard(opts), (_req: Request, res: Response) => {
    res.json({ ok: true, cost: res.locals.queryCost?.breakdown?.total ?? 0 });
  });
  app.use(errorHandler);
  return app;
}

/** Return a request builder that sets operator token header. */
function withOperatorToken(req: request.Test, token = 'op-token') {
  return req.set('x-operator-token', token);
}

// =============================================================================
// 1. estimateCost — individual components
// =============================================================================

describe('estimateCost — individual cost components', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('zero cost for minimal query (no params)', () => {
    const bd = estimateCost({});
    expect(bd.total).toBe(0);
    expect(bd.components).toHaveLength(0);
  });

  it('adds LARGE_PAGE cost when limit > 100', () => {
    const bd = estimateCost({ limit: 200 });
    expect(bd.total).toBe(COST_WEIGHTS.LARGE_PAGE());
    expect(bd.components[0].reason).toContain('large page');
  });

  it('adds MEDIUM_PAGE cost when limit is 51–100', () => {
    const bd = estimateCost({ limit: 75 });
    expect(bd.total).toBe(COST_WEIGHTS.MEDIUM_PAGE());
    expect(bd.components[0].reason).toContain('medium page');
  });

  it('does NOT add page cost when limit ≤ 50', () => {
    const bd = estimateCost({ limit: 50 });
    expect(bd.total).toBe(0);
  });

  it('adds DEEP_OFFSET cost when offset > 1000', () => {
    const bd = estimateCost({ offset: 5000 });
    expect(bd.total).toBe(COST_WEIGHTS.DEEP_OFFSET());
  });

  it('does NOT add offset cost for offset ≤ 1000', () => {
    const bd = estimateCost({ offset: 1000 });
    expect(bd.total).toBe(0);
  });

  it('adds FTS_SEARCH cost for search terms ≥ 3 chars', () => {
    const bd = estimateCost({ hasSearch: true, isFtsSearch: true });
    expect(bd.total).toBe(COST_WEIGHTS.FTS_SEARCH());
  });

  it('adds ILIKE_SEARCH cost for short search terms (< 3 chars)', () => {
    const bd = estimateCost({ hasSearch: true, isFtsSearch: false });
    expect(bd.total).toBe(COST_WEIGHTS.ILIKE_SEARCH());
  });

  it('adds PRICE_RANGE cost when price filter is active', () => {
    const bd = estimateCost({ hasPriceRange: true });
    expect(bd.total).toBe(COST_WEIGHTS.PRICE_RANGE());
  });

  it('adds MULTI_FILTER cost when 3+ active filters', () => {
    const bd = estimateCost({ activeFilters: 3 });
    expect(bd.total).toBe(COST_WEIGHTS.MULTI_FILTER());
  });

  it('does NOT add MULTI_FILTER for < 3 filters', () => {
    const bd = estimateCost({ activeFilters: 2 });
    expect(bd.total).toBe(0);
  });

  it('adds SORT cost for non-default sort', () => {
    const bd = estimateCost({ hasSort: true });
    expect(bd.total).toBe(COST_WEIGHTS.SORT());
  });

  it('adds TIME_RANGE cost for from/to params', () => {
    const bd = estimateCost({ hasTimeRange: true });
    expect(bd.total).toBe(COST_WEIGHTS.TIME_RANGE());
  });

  it('adds JOIN cost for implicit join endpoints', () => {
    const bd = estimateCost({ hasJoin: true });
    expect(bd.total).toBe(COST_WEIGHTS.JOIN());
  });

  it('adds STATS_AGGREGATION cost for aggregation endpoints', () => {
    const bd = estimateCost({ isAggregation: true });
    expect(bd.total).toBe(COST_WEIGHTS.STATS_AGGREGATION());
  });

  it('adds CROSS_ENTITY cost per extra entity type beyond 1', () => {
    const bd = estimateCost({ entityTypeCount: 3 });
    expect(bd.total).toBe(COST_WEIGHTS.CROSS_ENTITY() * 2);
  });

  it('does NOT add CROSS_ENTITY cost for a single entity type', () => {
    const bd = estimateCost({ entityTypeCount: 1 });
    expect(bd.total).toBe(0);
  });
});

// =============================================================================
// 2. estimateCost — combined scenarios
// =============================================================================

describe('estimateCost — combined query patterns', () => {
  it('deep-paginated FTS search with price filter exceeds budget', () => {
    const bd = estimateCost({
      limit:        200,  // +20 LARGE_PAGE
      offset:       5000, // +15 DEEP_OFFSET
      hasSearch:    true,
      isFtsSearch:  true, // +25 FTS
      hasPriceRange:true, // +5  PRICE_RANGE
      activeFilters:3,    // +5  MULTI_FILTER
    });
    // 20 + 15 + 25 + 5 + 5 = 70
    expect(bd.total).toBe(70);
    expect(bd.total).toBeGreaterThan(publicBudget()); // 60
  });

  it('simple listing query stays within public budget', () => {
    const bd = estimateCost({ limit: 20 }); // 0 cost
    expect(bd.total).toBe(0);
    expect(bd.total).toBeLessThanOrEqual(publicBudget());
  });

  it('stats with time range hits aggregation + time cost', () => {
    const bd = estimateCost({ isAggregation: true, hasTimeRange: true });
    expect(bd.total).toBe(
      COST_WEIGHTS.STATS_AGGREGATION() + COST_WEIGHTS.TIME_RANGE()
    );
  });

  it('cross-entity search for all 3 types is expensive', () => {
    const bd = estimateCost({
      entityTypeCount: 3,  // +30
      hasSearch: true,
      isFtsSearch: true,   // +25
      limit: 50,           // 0
    });
    expect(bd.total).toBe(
      COST_WEIGHTS.CROSS_ENTITY() * 2 + COST_WEIGHTS.FTS_SEARCH()
    );
  });

  it('breakdown lists all contributing components', () => {
    const bd = estimateCost({
      limit:        150,
      offset:       2000,
      hasSearch:    true,
      isFtsSearch:  true,
      hasTimeRange: true,
      hasJoin:      true,
      isAggregation:true,
    });
    const reasons = bd.components.map((c) => c.reason);
    expect(reasons.some((r) => r.includes('large page'))).toBe(true);
    expect(reasons.some((r) => r.includes('deep pagination'))).toBe(true);
    expect(reasons.some((r) => r.includes('full-text search'))).toBe(true);
    expect(reasons.some((r) => r.includes('time-range'))).toBe(true);
    expect(reasons.some((r) => r.includes('JOIN'))).toBe(true);
    expect(reasons.some((r) => r.includes('aggregation'))).toBe(true);
    expect(bd.total).toBeGreaterThan(0);
  });
});

// =============================================================================
// 3. queryCostGuard middleware — HTTP-level enforcement
// =============================================================================

describe('queryCostGuard — HTTP rejection before DB access', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('allows a cheap query (limit=20, no extras)', async () => {
    const app = makeApp();
    const res = await request(app).get('/test?limit=20');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects an over-budget query with status 400', async () => {
    // Force tiny budget so we can trigger the guard without huge params
    process.env.QUERY_COST_BUDGET_PUBLIC = '5';

    const app = makeApp();
    // limit=200 → LARGE_PAGE (20) > budget (5)
    const res = await request(app).get('/test?limit=200');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(QUERY_TOO_EXPENSIVE_CODE);
  });

  it('error response includes estimatedCost, budget, and breakdown', async () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '5';
    const app = makeApp();
    const res = await request(app).get('/test?limit=200');
    expect(res.status).toBe(400);
    expect(res.body.error.details?.estimatedCost).toBeGreaterThan(5);
    expect(res.body.error.details?.budget).toBe(5);
    expect(Array.isArray(res.body.error.details?.breakdown?.components)).toBe(true);
  });

  it('error code is the stable string QUERY_TOO_EXPENSIVE', async () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '1';
    const app = makeApp();
    const res = await request(app).get('/test?limit=200');
    expect(res.body.error.code).toBe('QUERY_TOO_EXPENSIVE');
  });

  it('attaches queryCost to res.locals for observability on allowed requests', async () => {
    let capturedCost: any;
    const app = express();
    app.use(express.json());
    app.get('/test', queryCostGuard(), (_req: Request, res: Response) => {
      capturedCost = res.locals.queryCost;
      res.json({ ok: true });
    });

    await request(app).get('/test?limit=20');
    expect(capturedCost).toBeDefined();
    expect(capturedCost.breakdown).toBeDefined();
    expect(capturedCost.budget).toBe(publicBudget());
  });
});

// =============================================================================
// 4. Cache hit bypass
// =============================================================================

describe('queryCostGuard — cached responses skip cost enforcement', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('bypasses the cost guard when res.locals.cacheHit is true', async () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '1'; // tiny budget

    // Middleware that sets cacheHit before the guard
    const simulateCacheHit = (_req: Request, res: Response, next: NextFunction) => {
      res.locals.cacheHit = true;
      next();
    };

    const app = express();
    app.use(express.json());
    app.get('/test', simulateCacheHit, queryCostGuard(), (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    // Even with limit=1000 the guard should not fire
    const res = await request(app).get('/test?limit=1000');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('enforces cost when cacheHit is false', async () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '1';

    const simulateNoCacheHit = (_req: Request, res: Response, next: NextFunction) => {
      res.locals.cacheHit = false;
      next();
    };

    const app = express();
    app.use(express.json());
    app.get('/test', simulateNoCacheHit, queryCostGuard(), (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).get('/test?limit=1000');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(QUERY_TOO_EXPENSIVE_CODE);
  });
});

// =============================================================================
// 5. Operator budget elevation
// =============================================================================

describe('queryCostGuard — operator token raises budget', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('operator budget is higher than public budget by default', () => {
    expect(operatorBudget()).toBeGreaterThan(publicBudget());
  });

  it('operator can run queries that exceed the public budget', async () => {
    // Public budget = 60 (default), operator budget = 200
    // limit=200 → LARGE_PAGE (20) which is under operator budget
    const app = makeApp();
    const res = await withOperatorToken(
      request(app).get('/test?limit=200'),
      'op-token',
    );
    // 20 < 200 → allowed
    expect(res.status).toBe(200);
    expect(res.body.cost).toBe(COST_WEIGHTS.LARGE_PAGE());
  });

  it('isOperator=true is detected from X-Operator-Token header', async () => {
    let capturedCost: any;
    const app = express();
    app.use(express.json());
    app.get('/test', queryCostGuard(), (_req: Request, res: Response) => {
      capturedCost = res.locals.queryCost;
      res.json({ ok: true });
    });

    await request(app).get('/test').set('x-operator-token', 'any-token');
    expect(capturedCost.isOperator).toBe(true);
    expect(capturedCost.budget).toBe(operatorBudget());
  });

  it('isOperator=false for requests without operator token', async () => {
    let capturedCost: any;
    const app = express();
    app.use(express.json());
    app.get('/test', queryCostGuard(), (_req: Request, res: Response) => {
      capturedCost = res.locals.queryCost;
      res.json({ ok: true });
    });

    await request(app).get('/test');
    expect(capturedCost.isOperator).toBe(false);
    expect(capturedCost.budget).toBe(publicBudget());
  });

  it('operator via ?operator_token= query param also raises budget', async () => {
    let capturedCost: any;
    const app = express();
    app.use(express.json());
    app.get('/test', queryCostGuard(), (_req: Request, res: Response) => {
      capturedCost = res.locals.queryCost;
      res.json({ ok: true });
    });

    await request(app).get('/test?operator_token=any-token');
    expect(capturedCost.isOperator).toBe(true);
  });
});

// =============================================================================
// 6. Env-configurable weights and budgets
// =============================================================================

describe('COST_WEIGHTS — env-overridable without code changes', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('QUERY_COST_LARGE_PAGE overrides large-page weight', () => {
    process.env.QUERY_COST_LARGE_PAGE = '50';
    expect(COST_WEIGHTS.LARGE_PAGE()).toBe(50);
  });

  it('QUERY_COST_FTS_SEARCH overrides FTS weight', () => {
    process.env.QUERY_COST_FTS_SEARCH = '100';
    expect(COST_WEIGHTS.FTS_SEARCH()).toBe(100);
  });

  it('QUERY_COST_BUDGET_PUBLIC overrides public budget', () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '30';
    expect(publicBudget()).toBe(30);
  });

  it('QUERY_COST_BUDGET_OPERATOR overrides operator budget', () => {
    process.env.QUERY_COST_BUDGET_OPERATOR = '500';
    expect(operatorBudget()).toBe(500);
  });

  it('custom budget prevents a query that would be allowed by default', async () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '5';
    process.env.QUERY_COST_MEDIUM_PAGE = '10'; // limit=75 = 10 > 5

    const app = makeApp();
    const res = await request(app).get('/test?limit=75');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(QUERY_TOO_EXPENSIVE_CODE);
  });

  it('increasing the budget allows a previously-rejected query', async () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '100';

    const app = makeApp();
    // limit=200 → LARGE_PAGE (20) < budget (100)
    const res = await request(app).get('/test?limit=200');
    expect(res.status).toBe(200);
  });
});

// =============================================================================
// 7. Endpoint-specific cost guards via extraOpts and flags
// =============================================================================

describe('queryCostGuard — hasJoin and isAggregation flags', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('hasJoin=true adds JOIN cost even without query params', async () => {
    let capturedCost: any;
    const app = express();
    app.use(express.json());
    app.get('/test', queryCostGuard({ hasJoin: true }), (_req: Request, res: Response) => {
      capturedCost = res.locals.queryCost;
      res.json({ ok: true });
    });

    await request(app).get('/test');
    expect(capturedCost.breakdown.total).toBe(COST_WEIGHTS.JOIN());
  });

  it('isAggregation=true adds STATS_AGGREGATION cost automatically', async () => {
    let capturedCost: any;
    const app = express();
    app.use(express.json());
    app.get('/test', queryCostGuard({ isAggregation: true }), (_req: Request, res: Response) => {
      capturedCost = res.locals.queryCost;
      res.json({ ok: true });
    });

    await request(app).get('/test');
    expect(capturedCost.breakdown.total).toBe(COST_WEIGHTS.STATS_AGGREGATION());
  });

  it('aggregation + time range is still within public budget by default', () => {
    // 20 + 10 = 30 < 60 (public budget)
    const bd = estimateCost({ isAggregation: true, hasTimeRange: true });
    expect(bd.total).toBeLessThanOrEqual(publicBudget());
  });

  it('aggregation + time range + large page exceeds public budget', () => {
    // 20 + 10 + 20 = 50 < 60 — just under; add FTS (25) to push over
    const bd = estimateCost({
      isAggregation: true,
      hasTimeRange: true,
      limit: 200,           // +20
      hasSearch: true,
      isFtsSearch: true,    // +25  → total = 75 > 60
    });
    expect(bd.total).toBeGreaterThan(publicBudget());
  });
});

// =============================================================================
// 8. Cross-entity search cost detection from req.query.types
// =============================================================================

describe('queryCostGuard — types param entity count detection', () => {
  it('detects 1 entity type (no cross-entity cost)', async () => {
    let capturedCost: any;
    const app = express();
    app.use(express.json());
    app.get('/test', queryCostGuard(), (_req: Request, res: Response) => {
      capturedCost = res.locals.queryCost;
      res.json({ ok: true });
    });

    await request(app).get('/test?types=listings');
    // 1 type → no cross-entity cost
    expect(capturedCost.breakdown.components.some((c: any) => c.reason.includes('cross-entity'))).toBe(false);
  });

  it('detects 3 entity types (adds cross-entity cost × 2)', async () => {
    let capturedCost: any;
    const app = express();
    app.use(express.json());
    app.get('/test', queryCostGuard(), (_req: Request, res: Response) => {
      capturedCost = res.locals.queryCost;
      res.json({ ok: true });
    });

    await request(app).get('/test?types=listings,auctions,collections');
    const crossEntityComponents = capturedCost.breakdown.components.filter(
      (c: any) => c.reason.includes('cross-entity')
    );
    expect(crossEntityComponents).toHaveLength(1);
    expect(crossEntityComponents[0].cost).toBe(COST_WEIGHTS.CROSS_ENTITY() * 2);
  });
});

// =============================================================================
// 9. QueryTooExpensiveError class
// =============================================================================

describe('QueryTooExpensiveError', () => {
  it('is an instance of Error', () => {
    const err = new QueryTooExpensiveError(70, 60, { components: [], total: 70 });
    expect(err).toBeInstanceOf(Error);
  });

  it('has correct code, statusCode, and message', () => {
    const err = new QueryTooExpensiveError(70, 60, { components: [], total: 70 });
    expect((err as any).code).toBe(QUERY_TOO_EXPENSIVE_CODE);
    expect((err as any).statusCode).toBe(400);
    expect(err.message).toContain('70');
    expect(err.message).toContain('60');
  });

  it('surfaces estimatedCost and budget in details', () => {
    const bd = { components: [{ reason: 'large page', cost: 20 }], total: 70 };
    const err = new QueryTooExpensiveError(70, 60, bd);
    expect((err as any).details?.estimatedCost).toBe(70);
    expect((err as any).details?.budget).toBe(60);
    expect((err as any).details?.breakdown).toBe(bd);
  });
});

// =============================================================================
// 10. /admin/query-cost diagnostics endpoint
// =============================================================================

describe('handleQueryCostDiagnostics — operator diagnostics', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  it('returns weights, budgets, and envVars', async () => {
    const app = express();
    app.use(express.json());
    app.get('/admin/query-cost', handleQueryCostDiagnostics);

    const res = await request(app).get('/admin/query-cost');
    expect(res.status).toBe(200);
    expect(res.body.weights).toBeDefined();
    expect(res.body.budgets).toBeDefined();
    expect(res.body.budgets.public).toBe(publicBudget());
    expect(res.body.budgets.operator).toBe(operatorBudget());
    expect(res.body.envVars).toBeDefined();
  });

  it('reflects env-overridden budget in the response', async () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '42';

    const app = express();
    app.use(express.json());
    app.get('/admin/query-cost', handleQueryCostDiagnostics);

    const res = await request(app).get('/admin/query-cost');
    expect(res.body.budgets.public).toBe(42);
  });

  it('exposes all weight keys', async () => {
    const app = express();
    app.use(express.json());
    app.get('/admin/query-cost', handleQueryCostDiagnostics);

    const res = await request(app).get('/admin/query-cost');
    const expectedKeys = [
      'LARGE_PAGE', 'MEDIUM_PAGE', 'DEEP_OFFSET', 'FTS_SEARCH',
      'ILIKE_SEARCH', 'PRICE_RANGE', 'MULTI_FILTER', 'SORT',
      'TIME_RANGE', 'JOIN', 'STATS_AGGREGATION', 'CROSS_ENTITY',
    ];
    for (const key of expectedKeys) {
      expect(res.body.weights[key], `Missing weight: ${key}`).toBeDefined();
    }
  });

  it('does not expose internal DB schema or execution plans', async () => {
    const app = express();
    app.use(express.json());
    app.get('/admin/query-cost', handleQueryCostDiagnostics);

    const res = await request(app).get('/admin/query-cost');
    const body = JSON.stringify(res.body);
    // Should not contain anything that looks like a DB query plan
    expect(body).not.toContain('EXPLAIN');
    expect(body).not.toContain('seq_scan');
    expect(body).not.toContain('index_scan');
    expect(body).not.toContain('DATABASE_URL');
  });

  it('weights in response are numeric', async () => {
    const app = express();
    app.use(express.json());
    app.get('/admin/query-cost', handleQueryCostDiagnostics);

    const res = await request(app).get('/admin/query-cost');
    for (const [key, val] of Object.entries(res.body.weights)) {
      expect(typeof val, `Weight ${key} should be a number`).toBe('number');
    }
  });
});

// =============================================================================
// 11. Integration: cost guard wired into routes via full app
// =============================================================================

describe('queryCostGuard — wired into routes', () => {
  const mockPrisma = vi.hoisted(() => ({
    listing: {
      findMany: vi.fn().mockResolvedValue([]),
      count:    vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { price: null } }),
    },
    auction: { findMany: vi.fn().mockResolvedValue([]) },
    offer:   { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    collection: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    marketplaceEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      count:    vi.fn().mockResolvedValue(0),
    },
    bid: { findMany: vi.fn().mockResolvedValue([]) },
    whitelistedToken: { findMany: vi.fn().mockResolvedValue([]) },
    trackedContract:  { findMany: vi.fn().mockResolvedValue([]) },
    royaltyPayment:   { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    ledgerGap:        { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    backfillJob:      { findMany: vi.fn().mockResolvedValue([]) },
  }));

  const mockRedis = vi.hoisted(() => ({
    isOpen: false, isReady: false,
    get:    vi.fn().mockResolvedValue(null),
    setEx:  vi.fn().mockResolvedValue(undefined),
    on:     vi.fn(),
    connect: vi.fn().mockRejectedValue(new Error('No Redis')),
  }));

  vi.mock('../src/db', () => ({ default: mockPrisma }));
  vi.mock('../src/prisma-write', () => ({ default: mockPrisma }));
  vi.mock('../src/redis.js', () => ({ default: mockRedis }));

  beforeEach(() => {
    vi.clearAllMocks();
    saveEnv();
  });
  afterEach(restoreEnv);

  it('GET /listings with limit=20 passes through (cheap query)', async () => {
    const { default: router } = await import('../src/api/routes.js');
    const { errorHandler } = await import('../src/api/errors.js');
    const app = express();
    app.use(express.json());
    app.use(router);
    app.use(errorHandler);

    const res = await request(app).get('/listings?limit=20');
    expect(res.status).toBe(200);
    expect(mockPrisma.listing.findMany).toHaveBeenCalled();
  });

  it('GET /listings with limit=200 and a search term triggers cost guard (exceeds public budget)', async () => {
    // limit=200 (20) + FTS (25) = 45, still under 60 — add offset to push over
    // offset=5000 (+15) → 20 + 25 + 15 = 60 (at budget boundary, ≤ passes)
    // Add price range (+5) → 65 > 60
    process.env.QUERY_COST_BUDGET_PUBLIC = '50';

    const { default: router } = await import('../src/api/routes.js');
    const { errorHandler } = await import('../src/api/errors.js');
    const app = express();
    app.use(express.json());
    app.use(router);
    app.use(errorHandler);

    // limit=200 → LARGE_PAGE (20) > budget (50)? No, 20 < 50.
    // Add search → 20 + 25 = 45 < 50. Add offset=5000 → 60 > 50.
    const res = await request(app).get('/listings?limit=200&search=nft&offset=5000');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(QUERY_TOO_EXPENSIVE_CODE);
    // Prisma should NOT have been called
    expect(mockPrisma.listing.findMany).not.toHaveBeenCalled();
  });

  it('operator token bypasses public budget on /listings', async () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '5';
    process.env.QUERY_COST_BUDGET_OPERATOR = '200';

    const { default: router } = await import('../src/api/routes.js');
    const { errorHandler } = await import('../src/api/errors.js');
    const app = express();
    app.use(express.json());
    app.use(router);
    app.use(errorHandler);

    // limit=200 → 20 < operator budget (200)
    const res = await request(app)
      .get('/listings?limit=200')
      .set('x-operator-token', 'any');
    expect(res.status).toBe(200);
    expect(mockPrisma.listing.findMany).toHaveBeenCalled();
  });
});
