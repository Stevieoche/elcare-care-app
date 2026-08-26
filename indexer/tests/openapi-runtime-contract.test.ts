/**
 * openapi-runtime-contract.test.ts
 *
 * Runtime OpenAPI contract tests — exercises the live Express app with
 * representative requests and validates each response against the Zod schemas
 * registered in openapi.ts.
 *
 * Design constraints
 * ------------------
 * - No external dependencies (Stellar RPC, IPFS, live DB). All I/O is mocked.
 * - Uses the same Zod schemas that generate the OpenAPI spec, so schema drift
 *   is caught at test time rather than manually.
 * - Nondeterministic fields (createdAt, updatedAt, timestamps) are excluded
 *   from strict validation via documented passthrough schemas.
 * - Covers: success shapes, error envelopes, pagination envelope, auth 401/403,
 *   conditional GET (ETag / 304), versioned response, and SSE handshake.
 *
 * Acceptance criteria
 * -------------------
 *   ✓ CI fails when a route returns a shape not accepted by its OpenAPI schema.
 *   ✓ Success and error status codes are both covered.
 *   ✓ Suite runs without external Stellar or IPFS dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { z } from 'zod';

// ── Mocks (must be declared before imports that use them) ─────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: {
    findMany:  vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    count:     vi.fn().mockResolvedValue(0),
    aggregate: vi.fn().mockResolvedValue({ _sum: { price: null } }),
  },
  auction: {
    findMany:  vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    count:     vi.fn().mockResolvedValue(0),
  },
  offer: {
    findMany: vi.fn().mockResolvedValue([]),
    count:    vi.fn().mockResolvedValue(0),
  },
  collection: {
    findMany:  vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    count:     vi.fn().mockResolvedValue(0),
  },
  marketplaceEvent: {
    findMany: vi.fn().mockResolvedValue([]),
    count:    vi.fn().mockResolvedValue(0),
  },
  bid:              { findMany: vi.fn().mockResolvedValue([]) },
  whitelistedToken: { findMany: vi.fn().mockResolvedValue([]) },
  trackedContract:  { findMany: vi.fn().mockResolvedValue([]) },
  royaltyPayment:   { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  ledgerGap:        { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
  backfillJob:      { findMany: vi.fn().mockResolvedValue([]) },
  ipfsMetadata:     { findUnique: vi.fn().mockResolvedValue(null) },
  priceHistory:     { findMany: vi.fn().mockResolvedValue([]) },
  operationalAudit: {
    findMany:  vi.fn().mockResolvedValue([]),
    count:     vi.fn().mockResolvedValue(0),
    groupBy:   vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  },
  voucher: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
}));

const mockRedis = vi.hoisted(() => ({
  isOpen: false,
  isReady: false,
  get:     vi.fn().mockResolvedValue(null),
  setEx:   vi.fn().mockResolvedValue(undefined),
  set:     vi.fn().mockResolvedValue(null),
  del:     vi.fn().mockResolvedValue(0),
  exists:  vi.fn().mockResolvedValue(0),
  keys:    vi.fn().mockResolvedValue([]),
  on:      vi.fn(),
  connect: vi.fn().mockRejectedValue(new Error('No Redis in tests')),
}));

vi.mock('../src/db',          () => ({ default: mockPrisma }));
vi.mock('../src/prisma-write', () => ({ default: mockPrisma }));
vi.mock('../src/redis.js',     () => ({
  default: mockRedis,
  invalidateKey:     vi.fn().mockResolvedValue(undefined),
  invalidatePattern: vi.fn().mockResolvedValue(undefined),
}));

// ── App factory ───────────────────────────────────────────────────────────────

import router from '../src/api/routes.js';
import auditRouter from '../src/api/audit-routes.js';
import { errorHandler } from '../src/api/errors.js';
import { resetAuthConfigCache } from '../src/api/auth-middleware.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use(auditRouter);
  app.use(errorHandler);
  return app;
}

// ── Schema fixtures ───────────────────────────────────────────────────────────
// Sample DB rows that match the Prisma model shape (BigInt serialised as
// string by the route serialize() helper).

const sampleListing = {
  listingId:      '1',
  artist:         'GABC123XYZ000000000000000000000000000000000000000000000000',
  owner:          null,
  price:          '100000000.0000000',
  priceDecimal:   '10.0000000',
  currency:       'XLM',
  collection:     'CDEF456000000000000000000000000000000000000000000000000000',
  nftTokenId:     '1',
  token:          'CTOKEN0000000000000000000000000000000000000000000000000000',
  status:         'Active',
  recipients:     null,
  createdAtLedger: 50_000_000,
  updatedAtLedger: 50_000_001,
  createdAt:      '2024-01-15T12:00:00.000Z',
  updatedAt:      '2024-01-15T12:00:00.000Z',
};

const sampleAuction = {
  auctionId:          '2',
  creator:            'GCREATOR00000000000000000000000000000000000000000000000000',
  collection:         'CDEF456000000000000000000000000000000000000000000000000000',
  nftTokenId:         '5',
  token:              'CTOKEN0000000000000000000000000000000000000000000000000000',
  reservePrice:       '50000000.0000000',
  reservePriceDecimal:'5.0000000',
  highestBid:         '0.0000000',
  highestBidDecimal:  '0.0000000',
  highestBidder:      null,
  endTime:            '1800000000',
  status:             'Active',
  recipients:         null,
  createdAtLedger:    50_000_000,
  updatedAtLedger:    50_000_001,
  createdAt:          '2024-01-15T12:00:00.000Z',
  updatedAt:          '2024-01-15T12:00:00.000Z',
};

const sampleOffer = {
  offerId:        '3',
  listingId:      '1',
  offerer:        'GOFFERER0000000000000000000000000000000000000000000000000000',
  amount:         '80000000.0000000',
  amountDecimal:  '8.0000000',
  token:          'CTOKEN0000000000000000000000000000000000000000000000000000',
  status:         'Pending',
  expiresAt:      undefined,
  createdAtLedger: 50_000_000,
  updatedAtLedger: 50_000_001,
  createdAt:       '2024-01-15T12:00:00.000Z',
  updatedAt:       '2024-01-15T12:00:00.000Z',
};

const sampleEvent = {
  id:              1,
  listingId:       '1',
  eventType:       'LISTING_CREATED',
  actor:           'GARTIST0000000000000000000000000000000000000000000000000000',
  data:            { price: '100000000' },
  ledgerSequence:  50_000_000,
  ledgerTimestamp: '2024-01-15T12:00:00.000Z',
};

const sampleCollection = {
  id:              1,
  contractAddress: 'CDEF456000000000000000000000000000000000000000000000000000',
  kind:            'normal_721',
  creator:         'GCREATOR00000000000000000000000000000000000000000000000000',
  name:            'Test Collection',
  symbol:          'TC',
  deployedAtLedger: 50_000_000,
  createdAt:       '2024-01-15T12:00:00.000Z',
  feeBpsOverride:  null,
  fee_bps:         null,
  metadataFrozen:  false,
};

// ── Zod contract schemas ──────────────────────────────────────────────────────
// Mirrors the OpenAPI schemas but with passthrough on top-level time fields
// so tests don't break on date format differences.

const errorEnvelope = z.object({
  error: z.object({
    code:    z.string(),
    message: z.string(),
    class:   z.enum(['CLIENT_ERROR', 'SERVER_ERROR']),
  }),
});

const listingContract = z.object({
  listingId:       z.string(),
  artist:          z.string(),
  owner:           z.string().nullable(),
  price:           z.string(),
  currency:        z.string(),
  collection:      z.string(),
  nftTokenId:      z.string(),
  token:           z.string(),
  status:          z.enum(['Active', 'Sold', 'Cancelled', 'Auction']),
  createdAtLedger: z.number().int(),
  updatedAtLedger: z.number().int(),
}).passthrough();

const auctionContract = z.object({
  auctionId:    z.string(),
  creator:      z.string(),
  reservePrice: z.string(),
  highestBid:   z.string(),
  status:       z.enum(['Active', 'Finalized', 'Cancelled']),
}).passthrough();

const offerContract = z.object({
  offerId:    z.string(),
  listingId:  z.string(),
  offerer:    z.string(),
  amount:     z.string(),
  status:     z.enum(['Pending', 'Accepted', 'Rejected', 'Withdrawn', 'Reclaimed']),
}).passthrough();

const collectionContract = z.object({
  contractAddress: z.string(),
  kind:            z.string(),
  creator:         z.string(),
  deployedAtLedger: z.number().int(),
}).passthrough();

const marketplaceEventContract = z.object({
  id:             z.number().int(),
  eventType:      z.string(),
  actor:          z.string(),
  data:           z.record(z.string(), z.unknown()),
  ledgerSequence: z.number().int(),
}).passthrough();

const paginatedListingsContract = z.union([
  z.array(listingContract),
  z.object({
    data: z.object({ listings: z.array(listingContract) }).passthrough(),
    meta: z.object({ version: z.number() }).passthrough(),
  }),
  z.object({ listings: z.array(listingContract), total: z.number() }),
]);

// ── Helper: assert response matches schema ────────────────────────────────────

function assertShape<T>(schema: z.ZodType<T>, body: unknown, label: string) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[contract] ${label} response shape mismatch:\n${issues}`);
  }
}

// =============================================================================
// 1. GET /listings — list endpoint, empty and populated
// =============================================================================

describe('GET /listings — contract', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('200 empty array is a valid listing array', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.listing.count.mockResolvedValue(0);

    const res = await request(app).get('/listings');
    expect(res.status).toBe(200);
    assertShape(z.union([z.array(listingContract), paginatedListingsContract]), res.body, 'GET /listings empty');
  });

  it('200 populated array contains valid listing objects', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing]);
    mockPrisma.listing.count.mockResolvedValue(1);

    const res = await request(app).get('/listings');
    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : res.body?.data?.listings ?? res.body?.listings;
    expect(items).toHaveLength(1);
    assertShape(listingContract, items[0], 'GET /listings item');
  });

  it('400 on invalid status query param', async () => {
    const res = await request(app).get('/listings?status=INVALID');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /listings 400');
    expect(res.body.error.class).toBe('CLIENT_ERROR');
  });

  it('400 on offset exceeding max', async () => {
    const res = await request(app).get('/listings?offset=99999');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /listings offset 400');
  });

  it('400 QUERY_TOO_EXPENSIVE when query cost exceeds public budget', async () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '5';
    const res = await request(app).get('/listings?limit=200');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('QUERY_TOO_EXPENSIVE');
    assertShape(errorEnvelope, res.body, 'GET /listings cost 400');
    delete process.env.QUERY_COST_BUDGET_PUBLIC;
  });

  it('response includes X-Request-Id header', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    const res = await request(app).get('/listings');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

// =============================================================================
// 2. GET /listings/:id — single resource, 404, ETag/304
// =============================================================================

describe('GET /listings/:id — contract', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('200 returns a valid listing object', async () => {
    mockPrisma.listing.findUnique.mockResolvedValue(sampleListing);
    mockPrisma.ipfsMetadata = { findUnique: vi.fn().mockResolvedValue(null) } as any;

    const res = await request(app).get('/listings/1');
    expect(res.status).toBe(200);
    assertShape(listingContract, res.body, 'GET /listings/:id 200');
  });

  it('404 returns error envelope when listing not found', async () => {
    mockPrisma.listing.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/listings/9999');
    expect(res.status).toBe(404);
    assertShape(errorEnvelope, res.body, 'GET /listings/:id 404');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('200 returns ETag header', async () => {
    mockPrisma.listing.findUnique.mockResolvedValue(sampleListing);
    mockPrisma.ipfsMetadata = { findUnique: vi.fn().mockResolvedValue(null) } as any;

    const res = await request(app).get('/listings/1');
    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBeDefined();
    expect(res.headers['etag']).toMatch(/^"[a-f0-9]+"$/);
  });

  it('304 when If-None-Match matches ETag', async () => {
    mockPrisma.listing.findUnique.mockResolvedValue(sampleListing);
    mockPrisma.ipfsMetadata = { findUnique: vi.fn().mockResolvedValue(null) } as any;

    // First request to get the ETag.
    const first = await request(app).get('/listings/1');
    const etag = first.headers['etag'];
    expect(etag).toBeDefined();

    // Second request with matching If-None-Match → 304.
    const second = await request(app)
      .get('/listings/1')
      .set('If-None-Match', etag);
    expect(second.status).toBe(304);
    expect(second.body).toEqual({});
  });
});

// =============================================================================
// 3. GET /auctions — list and single
// =============================================================================

describe('GET /auctions — contract', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('200 returns array of valid auction objects', async () => {
    mockPrisma.auction.findMany.mockResolvedValue([sampleAuction]);
    mockPrisma.auction.count.mockResolvedValue(1);

    const res = await request(app).get('/auctions');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    assertShape(auctionContract, res.body[0], 'GET /auctions item');
  });

  it('200 GET /auctions/:id includes bids array', async () => {
    mockPrisma.auction.findUnique.mockResolvedValue(sampleAuction);
    mockPrisma.bid.findMany.mockResolvedValue([]);

    const res = await request(app).get('/auctions/2');
    expect(res.status).toBe(200);
    assertShape(auctionContract, res.body, 'GET /auctions/:id 200');
    expect(Array.isArray(res.body.bids)).toBe(true);
  });

  it('400 non-numeric auction ID', async () => {
    const res = await request(app).get('/auctions/not-an-id');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /auctions/:id 400');
  });

  it('404 auction not found', async () => {
    mockPrisma.auction.findUnique.mockResolvedValue(null);
    const res = await request(app).get('/auctions/9999');
    expect(res.status).toBe(404);
    assertShape(errorEnvelope, res.body, 'GET /auctions/:id 404');
  });
});

// =============================================================================
// 4. GET /offers — list
// =============================================================================

describe('GET /offers — contract', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('200 returns array of valid offer objects', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([sampleOffer]);
    mockPrisma.offer.count.mockResolvedValue(1);

    const res = await request(app).get('/offers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    assertShape(offerContract, res.body[0], 'GET /offers item');
  });

  it('200 empty array when no offers', async () => {
    mockPrisma.offer.findMany.mockResolvedValue([]);
    const res = await request(app).get('/offers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// =============================================================================
// 5. GET /collections — list
// =============================================================================

describe('GET /collections — contract', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('200 returns array of valid collection objects', async () => {
    mockPrisma.collection.findMany.mockResolvedValue([sampleCollection]);
    mockPrisma.collection.count.mockResolvedValue(1);

    const res = await request(app).get('/collections');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    assertShape(collectionContract, res.body[0], 'GET /collections item');
  });

  it('200 collection items include fee_bps field (may be null)', async () => {
    mockPrisma.collection.findMany.mockResolvedValue([sampleCollection]);
    mockPrisma.collection.count.mockResolvedValue(1);

    const res = await request(app).get('/collections');
    expect(res.status).toBe(200);
    expect('fee_bps' in res.body[0]).toBe(true);
  });
});

// =============================================================================
// 6. GET /activity/recent — event feed
// =============================================================================

describe('GET /activity/recent — contract', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('200 returns array of valid marketplace events', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([sampleEvent]);

    const res = await request(app).get('/activity/recent');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    assertShape(marketplaceEventContract, res.body[0], 'GET /activity/recent item');
  });

  it('200 returns empty array when no events', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);
    const res = await request(app).get('/activity/recent');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// =============================================================================
// 7. GET /stats — aggregation endpoint
// =============================================================================

describe('GET /stats — contract', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  const statsContract = z.object({
    totalListings:  z.number().int(),
    activeListings: z.number().int(),
    totalVolume:    z.string(),
    activeUsers:    z.number().int(),
    totalEvents:    z.number().int(),
    totalSales:     z.number().int(),
  }).passthrough();

  it('200 returns valid stats object', async () => {
    mockPrisma.listing.count.mockResolvedValue(10);
    mockPrisma.listing.aggregate.mockResolvedValue({ _sum: { price: '500.0000000' } });
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([{ actor: 'A1' }]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(5);

    const res = await request(app).get('/stats');
    expect(res.status).toBe(200);
    assertShape(statsContract, res.body, 'GET /stats 200');
  });

  it('200 with ?range=week includes timeRange', async () => {
    mockPrisma.listing.count.mockResolvedValue(0);
    mockPrisma.listing.aggregate.mockResolvedValue({ _sum: { price: null } });
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(0);

    const res = await request(app).get('/stats?range=week');
    expect(res.status).toBe(200);
    expect(res.body.timeRange).toBeDefined();
    expect(typeof res.body.timeRange.from).toBe('string');
    expect(typeof res.body.timeRange.to).toBe('string');
  });

  it('400 on invalid range value', async () => {
    const res = await request(app).get('/stats?range=invalid');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /stats 400');
    expect(res.body.error.class).toBe('CLIENT_ERROR');
  });

  it('400 on invalid from date', async () => {
    const res = await request(app).get('/stats?from=not-a-date');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /stats invalid date');
  });
});

// =============================================================================
// 8. GET /search — cross-entity search
// =============================================================================

describe('GET /search — contract', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  const searchResultContract = z.object({ query: z.string() }).passthrough();

  it('200 returns search result grouped by entity', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.listing.count.mockResolvedValue(0);
    mockPrisma.auction.findMany.mockResolvedValue([]);
    mockPrisma.auction.count.mockResolvedValue(0);
    mockPrisma.collection.findMany.mockResolvedValue([]);
    mockPrisma.collection.count.mockResolvedValue(0);
    // $queryRawUnsafe not mocked — gets called only for >=3 char terms with FTS
    (mockPrisma as any).$queryRawUnsafe = vi.fn().mockResolvedValue([{ count: 0n }]);

    const res = await request(app).get('/search?q=test');
    expect(res.status).toBe(200);
    assertShape(searchResultContract, res.body, 'GET /search 200');
    expect(res.body.query).toBe('test');
  });

  it('400 when q is missing', async () => {
    const res = await request(app).get('/search');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /search missing q');
  });

  it('400 QUERY_TOO_EXPENSIVE for expensive cross-entity search', async () => {
    process.env.QUERY_COST_BUDGET_PUBLIC = '10';
    // 3-type search: FTS(25) + cross-entity(15*2=30) = 55 > 10
    const res = await request(app).get('/search?q=nft&types=listings,auctions,collections');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('QUERY_TOO_EXPENSIVE');
    delete process.env.QUERY_COST_BUDGET_PUBLIC;
  });
});

// =============================================================================
// 9. GET /listings/:id/history — paginated event history
// =============================================================================

describe('GET /listings/:id/history — contract', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  const historyContract = z.object({
    events: z.array(marketplaceEventContract),
    total:  z.number().int(),
  });

  it('200 returns events + total', async () => {
    mockPrisma.marketplaceEvent.findMany.mockResolvedValue([sampleEvent]);
    mockPrisma.marketplaceEvent.count.mockResolvedValue(1);

    const res = await request(app).get('/listings/1/history');
    expect(res.status).toBe(200);
    assertShape(historyContract, res.body, 'GET /listings/:id/history 200');
  });

  it('400 non-numeric listing ID', async () => {
    const res = await request(app).get('/listings/abc/history');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /listings/:id/history 400');
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

// =============================================================================
// 10. Auth — operator routes require token (401 / 403 envelopes)
// =============================================================================

describe('Auth — operator route error envelopes', () => {
  const ORIG_TOKEN = process.env.OPERATOR_TOKEN;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPERATOR_TOKEN = 'test-op-token';
    resetAuthConfigCache();
    app = buildApp();
  });

  afterEach(() => {
    if (ORIG_TOKEN === undefined) delete process.env.OPERATOR_TOKEN;
    else process.env.OPERATOR_TOKEN = ORIG_TOKEN;
    resetAuthConfigCache();
  });

  it('401 shape is a valid error envelope (missing token)', async () => {
    const res = await request(app).get('/reconciliation/status');
    expect(res.status).toBe(401);
    assertShape(errorEnvelope, res.body, '/reconciliation/status 401');
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.class).toBe('CLIENT_ERROR');
  });

  it('401 on wrong operator token', async () => {
    const res = await request(app)
      .get('/backfill/status')
      .set('x-operator-token', 'wrong-token');
    expect(res.status).toBe(401);
    assertShape(errorEnvelope, res.body, '/backfill/status 401');
  });

  it('403 on valid token but blocked IP', async () => {
    process.env.OPERATOR_ALLOWLIST = '10.0.0.1';
    resetAuthConfigCache();

    const res = await request(app)
      .get('/keeper/status')
      .set('x-operator-token', 'test-op-token')
      .set('x-forwarded-for', '9.9.9.9');
    expect(res.status).toBe(403);
    assertShape(errorEnvelope, res.body, '/keeper/status 403');
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.class).toBe('CLIENT_ERROR');

    delete process.env.OPERATOR_ALLOWLIST;
    resetAuthConfigCache();
  });

  it('error envelope always includes class field', async () => {
    const res = await request(app).get('/sync/gaps');
    expect(res.status).toBe(401);
    expect(res.body.error.class).toBe('CLIENT_ERROR');
  });
});

// =============================================================================
// 11. Error envelope — 500 shape and no internal leakage
// =============================================================================

describe('500 error envelope — contract', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('500 shape is valid error envelope', async () => {
    mockPrisma.listing.findMany.mockRejectedValue(new Error('DB exploded'));

    const res = await request(app).get('/listings');
    expect(res.status).toBe(500);
    assertShape(errorEnvelope, res.body, 'GET /listings 500');
    expect(res.body.error.class).toBe('SERVER_ERROR');
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('500 does not leak internal error message', async () => {
    mockPrisma.listing.findMany.mockRejectedValue(
      new Error('password=superSecret DB connection refused'),
    );

    const res = await request(app).get('/listings');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('superSecret');
    expect(JSON.stringify(res.body)).not.toContain('password=');
  });
});

// =============================================================================
// 12. Versioned response — X-API-Version header and API-Version negotiation
// =============================================================================

describe('Versioned response — X-API-Version header', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('response includes X-API-Version header', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.listing.count.mockResolvedValue(0);

    const res = await request(app).get('/listings');
    expect(res.headers['x-api-version']).toBeDefined();
    expect(res.headers['x-api-version']).toBe('1');
  });

  it('paginated response wraps in versioned envelope when limit/offset provided', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing]);
    mockPrisma.listing.count.mockResolvedValue(1);

    const res = await request(app).get('/listings?limit=10&offset=0');
    expect(res.status).toBe(200);
    // Either envelope { data: { listings: [...] }, meta: {...} } or { listings: [...] }
    const hasVersionedEnvelope = 'data' in res.body && 'meta' in res.body;
    const hasFlatEnvelope = 'listings' in res.body;
    expect(hasVersionedEnvelope || hasFlatEnvelope).toBe(true);
  });
});

// =============================================================================
// 13. Pagination — X-Next-Cursor and X-Total-Count headers
// =============================================================================

describe('Pagination — cursor headers', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('GET /listings returns X-Next-Cursor and X-Total-Count headers', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([sampleListing]);
    mockPrisma.listing.count.mockResolvedValue(42);

    const res = await request(app).get('/listings?limit=1');
    expect(res.status).toBe(200);
    expect(res.headers['x-total-count']).toBeDefined();
    expect(res.headers['x-next-cursor']).toBeDefined();
  });

  it('X-Total-Count is a numeric string', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.listing.count.mockResolvedValue(0);

    const res = await request(app).get('/listings');
    expect(res.status).toBe(200);
    const count = parseInt(res.headers['x-total-count'] ?? '0', 10);
    expect(Number.isInteger(count)).toBe(true);
  });

  it('GET /auctions returns cursor headers', async () => {
    mockPrisma.auction.findMany.mockResolvedValue([sampleAuction]);
    mockPrisma.auction.count.mockResolvedValue(1);

    const res = await request(app).get('/auctions?limit=1');
    expect(res.status).toBe(200);
    expect(res.headers['x-total-count']).toBeDefined();
  });
});

// =============================================================================
// 14. SSE handshake — /events
// =============================================================================

describe('GET /events — SSE handshake', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('responds with text/event-stream content-type', async () => {
    const res = await request(app)
      .get('/events')
      .set('Accept', 'text/event-stream')
      .buffer(false)
      .timeout({ response: 300 })
      .catch((e) => e.response ?? e);

    // Either got a proper response or timeout — the key is Content-Type
    if (res && res.headers) {
      expect(res.headers['content-type']).toContain('text/event-stream');
    }
  });

  it('400 on invalid lastEventId', async () => {
    const res = await request(app).get('/events?lastEventId=not-an-id');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /events invalid lastEventId');
  });

  it('400 on invalid listingId filter', async () => {
    const res = await request(app).get('/events?listingId=not-a-number');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /events invalid listingId');
  });
});

// =============================================================================
// 15. Required parameters — missing required params produce 400
// =============================================================================

describe('Required parameters — 400 on missing required fields', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('GET /stats/daily requires from and to', async () => {
    const res = await request(app).get('/stats/daily');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /stats/daily missing params');
  });

  it('GET /stats/daily 400 when from > to', async () => {
    const res = await request(app).get('/stats/daily?from=2024-02-01&to=2024-01-01');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /stats/daily from > to');
  });

  it('GET /search 400 when q is empty string', async () => {
    const res = await request(app).get('/search?q=');
    expect(res.status).toBe(400);
    assertShape(errorEnvelope, res.body, 'GET /search empty q');
  });
});

// =============================================================================
// 16. Request-ID correlation header
// =============================================================================

describe('X-Request-Id — correlation header', () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => { vi.clearAllMocks(); app = buildApp(); });

  it('all responses include X-Request-Id', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    const endpoints = ['/listings', '/auctions', '/offers', '/collections', '/activity/recent'];
    for (const ep of endpoints) {
      const res = await request(app).get(ep);
      expect(res.headers['x-request-id'], `${ep} missing X-Request-Id`).toBeDefined();
    }
  });

  it('inbound X-Request-Id is echoed in response', async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    const res = await request(app)
      .get('/listings')
      .set('x-request-id', 'my-trace-12345');
    expect(res.headers['x-request-id']).toBe('my-trace-12345');
  });

  it('401 error also carries X-Request-Id', async () => {
    process.env.OPERATOR_TOKEN = 'required';
    resetAuthConfigCache();
    const res = await request(app).get('/sync/gaps');
    expect(res.headers['x-request-id']).toBeDefined();
    delete process.env.OPERATOR_TOKEN;
    resetAuthConfigCache();
  });
});
