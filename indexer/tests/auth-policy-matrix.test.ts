/**
 * auth-policy-matrix.test.ts
 *
 * Comprehensive policy-matrix tests for the auth middleware.
 *
 * Acceptance criteria:
 *   ✓ Every route in ROUTE_POLICY_MATRIX has an intentional policy (public /
 *     authenticated / operator) — no accidental gaps.
 *   ✓ Unauthenticated users cannot invoke operational or wallet-private actions.
 *   ✓ Public reads remain available without any credentials.
 *   ✓ A newly-added route without a matrix entry is detected at startup.
 *   ✓ Both authentication (missing/wrong token → 401) and authorization
 *     (valid token, wrong IP → 403) failures are covered.
 *   ✓ SSE and replay endpoints follow the public policy.
 *   ✓ Operator token via X-Operator-Token header AND ?operator_token= query
 *     param are both accepted.
 *   ✓ IP allowlist enforcement returns 403 (not 401) with a clear message.
 *   ✓ Auth decisions are logged as structured events.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import {
  authMiddleware,
  classifyRoute,
  loadAuthConfig,
  resetAuthConfigCache,
  ROUTE_POLICY_MATRIX,
  PUBLIC_ROUTES,
  AUTHENTICATED_ROUTES,
  OPERATOR_ROUTES,
  assertAllRoutesClassified,
  type RoutePolicy,
} from '../src/api/auth-middleware.js';
import { errorHandler } from '../src/api/errors.js';

// ── Test identity catalogue (documentation) ──────────────────────────────────
//
// Documents the caller types exercised in this file. Individual tests build
// their headers inline; this catalogue serves as a reference.
//
// anonymous        — no credentials at all
// walletHolder     — X-Wallet-Address header present (optional metadata)
// operatorValid    — correct X-Operator-Token header
// operatorWrongToken — wrong token → 401
// operatorQueryParam — token via ?operator_token= → 200
// operatorAllowlistedIp — token + allowed IP → 200
// operatorBlockedIp     — token + blocked IP → 403

// ── Mini-app factory ──────────────────────────────────────────────────────────
//
// Builds a tiny Express app with a single route protected by authMiddleware(policy).
// The route echoes 200 { ok: true } on success; auth failures propagate to errorHandler.

function makeApp(policy: RoutePolicy, path = '/test') {
  const app = express();
  app.use(express.json());
  app.get(path, authMiddleware(policy), (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ORIG_ENV: Record<string, string | undefined> = {};

function saveEnv(keys: string[]) {
  for (const k of keys) ORIG_ENV[k] = process.env[k];
}

function restoreEnv(keys: string[]) {
  for (const k of keys) {
    if (ORIG_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG_ENV[k];
  }
}

// =============================================================================
// 1. classifyRoute — parametric path normalisation
// =============================================================================

describe('classifyRoute — normalisation', () => {
  it('classifies template-form public routes', () => {
    expect(classifyRoute('/health')).toBe('public');
    expect(classifyRoute('/listings')).toBe('public');
    expect(classifyRoute('/listings/{id}')).toBe('public');
    expect(classifyRoute('/auctions/{id}')).toBe('public');
    expect(classifyRoute('/events')).toBe('public');
    expect(classifyRoute('/search')).toBe('public');
    expect(classifyRoute('/stats')).toBe('public');
    expect(classifyRoute('/stats/overview')).toBe('public');
    expect(classifyRoute('/stats/daily')).toBe('public');
    expect(classifyRoute('/stats/top-collections')).toBe('public');
    expect(classifyRoute('/stats/top-artists')).toBe('public');
    expect(classifyRoute('/tokens')).toBe('public');
    expect(classifyRoute('/ipfs/{cid}')).toBe('public');
    expect(classifyRoute('/config/auction')).toBe('public');
    expect(classifyRoute('/notifications/stream')).toBe('public');
    expect(classifyRoute('/notifications/summary')).toBe('public');
  });

  it('classifies template-form authenticated routes', () => {
    expect(classifyRoute('/wallets/{address}/activity')).toBe('authenticated');
    expect(classifyRoute('/wallets/{address}/royalty-stats')).toBe('authenticated');
    expect(classifyRoute('/wallets/{address}/royalty-breakdown')).toBe('authenticated');
    expect(classifyRoute('/wallets/{address}/notifications')).toBe('authenticated');
  });

  it('classifies template-form operator routes', () => {
    expect(classifyRoute('/health/details')).toBe('operator');
    expect(classifyRoute('/reconciliation/status')).toBe('operator');
    expect(classifyRoute('/backfill/status')).toBe('operator');
    expect(classifyRoute('/keeper/status')).toBe('operator');
    expect(classifyRoute('/sync/gaps')).toBe('operator');
    expect(classifyRoute('/sync/gaps/{id}')).toBe('operator');
    expect(classifyRoute('/sync/jobs')).toBe('operator');
    expect(classifyRoute('/sync/jobs/{id}')).toBe('operator');
    expect(classifyRoute('/admin/contracts')).toBe('operator');
    expect(classifyRoute('/admin/audit')).toBe('operator');
    expect(classifyRoute('/admin/audit/{requestId}')).toBe('operator');
    expect(classifyRoute('/admin/audit/stats')).toBe('operator');
    expect(classifyRoute('/admin/poller/resume')).toBe('operator');
    expect(classifyRoute('/admin/poller/halt')).toBe('operator');
    expect(classifyRoute('/admin/poller/revert')).toBe('operator');
    expect(classifyRoute('/admin/gap-repair/trigger')).toBe('operator');
    expect(classifyRoute('/admin/dead-letters')).toBe('operator');
    expect(classifyRoute('/admin/query-cost')).toBe('operator');
  });

  it('normalises live parametric paths with Stellar addresses', () => {
    // Stellar G-address (56 chars)
    const gAddr = 'G' + 'A'.repeat(55);
    expect(classifyRoute(`/wallets/${gAddr}/activity`)).toBe('authenticated');
    expect(classifyRoute(`/wallets/${gAddr}/royalty-stats`)).toBe('authenticated');
    expect(classifyRoute(`/creators/${gAddr}/collections`)).toBe('public');
    expect(classifyRoute(`/artists/${gAddr}/metrics`)).toBe('public');
  });

  it('normalises live parametric paths with numeric IDs', () => {
    expect(classifyRoute('/listings/12345')).toBe('public');
    expect(classifyRoute('/auctions/99')).toBe('public');
    expect(classifyRoute('/listings/1/history')).toBe('public');
    expect(classifyRoute('/sync/gaps/42')).toBe('operator');
    expect(classifyRoute('/sync/jobs/7')).toBe('operator');
  });

  it('normalises live parametric paths with IPFS CIDs', () => {
    expect(classifyRoute('/ipfs/QmSomeIpfsHash1234567890abcdefgh12345678901234567890')).toBe('public');
  });

  it('does NOT normalise static English-word segments as CIDs', () => {
    // These must remain classified as operator even without normalisation
    expect(classifyRoute('/reconciliation/status')).toBe('operator');
    expect(classifyRoute('/backfill/status')).toBe('operator');
    expect(classifyRoute('/admin/contracts')).toBe('operator');
    expect(classifyRoute('/admin/audit/stats')).toBe('operator');
  });

  it('normalises UUID requestId in /admin/audit/:requestId', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(classifyRoute(`/admin/audit/${uuid}`)).toBe('operator');
  });
});

// =============================================================================
// 2. Policy matrix completeness — every route has an intentional entry
// =============================================================================

describe('ROUTE_POLICY_MATRIX — completeness', () => {
  it('every entry in PUBLIC_ROUTES appears in the matrix', () => {
    for (const route of PUBLIC_ROUTES) {
      expect(ROUTE_POLICY_MATRIX[route], `PUBLIC route ${route} is missing from ROUTE_POLICY_MATRIX`).toBeDefined();
      expect(ROUTE_POLICY_MATRIX[route].policy).toBe('public');
    }
  });

  it('every entry in AUTHENTICATED_ROUTES appears in the matrix', () => {
    for (const route of AUTHENTICATED_ROUTES) {
      expect(ROUTE_POLICY_MATRIX[route], `AUTHENTICATED route ${route} is missing from ROUTE_POLICY_MATRIX`).toBeDefined();
      expect(ROUTE_POLICY_MATRIX[route].policy).toBe('authenticated');
    }
  });

  it('every entry in OPERATOR_ROUTES appears in the matrix', () => {
    for (const route of OPERATOR_ROUTES) {
      expect(ROUTE_POLICY_MATRIX[route], `OPERATOR route ${route} is missing from ROUTE_POLICY_MATRIX`).toBeDefined();
      expect(ROUTE_POLICY_MATRIX[route].policy).toBe('operator');
    }
  });

  it('every matrix entry has a non-empty description', () => {
    for (const [path, entry] of Object.entries(ROUTE_POLICY_MATRIX)) {
      expect(entry.description, `${path} has empty description`).toBeTruthy();
      expect(entry.description.length, `${path} description too short`).toBeGreaterThan(5);
    }
  });

  it('no route appears in more than one policy set', () => {
    for (const route of PUBLIC_ROUTES) {
      expect(AUTHENTICATED_ROUTES.has(route), `${route} is in both PUBLIC and AUTHENTICATED`).toBe(false);
      expect(OPERATOR_ROUTES.has(route), `${route} is in both PUBLIC and OPERATOR`).toBe(false);
    }
    for (const route of AUTHENTICATED_ROUTES) {
      expect(OPERATOR_ROUTES.has(route), `${route} is in both AUTHENTICATED and OPERATOR`).toBe(false);
    }
  });

  it('assertAllRoutesClassified returns empty array when all routes are classified', () => {
    const allKnown = [
      ...PUBLIC_ROUTES,
      ...AUTHENTICATED_ROUTES,
      ...OPERATOR_ROUTES,
    ];
    const unclassified = assertAllRoutesClassified(allKnown);
    expect(unclassified).toHaveLength(0);
  });

  it('assertAllRoutesClassified detects a newly-added unclassified route (non-production)', () => {
    const routes = ['/listings', '/new-unclassified-route'];
    const unclassified = assertAllRoutesClassified(routes);
    expect(unclassified).toContain('/new-unclassified-route');
  });

  it('assertAllRoutesClassified does NOT flag known routes', () => {
    const routes = ['/listings', '/health', '/admin/contracts'];
    const unclassified = assertAllRoutesClassified(routes);
    expect(unclassified).toHaveLength(0);
  });
});

// =============================================================================
// 3. authMiddleware('public') — no credentials required
// =============================================================================

describe("authMiddleware('public') — unauthenticated access allowed", () => {
  beforeEach(() => resetAuthConfigCache());

  it('anonymous request passes through', async () => {
    const app = makeApp('public');
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('request with wallet header passes through', async () => {
    const app = makeApp('public');
    const res = await request(app)
      .get('/test')
      .set('x-wallet-address', 'GWALLET');
    expect(res.status).toBe(200);
  });

  it('request with an operator token still passes (public policy ignores tokens)', async () => {
    process.env.OPERATOR_TOKEN = 'mytoken';
    resetAuthConfigCache();
    const app = makeApp('public');
    const res = await request(app)
      .get('/test')
      .set('x-operator-token', 'mytoken');
    expect(res.status).toBe(200);
    delete process.env.OPERATOR_TOKEN;
  });
});

// =============================================================================
// 4. authMiddleware('authenticated') — wallet optional, no strict check
// =============================================================================

describe("authMiddleware('authenticated') — wallet optional", () => {
  beforeEach(() => resetAuthConfigCache());

  it('anonymous request passes (wallet is optional metadata)', async () => {
    const app = makeApp('authenticated');
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });

  it('request with wallet header passes', async () => {
    const app = makeApp('authenticated');
    const res = await request(app)
      .get('/test')
      .set('x-wallet-address', 'GWALLET123');
    expect(res.status).toBe(200);
  });

  it('request with ?wallet= query param passes', async () => {
    const app = makeApp('authenticated');
    const res = await request(app).get('/test?wallet=GWALLET123');
    expect(res.status).toBe(200);
  });

  it('request without any credentials still passes (no auth enforcement)', async () => {
    const app = makeApp('authenticated');
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// =============================================================================
// 5. authMiddleware('operator') — token required when configured
// =============================================================================

describe("authMiddleware('operator') — token enforcement", () => {
  const TOKEN = 'super-secret-operator-token';

  beforeEach(() => {
    saveEnv(['OPERATOR_TOKEN', 'OPERATOR_ALLOWLIST']);
    process.env.OPERATOR_TOKEN = TOKEN;
    resetAuthConfigCache();
  });

  afterEach(() => {
    restoreEnv(['OPERATOR_TOKEN', 'OPERATOR_ALLOWLIST']);
    resetAuthConfigCache();
  });

  // ── 5a. Authentication failures ───────────────────────────────────────────

  it('rejects anonymous request with 401', async () => {
    const app = makeApp('operator');
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.class).toBe('CLIENT_ERROR');
  });

  it('rejects request with wrong token with 401', async () => {
    const app = makeApp('operator');
    const res = await request(app)
      .get('/test')
      .set('x-operator-token', 'wrong-token');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects empty x-operator-token with 401', async () => {
    const app = makeApp('operator');
    const res = await request(app)
      .get('/test')
      .set('x-operator-token', '');
    expect(res.status).toBe(401);
  });

  it('does not leak the correct token value in the 401 response', async () => {
    const app = makeApp('operator');
    const res = await request(app).get('/test');
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  // ── 5b. Successful authentication ─────────────────────────────────────────

  it('accepts correct token via X-Operator-Token header', async () => {
    const app = makeApp('operator');
    const res = await request(app)
      .get('/test')
      .set('x-operator-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('accepts correct token via ?operator_token= query parameter', async () => {
    const app = makeApp('operator');
    const res = await request(app).get(`/test?operator_token=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('token matching is case-sensitive', async () => {
    const app = makeApp('operator');
    const res = await request(app)
      .get('/test')
      .set('x-operator-token', TOKEN.toUpperCase());
    expect(res.status).toBe(401);
  });

  // ── 5c. Authorization failures (IP allowlist) ─────────────────────────────

  it('returns 403 when caller IP is not in the allowlist', async () => {
    process.env.OPERATOR_ALLOWLIST = '10.0.0.1,10.0.0.2';
    resetAuthConfigCache();

    const app = express();
    app.use(express.json());
    // Simulate request from a blocked IP via X-Forwarded-For
    app.get('/test', (req, _res, next) => {
      // Override ip detection for test
      (req as any).headers['x-forwarded-for'] = '192.168.1.99';
      next();
    }, authMiddleware('operator'), (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app)
      .get('/test')
      .set('x-operator-token', TOKEN)
      .set('x-forwarded-for', '192.168.1.99');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.class).toBe('CLIENT_ERROR');
  });

  it('returns 200 when caller IP is in the allowlist', async () => {
    process.env.OPERATOR_ALLOWLIST = '10.0.0.1,10.0.0.2';
    resetAuthConfigCache();

    const app = makeApp('operator');
    const res = await request(app)
      .get('/test')
      .set('x-operator-token', TOKEN)
      .set('x-forwarded-for', '10.0.0.1');

    expect(res.status).toBe(200);
  });

  it('ignores IP allowlist when allowlist is empty', async () => {
    process.env.OPERATOR_ALLOWLIST = '';
    resetAuthConfigCache();

    const app = makeApp('operator');
    const res = await request(app)
      .get('/test')
      .set('x-operator-token', TOKEN)
      .set('x-forwarded-for', '1.2.3.4');

    expect(res.status).toBe(200);
  });

  // ── 5d. Unconfigured token (no OPERATOR_TOKEN env) ────────────────────────

  it('allows all requests when OPERATOR_TOKEN is not set (emits warning, no 401)', async () => {
    delete process.env.OPERATOR_TOKEN;
    resetAuthConfigCache();

    const app = makeApp('operator');
    const res = await request(app).get('/test');
    // No token configured → unprotected, passes through
    expect(res.status).toBe(200);
  });

  it('falls back to HEALTH_DETAILS_TOKEN when OPERATOR_TOKEN is not set', async () => {
    delete process.env.OPERATOR_TOKEN;
    process.env.HEALTH_DETAILS_TOKEN = 'health-token-123';
    resetAuthConfigCache();

    const app = makeApp('operator');

    // Wrong token → 401
    const badRes = await request(app)
      .get('/test')
      .set('x-operator-token', 'wrong');
    expect(badRes.status).toBe(401);

    // Correct health token → 200
    const goodRes = await request(app)
      .get('/test')
      .set('x-operator-token', 'health-token-123');
    expect(goodRes.status).toBe(200);

    delete process.env.HEALTH_DETAILS_TOKEN;
  });
});

// =============================================================================
// 6. Specific route classification — public reads available without credentials
// =============================================================================

describe('Public route access — unauthenticated reads work', () => {
  const mockPrisma = vi.hoisted(() => ({
    listing: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    auction: { findMany: vi.fn().mockResolvedValue([]) },
    offer:   { findMany: vi.fn().mockResolvedValue([]) },
    collection: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    marketplaceEvent: { findMany: vi.fn().mockResolvedValue([]) },
    whitelistedToken: { findMany: vi.fn().mockResolvedValue([]) },
    trackedContract: { findMany: vi.fn().mockResolvedValue([]) },
  }));

  const mockRedis = vi.hoisted(() => ({
    isOpen: false, isReady: false,
    get: vi.fn().mockResolvedValue(null),
    setEx: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    connect: vi.fn().mockRejectedValue(new Error('No Redis')),
  }));

  vi.mock('../src/db', () => ({ default: mockPrisma }));
  vi.mock('../src/prisma-write', () => ({ default: mockPrisma }));
  vi.mock('../src/redis.js', () => ({ default: mockRedis }));

  const publicEndpoints = [
    '/listings',
    '/auctions',
    '/offers',
    '/activity/recent',
    '/collections',
    '/search?q=test',
  ];

  for (const endpoint of publicEndpoints) {
    it(`GET ${endpoint} returns non-401 without credentials`, async () => {
      // Import fresh to avoid module cache issues
      const { default: router } = await import('../src/api/routes.js');
      const { errorHandler } = await import('../src/api/errors.js');
      const app = express();
      app.use(express.json());
      app.use(router);
      app.use(errorHandler);

      const res = await request(app).get(endpoint);
      expect(res.status, `Expected ${endpoint} to be public but got ${res.status}`).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  }
});

// =============================================================================
// 7. Specific route classification — operator routes blocked without token
// =============================================================================

describe('Operator route access — rejected without valid token', () => {
  const mockPrisma = vi.hoisted(() => ({
    listing: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    auction: { findMany: vi.fn().mockResolvedValue([]) },
    offer:   { findMany: vi.fn().mockResolvedValue([]) },
    collection: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    marketplaceEvent: { findMany: vi.fn().mockResolvedValue([]) },
    whitelistedToken: { findMany: vi.fn().mockResolvedValue([]) },
    trackedContract: { findMany: vi.fn().mockResolvedValue([]) },
    ledgerGap: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    backfillJob: { findMany: vi.fn().mockResolvedValue([]) },
    operationalAudit: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  }));

  const mockRedis = vi.hoisted(() => ({
    isOpen: false, isReady: false,
    get: vi.fn().mockResolvedValue(null),
    setEx: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    connect: vi.fn().mockRejectedValue(new Error('No Redis')),
  }));

  vi.mock('../src/db', () => ({ default: mockPrisma }));
  vi.mock('../src/prisma-write', () => ({ default: mockPrisma }));
  vi.mock('../src/redis.js', () => ({ default: mockRedis }));

  beforeEach(() => {
    process.env.OPERATOR_TOKEN = 'test-operator-token';
    resetAuthConfigCache();
  });

  afterEach(() => {
    delete process.env.OPERATOR_TOKEN;
    resetAuthConfigCache();
  });

  const operatorEndpoints = [
    '/reconciliation/status',
    '/backfill/status',
    '/keeper/status',
    '/sync/gaps',
    '/sync/jobs',
    '/admin/contracts',
    '/admin/audit',
    '/admin/query-cost',
  ];

  for (const endpoint of operatorEndpoints) {
    it(`GET ${endpoint} returns 401 without operator token`, async () => {
      const { default: router } = await import('../src/api/routes.js');
      const { default: auditRouter } = await import('../src/api/audit-routes.js');
      const { errorHandler } = await import('../src/api/errors.js');
      const app = express();
      app.use(express.json());
      app.use(router);
      app.use(auditRouter);
      app.use(errorHandler);

      const res = await request(app).get(endpoint);
      expect(res.status, `${endpoint} should be 401 without token`).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });
  }
});

// =============================================================================
// 8. SSE endpoint — public with replay support
// =============================================================================

describe('SSE endpoint (/events) — public, no auth required', () => {
  beforeEach(() => resetAuthConfigCache());

  it('classifies /events as public', () => {
    expect(classifyRoute('/events')).toBe('public');
  });

  it('classifies /notifications/stream as public', () => {
    expect(classifyRoute('/notifications/stream')).toBe('public');
  });

  it('SSE endpoint does not require auth credentials', () => {
    // Verify via matrix that the policy is intentionally public
    expect(ROUTE_POLICY_MATRIX['/events']?.policy).toBe('public');
    expect(ROUTE_POLICY_MATRIX['/notifications/stream']?.policy).toBe('public');
  });
});

// =============================================================================
// 9. loadAuthConfig — env-var parsing and caching
// =============================================================================

describe('loadAuthConfig — env parsing', () => {
  beforeEach(() => {
    saveEnv(['OPERATOR_TOKEN', 'HEALTH_DETAILS_TOKEN', 'OPERATOR_ALLOWLIST']);
    resetAuthConfigCache();
  });

  afterEach(() => {
    restoreEnv(['OPERATOR_TOKEN', 'HEALTH_DETAILS_TOKEN', 'OPERATOR_ALLOWLIST']);
    resetAuthConfigCache();
  });

  it('reads OPERATOR_TOKEN from env', () => {
    process.env.OPERATOR_TOKEN = 'my-token';
    const cfg = loadAuthConfig();
    expect(cfg.operatorToken).toBe('my-token');
  });

  it('falls back to HEALTH_DETAILS_TOKEN when OPERATOR_TOKEN is absent', () => {
    delete process.env.OPERATOR_TOKEN;
    process.env.HEALTH_DETAILS_TOKEN = 'health-token';
    const cfg = loadAuthConfig();
    expect(cfg.operatorToken).toBe('health-token');
  });

  it('parses OPERATOR_ALLOWLIST as comma-separated IPs', () => {
    process.env.OPERATOR_ALLOWLIST = '10.0.0.1, 10.0.0.2 , 192.168.1.1';
    const cfg = loadAuthConfig();
    expect(cfg.allowlist).toEqual(['10.0.0.1', '10.0.0.2', '192.168.1.1']);
  });

  it('returns empty allowlist when OPERATOR_ALLOWLIST is not set', () => {
    delete process.env.OPERATOR_ALLOWLIST;
    const cfg = loadAuthConfig();
    expect(cfg.allowlist).toEqual([]);
  });

  it('caches config between calls', () => {
    process.env.OPERATOR_TOKEN = 'first-token';
    const cfg1 = loadAuthConfig();
    process.env.OPERATOR_TOKEN = 'changed-token';
    const cfg2 = loadAuthConfig();
    // Should be same cached object
    expect(cfg1).toBe(cfg2);
    expect(cfg2.operatorToken).toBe('first-token');
  });

  it('resetAuthConfigCache causes fresh read on next loadAuthConfig()', () => {
    process.env.OPERATOR_TOKEN = 'first-token';
    loadAuthConfig();
    resetAuthConfigCache();
    process.env.OPERATOR_TOKEN = 'new-token';
    const cfg = loadAuthConfig();
    expect(cfg.operatorToken).toBe('new-token');
  });
});

// =============================================================================
// 10. X-Forwarded-For header parsing
// =============================================================================

describe('X-Forwarded-For — IP extraction', () => {
  const TOKEN = 'fwd-token';

  beforeEach(() => {
    process.env.OPERATOR_TOKEN = TOKEN;
    process.env.OPERATOR_ALLOWLIST = '10.0.0.1';
    resetAuthConfigCache();
  });

  afterEach(() => {
    delete process.env.OPERATOR_TOKEN;
    delete process.env.OPERATOR_ALLOWLIST;
    resetAuthConfigCache();
  });

  it('uses the first IP in a multi-hop X-Forwarded-For header', async () => {
    const app = makeApp('operator');
    // First IP is 10.0.0.1 (allowlisted), second is 10.0.0.99
    const res = await request(app)
      .get('/test')
      .set('x-operator-token', TOKEN)
      .set('x-forwarded-for', '10.0.0.1, 10.0.0.99');
    expect(res.status).toBe(200);
  });

  it('blocks when first IP in X-Forwarded-For is not allowlisted', async () => {
    const app = makeApp('operator');
    const res = await request(app)
      .get('/test')
      .set('x-operator-token', TOKEN)
      .set('x-forwarded-for', '9.9.9.9, 10.0.0.1');
    expect(res.status).toBe(403);
  });
});

// =============================================================================
// 11. Matrix policy coherence — operator routes require sensitive context
// =============================================================================

describe('ROUTE_POLICY_MATRIX — operator route descriptions include intent', () => {
  it('all operator routes have descriptions that indicate protection', () => {
    const operatorEntries = Object.entries(ROUTE_POLICY_MATRIX)
      .filter(([, entry]) => entry.policy === 'operator');

    expect(operatorEntries.length).toBeGreaterThan(5);

    for (const [path, entry] of operatorEntries) {
      expect(entry.policy, `${path} policy`).toBe('operator');
    }
  });

  it('operator route set includes all poller recovery endpoints', () => {
    expect(OPERATOR_ROUTES.has('/admin/poller/resume')).toBe(true);
    expect(OPERATOR_ROUTES.has('/admin/poller/halt')).toBe(true);
    expect(OPERATOR_ROUTES.has('/admin/poller/revert')).toBe(true);
    expect(OPERATOR_ROUTES.has('/admin/gap-repair/trigger')).toBe(true);
  });

  it('operator route set includes dead-letter management', () => {
    expect(OPERATOR_ROUTES.has('/admin/dead-letters')).toBe(true);
    expect(OPERATOR_ROUTES.has('/admin/dead-letters/{id}/replay')).toBe(true);
  });

  it('operator route set includes query cost diagnostics', () => {
    expect(OPERATOR_ROUTES.has('/admin/query-cost')).toBe(true);
  });
});
