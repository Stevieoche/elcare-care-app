import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Extend Zod with .openapi() so schemas can carry metadata
extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

// ── Reusable field types ──────────────────────────────────────────────────────

/** BigInt IDs are serialised as decimal strings by the route serialize() helper */
const bigIntString = z.string().openapi({ example: '1' });

const isoDateTime = z.string().openapi({ format: 'date-time', example: '2024-01-15T12:00:00.000Z' });

// ── Response schemas ──────────────────────────────────────────────────────────

export const ListingSchema = registry.register(
  'Listing',
  z.object({
    listingId:       bigIntString.openapi({ description: 'Unique listing ID' }),
    artist:          z.string().openapi({ example: 'GABC...XYZ', description: 'Seller / artist Stellar address' }),
    owner:           z.string().nullable().openapi({ example: 'GABC...XYZ', description: 'Current owner address, null before first sale' }),
    price:           z.string().openapi({ example: '100000000', description: 'RAW on-chain price in the token\'s base units (i128, unscaled — e.g. stroops for a 7-decimal token). The contract never scales this value; see `priceDecimal` for the human-readable form.' }),
    priceDecimal:    z.string().openapi({ example: '10.0000000', description: 'Human-readable price, computed as price / 10^decimals using the payment token\'s known decimal precision (see docs/guides/payment-tokens.md). Safe to display directly.' }),
    currency:        z.string().openapi({ example: 'XLM' }),
    collection:      z.string().openapi({ example: 'CABC...DEF', description: 'Collection contract address' }),
    nftTokenId:      bigIntString.openapi({ description: 'NFT token ID within the collection' }),
    token:           z.string().openapi({ example: 'CABC...DEF', description: 'Payment token contract address' }),
    status:          z.enum(['Active', 'Sold', 'Cancelled', 'Auction']).openapi({ example: 'Active' }),
    recipients:      z.unknown().nullable().openapi({ description: 'Royalty recipients (JSON)' }),
    createdAtLedger: z.number().int().openapi({ example: 50000000, description: 'Ledger sequence when the listing was created' }),
    updatedAtLedger: z.number().int().openapi({ example: 50000001, description: 'Ledger sequence of the last state change' }),
    createdAt:       isoDateTime.openapi({ description: 'Wall-clock creation time' }),
    updatedAt:       isoDateTime.openapi({ description: 'Wall-clock last-update time' }),
  }).openapi('Listing'),
);

export const AuctionSchema = registry.register(
  'Auction',
  z.object({
    auctionId:       bigIntString.openapi({ description: 'Unique auction ID' }),
    creator:         z.string().openapi({ example: 'GABC...XYZ', description: 'Auction creator Stellar address' }),
    collection:      z.string().openapi({ example: 'CABC...DEF' }),
    nftTokenId:      bigIntString,
    token:           z.string().openapi({ example: 'CABC...DEF', description: 'Payment token contract address' }),
    reservePrice:    z.string().openapi({ example: '50000000', description: 'RAW minimum acceptable bid in the token\'s base units (unscaled i128). See `reservePriceDecimal` for the human-readable form.' }),
    reservePriceDecimal: z.string().openapi({ example: '5.0000000', description: 'Human-readable reserve price (reservePrice / 10^decimals).' }),
    highestBid:      z.string().openapi({ example: '75000000', description: 'RAW current highest bid in the token\'s base units (unscaled i128). See `highestBidDecimal` for the human-readable form.' }),
    highestBidDecimal: z.string().openapi({ example: '7.5000000', description: 'Human-readable highest bid (highestBid / 10^decimals).' }),
    highestBidder:   z.string().nullable().openapi({ example: 'GABC...XYZ', description: 'Address of the current highest bidder' }),
    endTime:         bigIntString.openapi({ description: 'Auction end time as Unix timestamp string' }),
    status:          z.enum(['Active', 'Finalized', 'Cancelled']).openapi({ example: 'Active' }),
    recipients:      z.unknown().nullable().openapi({ description: 'Royalty recipients (JSON)' }),
    createdAtLedger: z.number().int().openapi({ example: 50000000 }),
    updatedAtLedger: z.number().int().openapi({ example: 50000001 }),
    createdAt:       isoDateTime,
    updatedAt:       isoDateTime,
  }).openapi('Auction'),
);

export const OfferSchema = registry.register(
  'Offer',
  z.object({
    offerId:         bigIntString.openapi({ description: 'Unique offer ID' }),
    listingId:       bigIntString.openapi({ description: 'Listing this offer targets' }),
    offerer:         z.string().openapi({ example: 'GABC...XYZ', description: 'Address that placed the offer' }),
    amount:          z.string().openapi({ example: '80000000', description: 'RAW offered amount in the token\'s base units (unscaled i128). See `amountDecimal` for the human-readable form.' }),
    amountDecimal:   z.string().openapi({ example: '8.0000000', description: 'Human-readable offer amount (amount / 10^decimals).' }),
    token:           z.string().openapi({ example: 'CABC...DEF', description: 'Payment token contract address' }),
    status:          z.enum(['Pending', 'Accepted', 'Rejected', 'Withdrawn']).openapi({ example: 'Pending' }),
    expiresAt:       bigIntString.optional().openapi({ description: 'Ledger timestamp after which the offer can be reclaimed; absent when it never expires', example: '1735689600' }),
    createdAtLedger: z.number().int().openapi({ example: 50000000 }),
    updatedAtLedger: z.number().int().openapi({ example: 50000001 }),
    createdAt:       isoDateTime,
    updatedAt:       isoDateTime,
  }).openapi('Offer'),
);

export const MarketplaceEventSchema = registry.register(
  'MarketplaceEvent',
  z.object({
    id:               z.number().int().openapi({ example: 1, description: 'Auto-increment PK' }),
    listingId:        bigIntString.nullable().openapi({ description: 'Related listing ID, if applicable' }),
    eventType:        z.string().openapi({ example: 'ARTWORK_SOLD', description: 'Contract event type (e.g. LISTING_CREATED, ARTWORK_SOLD, BID_PLACED)' }),
    actor:            z.string().openapi({ example: 'GABC...XYZ', description: 'Primary address that triggered the event' }),
    data:             z.record(z.string(), z.unknown()).openapi({ description: 'Raw decoded event payload (varies by eventType)' }),
    ledgerSequence:   z.number().int().openapi({ example: 50000001 }),
    ledgerTimestamp:  isoDateTime.openapi({ description: 'Ledger close time' }),
  }).openapi('MarketplaceEvent'),
);

export const CollectionSchema = registry.register(
  'Collection',
  z.object({
    id:               z.number().int().openapi({ example: 1 }),
    contractAddress:  z.string().openapi({ example: 'CABC...DEF', description: 'Deployed collection contract address' }),
    kind:             z.string().openapi({
      example: 'normal_721',
      description: 'Collection type: normal_721 | normal_1155 | lazy_721 | lazy_1155',
    }),
    creator:          z.string().openapi({ example: 'GABC...XYZ' }),
    name:             z.string().nullable().openapi({ example: 'My NFT Collection' }),
    symbol:           z.string().nullable().openapi({ example: 'MNC' }),
    deployedAtLedger: z.number().int().openapi({ example: 50000000 }),
    createdAt:        isoDateTime,
  }).openapi('Collection'),
);

export const RoyaltyStatsSchema = registry.register(
  'RoyaltyStats',
  z.object({
    totalEarned: z.string().openapi({ example: '12.3456789', description: 'Total royalty earnings as a decimal string (7 dp)' }),
    payoutCount: z.number().int().openapi({ example: 5, description: 'Number of secondary sales that generated royalties' }),
    lastPayout:  z.number().int().openapi({ example: 1705320000000, description: 'Unix timestamp (ms) of the most recent royalty payout, 0 if none' }),
  }).openapi('RoyaltyStats'),
);

export const RoyaltyPaymentSchema = registry.register(
  'RoyaltyPayment',
  z.object({
    id:             z.number().int().openapi({ example: 1 }),
    listingId:      z.string().nullable().openapi({ example: '7', description: 'Listing id for fixed-price / offer settlements, null for auctions' }),
    auctionId:      z.string().nullable().openapi({ example: null, description: 'Auction id for auction settlements, null otherwise' }),
    recipient:      z.string().openapi({ example: 'GABC...XYZ' }),
    amount:         z.string().openapi({ example: '6650000.0000000', description: 'Amount this recipient received (decimal string)' }),
    salePrice:      z.string().openapi({ example: '10000000.0000000', description: 'Total sale price of the settlement' }),
    ledgerSequence: z.number().int().openapi({ example: 50000000 }),
    createdAt:      isoDateTime,
  }).openapi('RoyaltyPayment'),
);

export const RoyaltyBreakdownSchema = registry.register(
  'RoyaltyBreakdown',
  z.object({
    payments: z.array(RoyaltyPaymentSchema),
    total:    z.number().int().openapi({ example: 12, description: 'Total matching rows (independent of pagination)' }),
    limit:    z.number().int().openapi({ example: 50 }),
    offset:   z.number().int().openapi({ example: 0 }),
  }).openapi('RoyaltyBreakdown'),
);

export const StatsSchema = registry.register(
  'Stats',
  z.object({
    totalListings:  z.number().int().openapi({ example: 1000 }),
    activeListings: z.number().int().openapi({ example: 250 }),
    totalVolume:    z.string().openapi({ example: '50000.0000000', description: 'Cumulative sold volume as a decimal string' }),
    activeUsers:    z.number().int().openapi({ example: 100, description: 'Distinct actors in the requested time window' }),
    totalEvents:    z.number().int().openapi({ example: 5000 }),
    totalSales:     z.number().int().openapi({ example: 300 }),
    timeRange: z
      .object({
        from: z.string().nullable().openapi({ format: 'date-time' }),
        to:   z.string().nullable().openapi({ format: 'date-time' }),
      })
      .optional()
      .openapi({ description: 'Echoed back when a time filter was applied' }),
  }).openapi('Stats'),
);

export const ArtistMetricsSchema = registry.register(
  'ArtistMetrics',
  z.object({
    address:        z.string().openapi({ example: 'GABC...XYZ' }),
    range:          z.string().openapi({ example: 'week', description: 'Time window used ("all" when no range param was given)' }),
    totalListings:  z.number().int().openapi({ example: 50 }),
    totalSales:     z.number().int().openapi({ example: 20 }),
    totalVolume:    z.string().openapi({ example: '200.0000000' }),
    uniqueBuyers:   z.number().int().openapi({ example: 15 }),
    conversionRate: z.number().openapi({ example: 0.4, description: 'Sales / listings ratio (0 – 1)' }),
    salesTimeline: z.array(
      z.object({
        date:  z.string().openapi({ example: '2024-01-15' }),
        count: z.number().int().openapi({ example: 3 }),
      }),
    ).openapi({ description: 'Daily sales counts for the time window' }),
  }).openapi('ArtistMetrics'),
);

export const ErrorResponseSchema = registry.register(
  'ErrorResponse',
  z.object({
    error: z.object({
      code:    z.string().openapi({ example: 'NOT_FOUND' }),
      message: z.string().openapi({ example: 'Listing not found' }),
    }),
  }).openapi('ErrorResponse'),
);

// ── Shared parameter helpers ──────────────────────────────────────────────────

function pathParam(name: string, description: string) {
  return {
    name,
    in: 'path' as const,
    required: true,
    schema: { type: 'string' as const },
    description,
  };
}

function queryParam(name: string, schema: z.ZodTypeAny, description?: string) {
  return registry.registerParameter(name, schema.openapi({ param: { name, in: 'query' }, description }));
}

// ── Route registrations ───────────────────────────────────────────────────────

// GET /listings
registry.registerPath({
  method: 'get',
  path: '/listings',
  tags: ['Listings'],
  summary: 'List all listings',
  description: 'Returns listings with optional filters. When `limit` or `offset` are supplied the response wraps results in a pagination envelope.',
  request: {
    query: z.object({
      artist:   z.string().optional().openapi({ description: 'Filter by artist Stellar address' }),
      owner:    z.string().optional().openapi({ description: 'Filter by current owner address' }),
      status:   z.enum(['Active', 'Sold', 'Cancelled', 'Auction']).optional().openapi({ description: 'Filter by listing status' }),
      search:   z.string().optional().openapi({ description: 'Full-text search on artist address or collection' }),
      minPrice: z.coerce.number().nonnegative().optional().openapi({ description: 'Minimum price (inclusive)' }),
      maxPrice: z.coerce.number().nonnegative().optional().openapi({ description: 'Maximum price (inclusive)' }),
      limit:    z.coerce.number().int().nonnegative().max(1000).optional().openapi({ description: 'Max results to return (max 1000)' }),
      offset:   z.coerce.number().int().nonnegative().max(10000).optional().openapi({ description: 'Number of results to skip' }),
    }),
  },
  responses: {
    200: {
      description: 'Listing array, or paginated envelope when limit/offset are used',
      content: {
        'application/json': {
          schema: z.union([
            z.array(ListingSchema),
            z.object({ listings: z.array(ListingSchema), total: z.number().int() }),
          ]),
        },
      },
    },
  },
});

// GET /listings/:id
registry.registerPath({
  method: 'get',
  path: '/listings/{id}',
  tags: ['Listings'],
  summary: 'Get a single listing',
  request: { params: z.object({ id: z.string().openapi({ description: 'Listing ID' }) }) },
  responses: {
    200: { description: 'Listing details', content: { 'application/json': { schema: ListingSchema } } },
    404: { description: 'Listing not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /listings/:id/history
registry.registerPath({
  method: 'get',
  path: '/listings/{id}/history',
  tags: ['Listings'],
  summary: 'Get on-chain event history for a listing',
  request: { params: z.object({ id: z.string().openapi({ description: 'Listing ID' }) }) },
  responses: {
    200: {
      description: 'Ordered list of marketplace events for this listing',
      content: { 'application/json': { schema: z.array(MarketplaceEventSchema) } },
    },
    400: { description: 'Invalid ID format', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /auctions
registry.registerPath({
  method: 'get',
  path: '/auctions',
  tags: ['Auctions'],
  summary: 'List all auctions',
  request: {
    query: z.object({
      creator: z.string().optional().openapi({ description: 'Filter by creator address' }),
      status:  z.enum(['Active', 'Finalized', 'Cancelled']).optional().openapi({ description: 'Filter by auction status' }),
    }),
  },
  responses: {
    200: { description: 'Auction list', content: { 'application/json': { schema: z.array(AuctionSchema) } } },
  },
});

// GET /auctions/:id
registry.registerPath({
  method: 'get',
  path: '/auctions/{id}',
  tags: ['Auctions'],
  summary: 'Get a single auction',
  request: { params: z.object({ id: z.string().openapi({ description: 'Auction ID' }) }) },
  responses: {
    200: { description: 'Auction details', content: { 'application/json': { schema: AuctionSchema } } },
    400: { description: 'Invalid ID format', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Auction not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /offers
registry.registerPath({
  method: 'get',
  path: '/offers',
  tags: ['Offers'],
  summary: 'List offers',
  description: 'Returns all offers. Use `listing_id` to filter to a specific listing.',
  request: {
    query: z.object({
      listing_id: z.string().regex(/^\d+$/).optional().openapi({ description: 'Filter by listing ID (numeric string)' }),
    }),
  },
  responses: {
    200: { description: 'Offer list', content: { 'application/json': { schema: z.array(OfferSchema) } } },
  },
});

// GET /activity/recent
registry.registerPath({
  method: 'get',
  path: '/activity/recent',
  tags: ['Activity'],
  summary: 'Get the 20 most recent marketplace events',
  description: 'Cached for 30 s. Returns the latest cross-marketplace activity feed.',
  responses: {
    200: { description: 'Recent events', content: { 'application/json': { schema: z.array(MarketplaceEventSchema) } } },
  },
});

// GET /collections
registry.registerPath({
  method: 'get',
  path: '/collections',
  tags: ['Collections'],
  summary: 'List all deployed collections',
  description: 'Cached for 60 s.',
  request: {
    query: z.object({
      kind:    z.string().optional().openapi({ description: 'Filter by collection type (normal_721, normal_1155, lazy_721, lazy_1155)' }),
      creator: z.string().optional().openapi({ description: 'Filter by creator address' }),
    }),
  },
  responses: {
    200: { description: 'Collection list', content: { 'application/json': { schema: z.array(CollectionSchema) } } },
  },
});

// GET /creators/:address/collections
registry.registerPath({
  method: 'get',
  path: '/creators/{address}/collections',
  tags: ['Collections'],
  summary: 'Get all collections deployed by a creator',
  request: { params: z.object({ address: z.string().openapi({ description: 'Creator Stellar address' }) }) },
  responses: {
    200: { description: 'Collections by creator', content: { 'application/json': { schema: z.array(CollectionSchema) } } },
  },
});

// GET /wallets/:address/activity
registry.registerPath({
  method: 'get',
  path: '/wallets/{address}/activity',
  tags: ['Wallets'],
  summary: 'Get activity feed for a wallet',
  description: 'Returns events where the address is the `actor` or appears in the event JSON payload (buyer, artist, offerer, bidder, winner, creator). Rate-limited to 20 req/min.',
  request: {
    params: z.object({ address: z.string().openapi({ description: 'Wallet Stellar address' }) }),
    query:  z.object({
      limit: z.coerce.number().int().nonnegative().max(200).optional().openapi({ description: 'Max results (default 50, max 200)' }),
    }),
  },
  responses: {
    200: { description: 'Wallet event feed', content: { 'application/json': { schema: z.array(MarketplaceEventSchema) } } },
  },
});

// GET /wallets/:address/royalty-stats
registry.registerPath({
  method: 'get',
  path: '/wallets/{address}/royalty-stats',
  tags: ['Wallets'],
  summary: 'Get royalty earnings summary for an artist',
  description: 'Calculates total royalties earned from secondary sales. Rate-limited to 20 req/min.',
  request: { params: z.object({ address: z.string().openapi({ description: 'Artist Stellar address' }) }) },
  responses: {
    200: { description: 'Royalty statistics', content: { 'application/json': { schema: RoyaltyStatsSchema } } },
  },
});

// GET /wallets/:address/royalty-breakdown
registry.registerPath({
  method: 'get',
  path: '/wallets/{address}/royalty-breakdown',
  tags: ['Wallets'],
  summary: 'Get the per-sale royalty payout audit trail for a recipient',
  description: 'Paginated RoyaltyPayment rows sourced from on-chain ROYALTY_PAID events, newest-first. Supports an inclusive ledger-sequence window via `from`/`to`. Cached for 60 seconds.',
  request: {
    params: z.object({ address: z.string().openapi({ description: 'Recipient Stellar address' }) }),
    query: z.object({
      from:   z.number().int().optional().openapi({ description: 'Inclusive lower ledger-sequence bound' }),
      to:     z.number().int().optional().openapi({ description: 'Inclusive upper ledger-sequence bound' }),
      limit:  z.number().int().optional().openapi({ description: 'Page size (default 50, max 1000)' }),
      offset: z.number().int().optional().openapi({ description: 'Rows to skip (max 10000)' }),
    }),
  },
  responses: {
    200: { description: 'Royalty payout breakdown', content: { 'application/json': { schema: RoyaltyBreakdownSchema } } },
  },
});

// GET /stats
registry.registerPath({
  method: 'get',
  path: '/stats',
  tags: ['Stats'],
  summary: 'Get marketplace statistics',
  description: 'Aggregate counts and volumes. Supports an optional time window via `range` shorthand or explicit `from`/`to` ISO 8601 dates.',
  request: {
    query: z.object({
      range: z.enum(['day', 'week', 'month']).optional().openapi({ description: 'Shorthand time window (last 24 h / 7 d / 30 d)' }),
      from:  z.string().optional().openapi({ format: 'date-time', description: 'Window start (ISO 8601). Ignored when `range` is set.' }),
      to:    z.string().optional().openapi({ format: 'date-time', description: 'Window end (ISO 8601). Ignored when `range` is set.' }),
    }),
  },
  responses: {
    200: { description: 'Marketplace statistics', content: { 'application/json': { schema: StatsSchema } } },
    400: { description: 'Invalid date format', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /artists/:address/metrics
registry.registerPath({
  method: 'get',
  path: '/artists/{address}/metrics',
  tags: ['Artists'],
  summary: 'Get per-artist performance metrics',
  description: 'Returns sales volume, conversion rate, unique buyers, and a daily sales timeline. Cached for 60 s.',
  request: {
    params: z.object({ address: z.string().openapi({ description: 'Artist Stellar address' }) }),
    query:  z.object({
      range: z.enum(['day', 'week', 'month']).optional().openapi({ description: 'Time window (default: all time)' }),
    }),
  },
  responses: {
    200: { description: 'Artist metrics', content: { 'application/json': { schema: ArtistMetricsSchema } } },
  },
});

// GET /events (SSE)
registry.registerPath({
  method: 'get',
  path: '/events',
  tags: ['System'],
  summary: 'Server-Sent Events stream',
  description: 'Real-time event stream using SSE. Supports `Last-Event-Id` header for replay of up to the last 200 events. Returns 503 when the connection limit is reached.',
  responses: {
    200: {
      description: 'SSE stream (text/event-stream)',
      content: { 'text/event-stream': { schema: { type: 'string' } } },
    },
    503: { description: 'Too many SSE connections', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /health
registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['System'],
  summary: 'Liveness probe',
  responses: {
    200: {
      description: 'Service is alive',
      content: {
        'application/json': {
          schema: z.object({ status: z.literal('ok') }),
        },
      },
    },
  },
});

// GET /readyz
registry.registerPath({
  method: 'get',
  path: '/readyz',
  tags: ['System'],
  summary: 'Readiness probe',
  description: 'Returns 503 until at least one ledger has been indexed, or if the indexer has stalled.',
  responses: {
    200: {
      description: 'Service is ready',
      content: {
        'application/json': {
          schema: z.object({
            status:      z.literal('ready'),
            lastLedger:  z.number().int(),
          }),
        },
      },
    },
    503: {
      description: 'Service is not ready or stalled',
      content: {
        'application/json': {
          schema: z.object({
            status:  z.string().openapi({ example: 'not_ready' }),
            reasons: z.array(z.string()).optional(),
            reason:  z.string().optional(),
          }),
        },
      },
    },
  },
});

// GET /metrics
registry.registerPath({
  method: 'get',
  path: '/metrics',
  tags: ['System'],
  summary: 'Prometheus metrics',
  description: 'Exposes `http_request_duration_seconds`, `latest_ledger_processed`, `network_latest_ledger`, and `sync_latency_ledgers` metrics.',
  responses: {
    200: {
      description: 'Prometheus text format',
      content: { 'text/plain': { schema: { type: 'string' } } },
    },
  },
});

// ── Generator ─────────────────────────────────────────────────────────────────

// GET /health/details
registry.registerPath({
  method: 'get',
  path: '/health/details',
  tags: ['System'],
  summary: 'Full diagnostics (operator only)',
  description: 'Returns detailed health information. Requires X-Operator-Token header. Returns 401/403 without valid credentials.',
  security: [{ operatorToken: [] }],
  responses: {
    200: { description: 'Detailed health', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /reconciliation/status
registry.registerPath({
  method: 'get',
  path: '/reconciliation/status',
  tags: ['Operational'],
  summary: 'Reconciliation status (operator only)',
  description: 'Returns the last reconciliation run with counts and discrepancies. Requires operator token.',
  security: [{ operatorToken: [] }],
  responses: {
    200: { description: 'Reconciliation status', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /backfill/status
registry.registerPath({
  method: 'get',
  path: '/backfill/status',
  tags: ['Operational'],
  summary: 'Backfill job status (operator only)',
  description: 'Returns the current state of any running backfill job. Requires operator token.',
  security: [{ operatorToken: [] }],
  responses: {
    200: { description: 'Backfill status', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /keeper/status
registry.registerPath({
  method: 'get',
  path: '/keeper/status',
  tags: ['Operational'],
  summary: 'Keeper operational state (operator only)',
  description: 'Returns keeper running state, action counts, and recent actions. Requires operator token.',
  security: [{ operatorToken: [] }],
  responses: {
    200: { description: 'Keeper status', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /sync/gaps
registry.registerPath({
  method: 'get',
  path: '/sync/gaps',
  tags: ['Operational'],
  summary: 'Ledger gap list (operator only)',
  description: 'Returns ledger gaps with summary. Requires operator token.',
  security: [{ operatorToken: [] }],
  request: {
    query: z.object({
      status: z.enum(['Open', 'Repairing', 'Repaired', 'Failed']).optional(),
      source: z.enum(['rpc_window_skip', 'reorg', 'manual']).optional(),
      limit: z.coerce.number().int().positive().max(500).optional(),
      offset: z.coerce.number().int().nonnegative().max(10000).optional(),
    }),
  },
  responses: {
    200: { description: 'Gap list', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /sync/gaps/:id
registry.registerPath({
  method: 'get',
  path: '/sync/gaps/{id}',
  tags: ['Operational'],
  summary: 'Single gap detail (operator only)',
  description: 'Returns a single LedgerGap by ID. Requires operator token.',
  security: [{ operatorToken: [] }],
  request: { params: z.object({ id: z.string().openapi({ description: 'Gap ID' }) }) },
  responses: {
    200: { description: 'Gap detail', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: 'Invalid gap ID', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Gap not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /sync/jobs
registry.registerPath({
  method: 'get',
  path: '/sync/jobs',
  tags: ['Operational'],
  summary: 'Backfill job list (operator only)',
  description: 'Returns recent BackfillJob rows. Requires operator token.',
  security: [{ operatorToken: [] }],
  request: {
    query: z.object({
      status: z.enum(['Pending', 'Running', 'Completed', 'Failed', 'Cancelled']).optional(),
    }),
  },
  responses: {
    200: { description: 'Job list', content: { 'application/json': { schema: z.array(z.record(z.string(), z.unknown())) } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /sync/jobs/:id
registry.registerPath({
  method: 'get',
  path: '/sync/jobs/{id}',
  tags: ['Operational'],
  summary: 'Single backfill job (operator only)',
  description: 'Returns a single BackfillJob by ID. Requires operator token.',
  security: [{ operatorToken: [] }],
  request: { params: z.object({ id: z.string().openapi({ description: 'Job ID' }) }) },
  responses: {
    200: { description: 'Job detail', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: 'Invalid job ID', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Job not found', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /admin/contracts
registry.registerPath({
  method: 'get',
  path: '/admin/contracts',
  tags: ['Admin'],
  summary: 'List tracked contracts (operator only)',
  description: 'Returns all tracked contracts with sync status. Requires operator token.',
  security: [{ operatorToken: [] }],
  responses: {
    200: { description: 'Contract list', content: { 'application/json': { schema: z.array(z.record(z.string(), z.unknown())) } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// POST /admin/contracts
registry.registerPath({
  method: 'post',
  path: '/admin/contracts',
  tags: ['Admin'],
  summary: 'Add tracked contract (operator only)',
  description: 'Add a new contract to track. Body: { contractId, type, label?, startLedger? }. Requires operator token.',
  security: [{ operatorToken: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            contractId: z.string().min(1),
            type: z.enum(['marketplace', 'launchpad']),
            label: z.string().default(''),
            startLedger: z.number().int().min(0).default(0),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: 'Contract created', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    400: { description: 'Invalid request body', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// DELETE /admin/contracts/:id
registry.registerPath({
  method: 'delete',
  path: '/admin/contracts/{id}',
  tags: ['Admin'],
  summary: 'Deactivate tracked contract (operator only)',
  description: 'Deactivate a tracked contract by DB ID. Requires operator token.',
  security: [{ operatorToken: [] }],
  request: { params: z.object({ id: z.string().openapi({ description: 'TrackedContract DB ID' }) }) },
  responses: {
    204: { description: 'Contract deactivated' },
    400: { description: 'Invalid contract ID', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /search
registry.registerPath({
  method: 'get',
  path: '/search',
  tags: ['Search'],
  summary: 'Cross-entity full-text search',
  description: 'Search across listings, auctions, and collections. Supports FTS for queries >= 3 chars, ILIKE fallback for shorter queries.',
  request: {
    query: z.object({
      q: z.string().min(1),
      types: z.string().default('listings,auctions,collections').optional(),
      limit: z.coerce.number().int().positive().max(50).optional().default(10),
    }),
  },
  responses: {
    200: {
      description: 'Search results grouped by entity type',
      content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: 'Invalid query', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /metrics
registry.registerPath({
  method: 'get',
  path: '/metrics',
  tags: ['System'],
  summary: 'Prometheus metrics',
  description: 'Exposes http_request_duration_seconds, latest_ledger_processed, network_latest_ledger, and sync_latency_ledgers.',
  responses: {
    200: {
       description: 'Prometheus text format',
       content: { 'text/plain': { schema: { type: 'string' } } },
     },
  },
});

// GET /openapi.json
registry.registerPath({
  method: 'get',
  path: '/openapi.json',
  tags: ['System'],
  summary: 'OpenAPI specification',
  description: 'Returns the machine-readable API specification.',
  responses: {
    200: {
      description: 'OpenAPI 3.0 document',
      content: { 'application/json': { schema: { type: 'object' } } },
    },
  },
});

// GET /docs
registry.registerPath({
  method: 'get',
  path: '/docs',
  tags: ['System'],
  summary: 'API documentation',
  description: 'Human-readable API documentation page.',
  responses: {
    200: {
      description: 'HTML documentation',
      content: { 'text/html': { schema: { type: 'string' } } },
    },
  },
});

// GET /admin/audit
registry.registerPath({
  method: 'get',
  path: '/admin/audit',
  tags: ['Admin'],
  summary: 'Query audit records (operator only)',
  description: 'Search operational audit log with optional filters. Supports CSV export via ?export=csv. Requires operator token.',
  security: [{ operatorToken: [] }],
  request: {
    query: z.object({
      actor:       z.string().optional(),
      actionType:  z.string().optional(),
      requestId:   z.string().optional(),
      startDate:   z.string().optional(),
      endDate:     z.string().optional(),
      limit:       z.coerce.number().min(1).max(1000).optional(),
      offset:      z.coerce.number().min(0).optional(),
      export:      z.enum(['csv']).optional(),
    }),
  },
  responses: {
    200: { description: 'Audit records with pagination envelope', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /admin/audit/:requestId
registry.registerPath({
  method: 'get',
  path: '/admin/audit/{requestId}',
  tags: ['Admin'],
  summary: 'Get audit record by request ID (operator only)',
  security: [{ operatorToken: [] }],
  request: { params: z.object({ requestId: z.string().openapi({ description: 'Request ID to look up' }) }) },
  responses: {
    200: { description: 'Audit record', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /admin/audit/stats
registry.registerPath({
  method: 'get',
  path: '/admin/audit/stats',
  tags: ['Admin'],
  summary: 'Audit statistics (operator only)',
  description: 'Returns action-type counts and 10 most-recent audit entries. Requires operator token.',
  security: [{ operatorToken: [] }],
  responses: {
    200: { description: 'Audit statistics', content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } } },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /admin/query-cost
registry.registerPath({
  method: 'get',
  path: '/admin/query-cost',
  tags: ['Admin'],
  summary: 'Query cost model diagnostics (operator only)',
  description:
    'Returns the current cost weights, per-tier budgets, and the env-var names used to tune them. ' +
    'No database access — safe to call frequently for observability. Does not expose execution plans or schema.',
  security: [{ operatorToken: [] }],
  responses: {
    200: {
      description: 'Cost model configuration',
      content: {
        'application/json': {
          schema: z.object({
            weights: z.record(z.string(), z.number()).openapi({ description: 'Current cost weight per query dimension' }),
            budgets: z.object({
              public:   z.number().int().openapi({ description: 'Max cost for public/wallet-authed callers' }),
              operator: z.number().int().openapi({ description: 'Max cost for operator-authed callers' }),
            }),
            envVars: z.record(z.string(), z.string()).openapi({ description: 'Env-var names for budget overrides' }),
          }),
        },
      },
    },
    400: {
      description: 'Query too expensive',
      content: {
        'application/json': {
          schema: z.object({
            error: z.object({
              code:    z.literal('QUERY_TOO_EXPENSIVE'),
              message: z.string(),
              details: z.object({
                estimatedCost: z.number().int(),
                budget:        z.number().int(),
                breakdown: z.object({
                  components: z.array(z.object({ reason: z.string(), cost: z.number().int() })),
                  total:      z.number().int(),
                }),
              }).optional(),
            }),
          }),
        },
      },
    },
    401: { description: 'Missing or invalid operator token', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Operator access not allowed from this IP', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /notifications/stream  (SSE — public)
registry.registerPath({
  method: 'get',
  path: '/notifications/stream',
  tags: ['Notifications'],
  summary: 'Real-time notification stream (SSE)',
  description:
    'Wallet-filtered SSE stream of notifiable marketplace events. ' +
    'Accepts optional ?wallet=, ?domain=, ?priority= filters and Last-Event-ID for durable resume. ' +
    'Returns 503 when the notification connection limit is reached.',
  request: {
    query: z.object({
      wallet:      z.string().optional().openapi({ description: 'Filter to events involving this Stellar address' }),
      domain:      z.string().optional().openapi({ description: 'Comma-separated domain filter (listing, auction, offer, …)' }),
      priority:    z.string().optional().openapi({ description: 'Comma-separated priority filter (HIGH, MEDIUM, LOW)' }),
      lastEventId: z.string().optional().openapi({ description: 'Resume from this event ID' }),
    }),
  },
  responses: {
    200: {
      description: 'SSE notification stream (text/event-stream)',
      content: { 'text/event-stream': { schema: { type: 'string' } } },
    },
    503: { description: 'Notification stream at capacity', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /notifications/summary  (public)
registry.registerPath({
  method: 'get',
  path: '/notifications/summary',
  tags: ['Notifications'],
  summary: 'Notification bell summary',
  description: 'Returns the total notification count, urgent count (last 24 h HIGH-priority), and the 5 most-recent notifications for a wallet.',
  request: {
    query: z.object({
      wallet: z.string().openapi({ description: 'Wallet Stellar address (required)' }),
    }),
  },
  responses: {
    200: {
      description: 'Notification summary',
      content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
    },
    400: { description: 'Missing or invalid wallet', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

// GET /wallets/:address/notifications  (authenticated)
registry.registerPath({
  method: 'get',
  path: '/wallets/{address}/notifications',
  tags: ['Wallets', 'Notifications'],
  summary: 'Paginated notification feed for a wallet',
  description:
    'Returns pre-classified IndexerNotification objects for the wallet. ' +
    'Supports optional ?domain= and ?priority= filters. Rate-limited to 20 req/min.',
  request: {
    params: z.object({ address: z.string().openapi({ description: 'Wallet Stellar address' }) }),
    query: z.object({
      limit:    z.coerce.number().int().min(1).max(100).optional().openapi({ description: 'Page size (default 50, max 100)' }),
      offset:   z.coerce.number().int().min(0).optional().openapi({ description: 'Rows to skip' }),
      domain:   z.string().optional().openapi({ description: 'Comma-separated domain filter' }),
      priority: z.string().optional().openapi({ description: 'Comma-separated priority filter (HIGH, MEDIUM, LOW)' }),
    }),
  },
  responses: {
    200: {
      description: 'Notification list',
      content: { 'application/json': { schema: z.array(z.record(z.string(), z.unknown())) } },
    },
    400: { description: 'Invalid wallet address', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

const securitySchemes = {
  operatorToken: {
    type: 'apiKey',
    in: 'header' as const,
    name: 'X-Operator-Token',
  },
};

const generator = new OpenApiGeneratorV3(registry.definitions);

export function buildOpenApiDocument() {
  // Cast to `any` to accommodate the version difference between
  // OpenAPIObjectConfig types across @asteasolutions/zod-to-openapi versions.
  const doc = generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'ElcareHub Indexer API',
      description:
        'Off-chain event indexer and REST API for the ElcareHub NFT marketplace on Stellar Soroban. ' +
        'All BigInt values (IDs, endTime) are serialised as decimal strings.',
      version: '1.0.0',
      contact: { name: 'ElcareHub', url: 'https://elcarehub.io' },
    },
    servers: [
      { url: 'http://localhost:4000', description: 'Local development' },
      { url: 'https://indexer.elcarehub.io', description: 'Production' },
    ],
  } as any);

  // Inject securitySchemes and global security into the generated document.
  if (!doc.components) (doc as any).components = {};
  (doc as any).components.securitySchemes = securitySchemes;
  (doc as any).security = [{ operatorToken: [] }];

  return doc;
}
