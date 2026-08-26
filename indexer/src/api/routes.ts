import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import redis from '../redis.js';
import { Prisma } from '@prisma/client';
import { cacheMiddleware } from './cache-middleware.js';
import { etagMiddleware } from './etag-middleware.js';
import { strictRateLimiter, sseConcurrencyGuard, heavyRateLimiter, lightRateLimiter, mediumRateLimiter, operationalRateLimiter } from './rate-limit-middleware.js';
import { badRequest, notFound, internalError } from './errors.js';
import {
  versioningMiddleware,
  ok,
  validateResponse,
  ListingResponseV1,
  AuctionResponseV1,
  OfferResponseV1,
  CollectionResponseV1,
} from './versioning.js';
import { requestIdMiddleware } from './request-id-middleware.js';
import { applyDecodedEvents, isPollerHalted, getHaltReason, resumePoller, revertLedgers } from '../poller.js';
import { collectMarketplaceEvents } from '../event-sync.js';
import {
  validateQuery,
  listingsQuerySchema,
  auctionsQuerySchema,
  offersQuerySchema,
  walletActivityQuerySchema,
  collectionsQuerySchema,
  creatorCollectionsQuerySchema,
  statsQuerySchema,
  syncGapsQuerySchema,
  artistMetricsQuerySchema,
  royaltyBreakdownQuerySchema,
  searchQuerySchema,
  eventsQuerySchema,
} from './query-schemas.js';
import { isValidStellarAddress, STELLAR_ADDRESS_ERROR } from '../stellar-address.js';
import {
  getOverviewStats,
  getDailyStats,
  getTopCollections,
  getTopArtists,
} from '../stats.js';
import { fetchAuctionConfig, AuctionConfig } from '../chain-state.js';
import { rpc } from '@stellar/stellar-sdk';
import { apiRequestDurationHistogram } from '../metrics.js';
import { TTL } from '../cache-warmer.js';
import { withDecimalAmounts } from '../token-metadata.js';
import { authMiddleware } from './auth-middleware.js';
import { queryCostGuard, handleQueryCostDiagnostics } from './query-cost.js';
import { getCached as getCachedService } from './cache-service.js';
import { logger } from '../logger.js';


// ── SSE registry ───────────────────────────────────────────────────────────────
//
// Maintains a bounded in-memory replay buffer and a set of active SSE clients.
// When a client reconnects with `Last-Event-ID` it receives any missed events
// from the buffer before switching to live delivery.
//
// ID scheme: monotonic integer counter (local/degraded mode). The RealtimeHub
// (realtime/index.ts) takes over when Redis is available, using Redis Stream ids.

const SSE_BUFFER_SIZE = parseInt(process.env.SSE_LOCAL_BUFFER_SIZE || '200');
const MAX_SSE_CONNECTIONS = parseInt(process.env.MAX_SSE_CONNECTIONS || '500');

interface SSEEvent {
  id: string;
  data: string;
  eventType?: string;
  listingId?: string | null;
}

let sseEventCounter = 0;
const sseBuffer: SSEEvent[] = [];
const sseClients: Map<Response, string> = new Map(); // value = last-sent event id

function nextSseId(): string {
  return String(++sseEventCounter);
}

// Exposed for testing only
export function _getSseBuffer() { return sseBuffer; }
export function _getSseEventCounter() { return sseEventCounter; }
export function _resetSseState() {
  sseEventCounter = 0;
  sseBuffer.length = 0;
  sseClients.clear();
}

/** Emit a `: heartbeat` comment on a response, cleaning up on write failure. */
function setupSSEHeartbeat(res: Response): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { cleanupSSEClient(res); }
  }, 30_000);
}

function cleanupSSEClient(res: Response): void {
  sseClients.delete(res);
}

/**
 * Emit `event` to all connected SSE clients and append to the replay buffer.
 *
 * Events carry a monotonically increasing numeric id so clients can resume
 * from the exact point they disconnected using the `Last-Event-ID` header.
 *
 * Reorg-correction events use `event: reorg` so consumers can distinguish
 * them from data events and trigger local state resets.
 */
export function emitSSEEvent(event: any) {
  const id = nextSseId();
  const dataStr = JSON.stringify(event, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
  const eventType: string | undefined = typeof event?.eventType === 'string' ? event.eventType : undefined;
  const listingId: string | null = event?.listingId != null ? String(event.listingId) : null;

  const payload: SSEEvent = { id, data: dataStr, eventType, listingId };

  // Bounded replay buffer — evict oldest entry when full.
  sseBuffer.push(payload);
  if (sseBuffer.length > SSE_BUFFER_SIZE) sseBuffer.shift();

  // Build the SSE frame. Reorg events get a named `event:` field so clients
  // can register a dedicated listener and clear local cache state.
  const isReorg = eventType === 'REORG' || eventType === 'CRITICAL_REORG';
  const frame = isReorg
    ? `id: ${id}\nevent: reorg\ndata: ${dataStr}\n\n`
    : `id: ${id}\ndata: ${dataStr}\n\n`;

  for (const [client] of sseClients) {
    try {
      client.write(frame);
      sseClients.set(client, id);
    } catch {
      cleanupSSEClient(client);
    }
  }
}

export function closeSSEClients(): void {
  for (const [client] of sseClients) {
    try { client.end(); } catch { /* ignore */ }
  }
  sseClients.clear();
}

// ── API request duration middleware ───────────────────────────────────────────
// Records per-route latency histogram with method / route / status_code labels.

export function apiDurationMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime();
  res.on('finish', () => {
    const [s, ns] = process.hrtime(start);
    const route = req.route ? (req.baseUrl || '') + req.route.path : req.path;
    apiRequestDurationHistogram
      .labels(req.method, route, String(res.statusCode))
      .observe(s + ns / 1e9);
  });
  next();
}

const router = Router();

// ── Per-request middlewares (applied to every route in order) ─────────────────
// requestIdMiddleware must come first so all downstream log lines carry the id.
router.use(requestIdMiddleware);
router.use(versioningMiddleware);
router.use(etagMiddleware);
router.use(apiDurationMiddleware);

const CACHE_TTL_SECONDS = parseInt(process.env.REDIS_CACHE_TTL_SECONDS || '30');

/**
 * getCached — thin wrapper over the cache-service that adds thundering-herd
 * protection. Popular keys (stats, recent activity) benefit from the
 * distributed lock option.
 */
async function getCached<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
  opts: { distributed?: boolean } = {},
): Promise<T> {
  return getCachedService(key, ttl, fetcher, opts);
}

const serialize = (obj: any) =>
  JSON.parse(JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  ));
// ── Raw + human-readable money fields (Issue #282) ────────────────────────────
//
// Listing/Auction/Offer rows carry raw on-chain base-unit amounts (see
// token-metadata.ts for why the Decimal(32,7) columns are NOT already
// human-scaled). These helpers serialize a row/array and attach a
// `<field>Decimal` sibling for every money field, computed from the row's
// own `token` address, so API consumers get both the raw and human forms
// without guessing at precision.
const LISTING_MONEY_FIELDS = [['price', 'token']] as const;
const AUCTION_MONEY_FIELDS = [
  ['reservePrice', 'token'],
  ['highestBid', 'token'],
] as const;
const OFFER_MONEY_FIELDS = [['amount', 'token']] as const;

const serializeListing = (row: any) => withDecimalAmounts(serialize(row), LISTING_MONEY_FIELDS);
const serializeListings = (rows: any[]) => serialize(rows).map((row: any) => withDecimalAmounts(row, LISTING_MONEY_FIELDS));
const serializeAuction = (row: any) => withDecimalAmounts(serialize(row), AUCTION_MONEY_FIELDS);
const serializeAuctions = (rows: any[]) => serialize(rows).map((row: any) => withDecimalAmounts(row, AUCTION_MONEY_FIELDS));
const serializeOffers = (rows: any[]) => serialize(rows).map((row: any) => withDecimalAmounts(row, OFFER_MONEY_FIELDS));

// ── GET /events (SSE) ─────────────────────────────────────────────────────────

router.get('/events', sseConcurrencyGuard, validateQuery(eventsQuerySchema), (req: Request, res: Response) => {
  if (sseClients.size >= MAX_SSE_CONNECTIONS) {
    return res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Too many SSE connections', class: 'CLIENT_ERROR' } });
  }

  // Parse validated query params for filtering and resume
  const { types: typesParam, listingId: listingIdParam, lastEventId: queryLastEventId } = (req as any).validatedQuery ?? {};

  // Topic and listing filters — undefined means "accept all"
  const typeFilter: Set<string> | undefined = typesParam
    ? new Set(String(typesParam).split(',').map((t: string) => t.trim()).filter(Boolean))
    : undefined;
  const listingIdFilter: string | undefined = listingIdParam ? String(listingIdParam) : undefined;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Determine resume cursor — Last-Event-ID header takes precedence over ?lastEventId=
  const headerLastId = req.headers['last-event-id'];
  const resumeFrom: string | null = (headerLastId ? String(headerLastId) : null) ?? (queryLastEventId ? String(queryLastEventId) : null);

  sseClients.set(res, resumeFrom ?? '0');

  // Replay missed events from the buffer when the client provides a resume cursor.
  if (resumeFrom !== null) {
    const resumeNum = parseInt(resumeFrom, 10);
    const missed = sseBuffer.filter((e) => {
      const eventNum = parseInt(e.id, 10);
      if (isNaN(eventNum) || eventNum <= resumeNum) return false;
      if (typeFilter && e.eventType && !typeFilter.has(e.eventType)) return false;
      if (listingIdFilter !== undefined && String(e.listingId ?? '') !== listingIdFilter) return false;
      return true;
    });

    for (const ev of missed) {
      const isReorg = ev.eventType === 'REORG' || ev.eventType === 'CRITICAL_REORG';
      const frame = isReorg
        ? `id: ${ev.id}\nevent: reorg\ndata: ${ev.data}\n\n`
        : `id: ${ev.id}\ndata: ${ev.data}\n\n`;
      try { res.write(frame); } catch { break; }
    }

    // Signal "cursor too old" when all buffered events are newer than the cursor,
    // meaning the client missed more events than the buffer holds — it must
    // trigger a full page-reload / re-fetch rather than a delta apply.
    if (
      missed.length === 0 &&
      sseBuffer.length > 0 &&
      parseInt(sseBuffer[0].id, 10) > resumeNum
    ) {
      res.write(
        `event: reset\ndata: ${JSON.stringify({ reason: 'cursor_too_old', since: resumeFrom })}\n\n`,
      );
    }
  }

  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', requestId: res.locals.requestId })}\n\n`);

  const heartbeat = setupSSEHeartbeat(res);

  const cleanup = () => {
    clearInterval(heartbeat);
    cleanupSSEClient(res);
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
});

// ── GET /listings ─────────────────────────────────────────────────────────────
//
// Full-text search strategy:
//   - search term < 3 chars  → ILIKE fallback on artist + collection fields
//   - search term >= 3 chars → ts_rank on searchVector (GIN index), results
//                              ordered by relevance descending then by
//                              updatedAtLedger for tie-breaking

/** Minimum search term length to trigger tsvector path. */
const FTS_MIN_LENGTH = 3;

/**
 * Escape a user string so it is safe to embed in a plainto_tsquery /
 * to_tsquery call.  Strips characters that have special meaning in tsquery
 * syntax (&, |, !, :, <, >, (, )) and trims whitespace.
 */
function sanitiseTsQuery(raw: string): string {
  return raw.replace(/[&|!:<>()]/g, ' ').trim();
}

router.get('/listings', lightRateLimiter, cacheMiddleware(TTL.LISTINGS_LIST), queryCostGuard(), validateQuery(listingsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { artist, owner, status, limit, offset, minPrice, maxPrice, search, cursor_ledger, cursor_direction } =
    (req as any).validatedQuery;
  try {
    const where: any = {};
    if (artist) where.artist = artist;
    if (owner) where.owner = owner;

    // status=expired is a virtual filter: Cancelled listings whose
    // LISTING_CANCELLED event carries reason.Expired (tag 2).
    let expiredIds: bigint[] | null = null;
    if (status === 'expired') {
      const rows: any[] = await prisma.$queryRawUnsafe(
        `SELECT DISTINCT "listingId" FROM "MarketplaceEvent"
         WHERE "eventType" = 'LISTING_CANCELLED'
           AND data->'reason'->>'tag' = '2'`
      );
      expiredIds = rows.map((r: any) => r.listingId);
      if (expiredIds.length === 0) {
        return res.json([]);
      }
      where.listingId = { in: expiredIds };
      where.status = 'Cancelled';
    } else if (status) {
      where.status = status;
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      where.price = {};
      if (minPrice !== undefined) where.price.gte = String(minPrice);
      if (maxPrice !== undefined) where.price.lte = String(maxPrice);
    }

    // ── Cursor pagination ─────────────────────────────────────────────────
    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    if (cursor_ledger !== undefined) {
      where.updatedAtLedger = direction === 'desc'
        ? { lt: cursor_ledger }
        : { gt: cursor_ledger };
    }

    const take = limit ?? 20;
    const skip = cursor_ledger !== undefined ? 0 : (offset ?? 0);

    // ── Full-text search ──────────────────────────────────────────────────
    if (search && search.length >= FTS_MIN_LENGTH) {
      // Build a safe plainto_tsquery expression.  plainto_tsquery handles
      // phrase tokenisation automatically and never throws on malformed input.
      const sanitised = sanitiseTsQuery(search);

      // Construct the additional Prisma filters as raw-SQL fragments so we can
      // combine them with the ts_rank ORDER BY.
      // We build the WHERE conditions from the `where` object manually for the
      // raw query so we can inject the tsquery predicate.

      const filterClauses: string[] = [
        `"searchVector" @@ plainto_tsquery('english', $1)`,
      ];
      const params: unknown[] = [sanitised];
      let pIdx = 2;

      if (artist)   { filterClauses.push(`"artist" = $${pIdx++}`);  params.push(artist); }
      if (owner)    { filterClauses.push(`"owner" = $${pIdx++}`);   params.push(owner); }
      if (status)   { filterClauses.push(`"status" = $${pIdx++}::"ListingStatus"`); params.push(status); }
      if (minPrice !== undefined) { filterClauses.push(`"price" >= $${pIdx++}`); params.push(String(minPrice)); }
      if (maxPrice !== undefined) { filterClauses.push(`"price" <= $${pIdx++}`); params.push(String(maxPrice)); }
      if (cursor_ledger !== undefined) {
        filterClauses.push(
          direction === 'desc'
            ? `"updatedAtLedger" < $${pIdx++}`
            : `"updatedAtLedger" > $${pIdx++}`
        );
        params.push(cursor_ledger);
      }

      const whereSQL = filterClauses.length ? `WHERE ${filterClauses.join(' AND ')}` : '';

      // ts_rank_cd is the coverage-density variant; it rewards documents where
      // the query terms are near each other.  Normalisation option 1 divides
      // rank by the document length to avoid bias toward longer descriptions.
      const results: any[] = await prisma.$queryRawUnsafe(
        `SELECT *,
                ts_rank_cd("searchVector", plainto_tsquery('english', $1), 1) AS "_rank"
         FROM "Listing"
         ${whereSQL}
         ORDER BY "_rank" DESC, "updatedAtLedger" ${direction === 'desc' ? 'DESC' : 'ASC'}
         LIMIT ${take} OFFSET ${skip}`,
        ...params
      );

      const [{ count }] = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(*) as count FROM "Listing" ${whereSQL}`,
        ...params
      );

      const nextCursor = results.length === take
        ? String(results[results.length - 1].updatedAtLedger)
        : '';

      res.setHeader('X-Next-Cursor', nextCursor);
      res.setHeader('X-Total-Count', String(count));
      return res.json({ listings: serialize(results), total: Number(count) });
    }

    // ── Short-term ILIKE fallback (<3 chars) or no search ────────────────
    if (search) {
      where.OR = [
        { artist:     { contains: search, mode: 'insensitive' } },
        { collection: { contains: search, mode: 'insensitive' } },
        { title:      { contains: search, mode: 'insensitive' } },
        { artistName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [results, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        orderBy: { updatedAtLedger: direction },
        take,
        skip,
      }),
      prisma.listing.count({ where: { ...where, updatedAtLedger: undefined } }),
    ]);

    const nextCursor = results.length === take
      ? String(results[results.length - 1].updatedAtLedger)
      : '';

    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));

    // When search is active always return { listings, total } shape
    // (consistent with the FTS path above).
    if (search) {
      return res.json({ listings: serialize(results), total });
    }

    if (limit !== undefined || offset !== undefined || cursor_ledger !== undefined) {
      const validated = validateResponse(z.object({ listings: ListingResponseV1.array(), total: z.number() }), {
        listings: serialize(results),
        total: Number(total),
      });
      return ok(res, validated);
    }
    const validated = validateResponse(ListingResponseV1.array(), serialize(results));
    return ok(res, validated);
  } catch (err) {
    next(internalError('Failed to fetch listings'));
  }
});

// ── GET /listings/:id ─────────────────────────────────────────────────────────

router.get('/listings/:id', lightRateLimiter, cacheMiddleware(TTL.LISTING_DETAIL), queryCostGuard({ hasJoin: true }), async (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;
  try {
    const listing = await prisma.listing.findUnique({
      where: { listingId: BigInt(id as string) },
    });
    if (!listing) return next(notFound('Listing not found'));

    // Attach cached IPFS metadata when available, or null if still pending.
    const ipfsMetadata = listing.token
      ? await (prisma as any).ipfsMetadata.findUnique({ where: { cid: listing.token } }).catch(() => null)
      : null;

    return res.json(serializeListing({ ...listing, ipfsMetadata: ipfsMetadata ?? null }));
  } catch (err) {
    next(internalError('Failed to fetch listing details'));
  }
});

// ── GET /listings/:id/history ─────────────────────────────────────────────────

router.get('/listings/:id/history', heavyRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id as string;
  if (!/^\d+$/.test(id)) {
    return next(badRequest('Invalid ID format'));
  }

  const limitRaw  = req.query.limit  as string | undefined;
  const offsetRaw = req.query.offset as string | undefined;

  const limitParsed  = limitRaw  !== undefined ? parseInt(limitRaw,  10) : 100;
  const offsetParsed = offsetRaw !== undefined ? parseInt(offsetRaw, 10) : 0;

  if (limitRaw !== undefined  && (!Number.isInteger(limitParsed)  || limitParsed  < 1)) {
    return next(badRequest('limit must be a positive integer'));
  }
  if (offsetRaw !== undefined && (!Number.isInteger(offsetParsed) || offsetParsed < 0)) {
    return next(badRequest('offset must be a non-negative integer'));
  }

  const limit  = Math.min(limitParsed, 500);
  const offset = Math.min(offsetParsed, 10_000);

  try {
    const where: any = { listingId: BigInt(id) };
    // Issue #286: optional filter for confirmed-only events
    const confirmedOnly = (req.query as any).confirmed === 'true';
    if (confirmedOnly) {
      where.confirmed = true;
    }
    const [results, total] = await Promise.all([
      prisma.marketplaceEvent.findMany({
        where,
        orderBy: { ledgerSequence: 'asc' },
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceEvent.count({ where }),
    ]);
    res.json({ events: serialize(results), total });
  } catch (err) {
    next(internalError('Failed to fetch listing history'));
  }
});

// ── GET /listings/:id/price-history (Issue #213) ──────────────────────────────
//
// Returns every price-change event for a listing in chronological order.
// Each row carries oldPrice, newPrice, changedBy (artist address), the ledger
// sequence, and the wall-clock timestamp so the frontend can render a chart.

router.get('/listings/:id/price-history', lightRateLimiter, cacheMiddleware(60), async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id as string;
  if (!/^\d+$/.test(id)) {
    return next(badRequest('Invalid listing ID format'));
  }

  try {
    const history = await prisma.priceHistory.findMany({
      where: { listingId: BigInt(id) },
      orderBy: { changedAtLedger: 'asc' },
      select: {
        id: true,
        listingId: true,
        oldPrice: true,
        newPrice: true,
        changedBy: true,
        changedAtLedger: true,
        changedAt: true,
      },
    });
    res.json(serialize(history));
  } catch (err) {
    next(internalError('Failed to fetch price history'));
  }
});


//
// Serves cached IPFS metadata for a given CID.  If the metadata is not yet
// cached, fetches it on-demand (populating the cache), enqueues a background
// refresh job, and returns the result.  Returns 404 when the content cannot be
// fetched from any gateway.

router.get('/ipfs/:cid', mediumRateLimiter, cacheMiddleware(300), async (req: Request, res: Response, next: NextFunction) => {
  const cid = req.params.cid as string;
  if (!cid || !/^[a-zA-Z0-9]+$/.test(cid)) {
    return next(badRequest('Invalid CID format'));
  }

  try {
    // 1. Serve from cache if available
    const cached = await (prisma as any).ipfsMetadata.findUnique({ where: { cid } });
    if (cached) {
      return res.json(serialize(cached));
    }

    // 2. On-demand fetch and cache (for direct /ipfs/:cid requests)
    let raw: Record<string, unknown>;
    try {
      const { fetchIpfsMetadata: _fetch } = await import('../ipfs-cache.js').catch(() => ({ fetchIpfsMetadata: null }));
      if (!_fetch) return next(notFound('IPFS content not available'));
      raw = (await _fetch(cid)) as unknown as Record<string, unknown>;
    } catch {
      return next(notFound('IPFS content not available'));
    }

    const stored = await (prisma as any).ipfsMetadata.upsert({
      where: { cid },
      create: {
        cid,
        title: typeof raw.title === 'string' ? raw.title : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        imageUrl: typeof raw.image === 'string'
          ? raw.image
          : typeof raw.imageUrl === 'string' ? raw.imageUrl : undefined,
        attributes: raw.attributes != null ? (raw.attributes as Prisma.InputJsonValue) : Prisma.JsonNull,
        raw: raw as Prisma.InputJsonValue,
      },
      update: {
        title: typeof raw.title === 'string' ? raw.title : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        imageUrl: typeof raw.image === 'string'
          ? raw.image
          : typeof raw.imageUrl === 'string' ? raw.imageUrl : undefined,
        attributes: raw.attributes != null ? (raw.attributes as Prisma.InputJsonValue) : Prisma.JsonNull,
        fetchedAt: new Date(),
        raw: raw as Prisma.InputJsonValue,
      },
    });

    // 3. Ensure a queue entry exists for future refreshes (fire-and-forget)
    import('../ipfs-cache.js')
      .then(({ enqueueIpfsFetch }) => enqueueIpfsFetch?.(cid)?.catch(() => {}))
      .catch(() => {});

    return res.json(serialize(stored));
  } catch (err) {
    next(internalError('Failed to fetch IPFS metadata'));
  }
});

// ── GET /auctions ─────────────────────────────────────────────────────────────

router.get('/auctions', lightRateLimiter, cacheMiddleware(TTL.AUCTIONS_LIST), queryCostGuard(), validateQuery(auctionsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { creator, status, limit, offset, cursor_ledger, cursor_direction } = (req as any).validatedQuery;
  try {
    const where: any = {};
    if (creator) where.creator = creator;
    if (status) where.status = status;

    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    if (cursor_ledger !== undefined) {
      where.updatedAtLedger = direction === 'desc' ? { lt: cursor_ledger } : { gt: cursor_ledger };
    }

    const take = limit ?? 20;
    const skip = cursor_ledger !== undefined ? 0 : (offset ?? 0);

    const [results, total] = await Promise.all([
      prisma.auction.findMany({ where, orderBy: { updatedAtLedger: direction }, take, skip }),
      prisma.auction.count({ where: { ...(creator ? { creator } : {}), ...(status ? { status } : {}) } }),
    ]);

    const nextCursor = results.length === take ? String(results[results.length - 1].updatedAtLedger) : '';
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));
    res.json(serializeAuctions(results));
  } catch (err) {
    next(internalError('Failed to fetch auctions'));
  }
});

// ── GET /auctions/:id ─────────────────────────────────────────────────────────

router.get('/auctions/:id', lightRateLimiter, cacheMiddleware(TTL.AUCTION_DETAIL), queryCostGuard({ hasJoin: true }), async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id as string;
  if (!/^\d+$/.test(id)) {
    return next(badRequest('Invalid ID format'));
  }
  try {
    const result = await prisma.auction.findUnique({
      where: { auctionId: BigInt(id) },
    });
    if (!result) return next(notFound('Auction not found'));

    const bids = await prisma.bid.findMany({
      where: { auctionId: BigInt(id) },
      orderBy: [{ ledgerSequence: 'desc' }, { id: 'desc' }],
    });
    res.json(serialize({ ...result, bids }));
  } catch (err) {
    next(internalError('Failed to fetch auction'));
  }
});

// ── GET /auctions/:id/blocked-bidders ─────────────────────────────────────────
//
// Anti-shill-bidding registry (Issue #199).  Replays the auction's
// AUCTION_BIDDER_BLOCKED / AUCTION_BIDDER_UNBLOCKED events in ledger order to
// compute the currently-blocked address set, and returns the raw event history
// alongside it for audit views.

router.get('/auctions/:id/blocked-bidders', lightRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const id = req.params.id as string;
  if (!/^\d+$/.test(id)) {
    return next(badRequest('Invalid ID format'));
  }
  try {
    const events = await prisma.marketplaceEvent.findMany({
      where: {
        listingId: BigInt(id),
        eventType: { in: ['AUCTION_BIDDER_BLOCKED', 'AUCTION_BIDDER_UNBLOCKED'] },
      },
      orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
    });

    const blocked = new Set<string>();
    for (const ev of events) {
      const bidder = (ev.data as Record<string, unknown> | null)?.bidder;
      if (typeof bidder !== 'string') continue;
      if (ev.eventType === 'AUCTION_BIDDER_BLOCKED') blocked.add(bidder);
      else blocked.delete(bidder);
    }

    res.json({
      auctionId: id,
      blockedBidders: [...blocked],
      history: serialize(events),
    });
  } catch (err) {
    next(internalError('Failed to fetch blocked bidders'));
  }
});

// ── GET /offers ───────────────────────────────────────────────────────────────

router.get('/offers', lightRateLimiter, queryCostGuard(), validateQuery(offersQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { listing_id, limit, offset, cursor_ledger, cursor_direction } = (req as any).validatedQuery;
  try {
    const where: any = {};
    if (listing_id) where.listingId = BigInt(listing_id);

    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    if (cursor_ledger !== undefined) {
      where.updatedAtLedger = direction === 'desc' ? { lt: cursor_ledger } : { gt: cursor_ledger };
    }

    const take = limit ?? 20;
    const skip = cursor_ledger !== undefined ? 0 : (offset ?? 0);

    const [results, total] = await Promise.all([
      prisma.offer.findMany({ where, orderBy: { updatedAtLedger: direction }, take, skip }),
      prisma.offer.count({ where: listing_id ? { listingId: BigInt(listing_id) } : {} }),
    ]);

    const nextCursor = results.length === take ? String(results[results.length - 1].updatedAtLedger) : '';
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));
    res.json(serializeOffers(results));
  } catch (err) {
    next(internalError('Failed to fetch offers'));
  }
});

// ── GET /activity/recent ──────────────────────────────────────────────────────

router.get('/activity/recent', cacheMiddleware(TTL.ACTIVITY_RECENT), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const results = await getCached('activity:recent', TTL.ACTIVITY_RECENT, () =>
      prisma.marketplaceEvent.findMany({
        take: 20,
        orderBy: { ledgerSequence: 'desc' },
      }),
      { distributed: true },
    );
    res.json(serialize(results));
  } catch (err) {
    next(internalError('Failed to fetch recent activity'));
  }
});

// ── GET /collections ──────────────────────────────────────────────────────────

router.get('/collections', lightRateLimiter, cacheMiddleware(TTL.COLLECTIONS), queryCostGuard(), validateQuery(collectionsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { kind, creator, limit, offset, cursor_ledger, cursor_direction } = (req as any).validatedQuery;
  try {
    const where: any = {};
    if (kind)    where.kind    = kind;
    if (creator) where.creator = creator;

    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    if (cursor_ledger !== undefined) {
      where.deployedAtLedger = direction === 'desc' ? { lt: cursor_ledger } : { gt: cursor_ledger };
    }

    const take = limit ?? 20;
    const skip = cursor_ledger !== undefined ? 0 : (offset ?? 0);

    const results = await prisma.collection.findMany({ where, orderBy: { deployedAtLedger: direction }, take, skip });
    const total = prisma.collection.count ? await prisma.collection.count({ where: { ...(kind ? { kind } : {}), ...(creator ? { creator } : {}) } }) : results.length;

    const nextCursor = results.length === take ? String(results[results.length - 1].deployedAtLedger) : '';
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));

    // Attach a resolved fee_bps field: collection override when set, otherwise null
    // (clients should fall back to the global fee from GET /stats or contract view).
    // Also include metadataFrozen field for frontend freeze controls.
    const withFee = results.map((c) => ({
      ...c,
      fee_bps: c.feeBpsOverride ?? null,
      metadataFrozen: c.metadataFrozen ?? false,
    }));

    res.json(serialize(withFee));
  } catch (err) {
    next(internalError('Failed to fetch collections'));
  }
});

// ── GET /collections/:address/fee ─────────────────────────────────────────────
// Returns the per-collection fee override for a given collection contract
// address, or null when the collection is using the global default fee.
// Response is Redis-cached with a 30-second TTL.

router.get('/collections/:address/fee', lightRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  if (!address) return next(badRequest('Collection address is required'));

  const cacheKey = `collection_fee:${address}`;
  try {
    const result = await getCached(cacheKey, 30, async () => {
      const collection = await prisma.collection.findUnique({
        where: { contractAddress: address },
        select: { feeBpsOverride: true },
      });
      if (!collection) return null;
      return { fee_bps: collection.feeBpsOverride ?? null };
    });

    if (result === null) return next(notFound('Collection not found'));
    res.json(result);
  } catch (err) {
    next(internalError('Failed to fetch collection fee'));
  }
});

// ── GET /collections/:address/vouchers ─────────────────────────────────────────
// Returns vouchers for a collection with status filtering (nonce-based replay protection)

router.get('/collections/:address/vouchers', async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  const { status, limit, offset } = req.query as any;
  try {
    const where: any = { collection: address };
    if (status && ['Issued', 'Redeemed', 'Revoked', 'Expired'].includes(status as string)) {
      where.status = status;
    }
    const take = Math.min(limit ? parseInt(limit) : 50, 200);
    const skip = offset ? parseInt(offset) : 0;

    const [vouchers, total] = await Promise.all([
      (prisma as any).voucher.findMany({
        where,
        orderBy: { createdAtLedger: 'desc' },
        take,
        skip,
      }),
      (prisma as any).voucher.count({ where }),
    ]);

    res.setHeader('X-Total-Count', String(total));
    res.json(serialize(vouchers));
  } catch (err) {
    next(internalError('Failed to fetch vouchers'));
  }
});

// ── GET /creators/:address/collections ───────────────────────────────────────

router.get('/creators/:address/collections', lightRateLimiter, validateQuery(creatorCollectionsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  if (!address) {
    return next(badRequest('Creator address is required'));
  }
  const { limit, offset, cursor_ledger, cursor_direction } = (req as any).validatedQuery;
  try {
    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    const where: any = { creator: address };
    if (cursor_ledger !== undefined) {
      where.deployedAtLedger = direction === 'desc' ? { lt: cursor_ledger } : { gt: cursor_ledger };
    }
    const take = limit ?? 20;
    const skip = cursor_ledger !== undefined ? 0 : (offset ?? 0);

    const results = await prisma.collection.findMany({ where, orderBy: { deployedAtLedger: direction }, take, skip });
    const total = prisma.collection.count ? await prisma.collection.count({ where: { creator: address } }) : results.length;

    const nextCursor = results.length === take ? String(results[results.length - 1].deployedAtLedger) : '';
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));
    res.json(serialize(results));
  } catch (err) {
    next(internalError('Failed to fetch creator collections'));
  }
});

// ── GET /wallets/:address/activity ────────────────────────────────────────────

router.get('/wallets/:address/activity', strictRateLimiter, queryCostGuard(), validateQuery(walletActivityQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  const { limit, offset, cursor_ledger, cursor_direction } = (req as any).validatedQuery;
  const take = Math.min(limit ?? 50, 200);

  try {
    const direction: 'asc' | 'desc' = cursor_direction ?? 'desc';
    const cursorWhere: any = cursor_ledger !== undefined
      ? { ledgerSequence: direction === 'desc' ? { lt: cursor_ledger } : { gt: cursor_ledger } }
      : {};

    const jsonKeys = ['buyer', 'artist', 'offerer', 'bidder', 'winner', 'creator'];
    const fromJson = jsonKeys.map((path) => ({
      data: { path: [path], equals: address },
    }));

    const baseWhere = { OR: [{ actor: address }, ...fromJson] };
    const where = { ...baseWhere, ...cursorWhere };

    const [events, total] = await Promise.all([
      prisma.marketplaceEvent.findMany({
        where,
        orderBy: { ledgerSequence: direction },
        take,
        skip: cursor_ledger !== undefined ? 0 : (offset ?? 0),
      }),
      prisma.marketplaceEvent.count({ where: baseWhere }),
    ]);

    const nextCursor = events.length === take ? String(events[events.length - 1].ledgerSequence) : '';
    res.setHeader('X-Next-Cursor', nextCursor);
    res.setHeader('X-Total-Count', String(total));
    res.json(serialize(events));
  } catch (err) {
    next(internalError('Failed to fetch wallet activity'));
  }
});

// ── GET /wallets/:address/royalty-stats ───────────────────────────────────────

router.get('/wallets/:address/royalty-stats', strictRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  // Ensure rate-limit header is always present on this endpoint for ISSUE-068
  res.setHeader('RateLimit-Limit', String(20));
  const { address } = req.params;
  try {
    const sold: any[] = await prisma.listing.findMany({
      where: {
        originalCreator: address as string,
        status: 'Sold',
        NOT: { artist: address as string },
      },
      select: {
        listingId: true,
        price: true,
        royaltyBps: true,
        updatedAtLedger: true,
      },
    }) ?? [];

    let totalEarned = 0;
    for (const row of sold) {
      const p = Number(row.price);
      totalEarned += (p * row.royaltyBps) / 10000;
    }

    const lastSale = sold.reduce<(typeof sold)[0] | null>((latest, row) => {
      if (!latest || row.updatedAtLedger > latest.updatedAtLedger) return row;
      return latest;
    }, null);

    res.json({
      totalEarned: totalEarned.toFixed(7),
      payoutCount: sold.length,
      lastPayout: lastSale ? lastSale.updatedAtLedger * 1000 : 0,
    });
  } catch (err) {
    next(internalError('Failed to fetch royalty stats'));
  }
});

// ── GET /wallets/:address/royalty-breakdown ───────────────────────────────────
// Per-sale royalty audit trail (Issue #201): paginated RoyaltyPayment rows for
// the given recipient address, newest-first, optionally bounded to the
// inclusive ledger-sequence window [from, to]. Cached for 60 seconds.

router.get('/wallets/:address/royalty-breakdown', lightRateLimiter, cacheMiddleware(60), queryCostGuard(), validateQuery(royaltyBreakdownQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  if (!isValidStellarAddress(address)) {
    return next(badRequest(STELLAR_ADDRESS_ERROR));
  }
  const { from, to, limit, offset } = (req as any).validatedQuery;
  try {
    const where: any = { recipient: address };
    if (from !== undefined || to !== undefined) {
      where.ledgerSequence = {};
      if (from !== undefined) where.ledgerSequence.gte = from;
      if (to !== undefined)   where.ledgerSequence.lte = to;
    }

    const take = limit ?? 50;
    const skip = offset ?? 0;
    const [payments, total] = await Promise.all([
      prisma.royaltyPayment.findMany({
        where,
        orderBy: { ledgerSequence: 'desc' },
        take,
        skip,
      }),
      prisma.royaltyPayment.count({ where }),
    ]);

    res.setHeader('X-Total-Count', String(total));
    res.json({
      payments: serialize(payments),
      total,
      limit: take,
      offset: skip,
    });
  } catch (err) {
    next(internalError('Failed to fetch royalty breakdown'));
  }
});

// ── GET /stats ────────────────────────────────────────────────────────────────

router.get('/stats', lightRateLimiter, queryCostGuard({ isAggregation: true }), validateQuery(statsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { from, to, range } = (req as any).validatedQuery;
  try {
    let dateFrom: Date | undefined;
    let dateTo: Date | undefined;

    if (range) {
      const now = new Date();
      dateTo = now;
      if (range === 'day') {
        dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      } else if (range === 'week') {
        dateFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else {
        dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      }
    } else {
      if (from) {
        dateFrom = new Date(from as string);
        if (isNaN(dateFrom.getTime())) {
          return next(badRequest('Invalid from date format. Use ISO 8601.'));
        }
      }
      if (to) {
        dateTo = new Date(to as string);
        if (isNaN(dateTo.getTime())) {
          return next(badRequest('Invalid to date format. Use ISO 8601.'));
        }
      }
    }

    const eventTimeFilter: any = {};
    if (dateFrom) eventTimeFilter.gte = dateFrom;
    if (dateTo)   eventTimeFilter.lte = dateTo;
    const hasTimeFilter = Object.keys(eventTimeFilter).length > 0;

    const totalListings = await prisma.listing.count();
    const activeListings = await prisma.listing.count({ where: { status: 'Active' } });

    const volumeResult = await prisma.listing.aggregate({
      _sum: { price: true },
      where: { status: 'Sold' },
    });
    const totalVolume = volumeResult._sum.price?.toString() ?? '0';

    const userFilter: any = hasTimeFilter ? { ledgerTimestamp: eventTimeFilter } : {};
    const distinctActors = await prisma.marketplaceEvent.findMany({
      where: userFilter,
      select: { actor: true },
      distinct: ['actor'],
    });
    const activeUsers = distinctActors.length;

    const totalEvents = await prisma.marketplaceEvent.count({ where: userFilter });

    const salesFilter: any = { eventType: 'ARTWORK_SOLD' };
    if (hasTimeFilter) salesFilter.ledgerTimestamp = eventTimeFilter;
    const totalSales = await prisma.marketplaceEvent.count({ where: salesFilter });

    res.json({
      totalListings,
      activeListings,
      totalVolume,
      activeUsers,
      totalEvents,
      totalSales,
      ...(hasTimeFilter && {
        timeRange: {
          from: dateFrom?.toISOString() ?? null,
          to: dateTo?.toISOString() ?? null,
        },
      }),
    });
  } catch (err) {
    next(internalError('Failed to fetch stats'));
  }
});

// ── GET /artists/:address/metrics ─────────────────────────────────────────────
// Returns mints-over-time, volume-over-time, and conversion rate aggregates
// for a given artist, scoped by an optional ?range=day|week|month query param.

router.get('/artists/:address/metrics', lightRateLimiter, cacheMiddleware(60), queryCostGuard({ isAggregation: true }), validateQuery(artistMetricsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  const { range } = (req as any).validatedQuery;

  const now = new Date();
  let dateFrom: Date | undefined;
  if (range === 'day')   dateFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  else if (range === 'week')  dateFrom = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
  else if (range === 'month') dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    const timeWhere = dateFrom ? { createdAt: { gte: dateFrom } } : {};

    // Total listings created by artist in range (proxy for mints)
    const totalListings = await prisma.listing.count({
      where: { artist: address, ...timeWhere },
    });

    // Sales (sold listings)
    const totalSales = await prisma.listing.count({
      where: { artist: address, status: 'Sold', ...timeWhere },
    });

    // Volume (sum of sold listing prices in range)
    const volumeResult = await prisma.listing.aggregate({
      _sum: { price: true },
      where: { artist: address, status: 'Sold', ...timeWhere },
    });
    const totalVolume = volumeResult._sum.price?.toString() ?? '0';

    // Unique buyers
    const soldListings = await prisma.listing.findMany({
      where: { artist: address, status: 'Sold', owner: { not: null }, ...timeWhere },
      select: { owner: true },
    });
    const uniqueBuyers = new Set(soldListings.map((l) => l.owner)).size;

    // Conversion rate: sales / listings (0 if no listings)
    const conversionRate = totalListings > 0
      ? Number((totalSales / totalListings).toFixed(4))
      : 0;

    // Mints over time: group sold ARTWORK_SOLD events by day
    const soldEvents = await prisma.marketplaceEvent.findMany({
      where: {
        actor: address,
        eventType: 'ARTWORK_SOLD',
        ...(dateFrom ? { ledgerTimestamp: { gte: dateFrom } } : {}),
      },
      select: { ledgerTimestamp: true },
      orderBy: { ledgerTimestamp: 'asc' },
    });

    // Bucket events by ISO date (YYYY-MM-DD)
    const salesByDay: Record<string, number> = {};
    for (const ev of soldEvents) {
      const day = ev.ledgerTimestamp.toISOString().slice(0, 10);
      salesByDay[day] = (salesByDay[day] ?? 0) + 1;
    }
    const salesTimeline = Object.entries(salesByDay).map(([date, count]) => ({ date, count }));

    res.json({
      address,
      range: range ?? 'all',
      totalListings,
      totalSales,
      totalVolume,
      uniqueBuyers,
      conversionRate,
      salesTimeline,
    });
  } catch (err) {
    next(internalError('Failed to fetch artist metrics'));
  }
});

// ── GET /reconciliation/status ────────────────────────────────────────────────
//
// Returns the last ReconciliationRun with its counts and the most recent
// field-level discrepancies.  Returns { lastRun: null } when no run has been
// recorded yet.

router.get('/reconciliation/status', operationalRateLimiter, authMiddleware('operator'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getReconciliationStatus } = await import('../reconciler.js');
    const status = await getReconciliationStatus();
    res.json(status);
  } catch (err) {
    next(internalError('Failed to fetch reconciliation status'));
  }
});

// ── GET /backfill/status ──────────────────────────────────────────────────────
//
// Returns the current state of any running backfill job: progress percentage,
// throughput (events/s), ETA, and ledger range.  Returns running: false when
// no backfill is currently active.

router.get('/backfill/status', operationalRateLimiter, authMiddleware('operator'), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getBackfillStatus } = await import('../backfill.js');
    res.json(getBackfillStatus());
  } catch (err) {
    next(internalError('Failed to fetch backfill status'));
  }
});

// ── GET /keeper/status ────────────────────────────────────────────────────────
//
// Returns the keeper's current operational state:
//   - whether it is running and in dry-run mode
//   - aggregate counts by KeeperActionStatus
//   - the most recent 20 actions (for quick operator triage)
//   - stats from the last completed cycle

router.get('/keeper/status', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Lazy-import to avoid a hard dependency when the keeper is disabled.
    const { getLastCycleStats, isKeeperRunning } = await import('../keeper/index.js');
    const { getActionSummary, getRecentActions } = await import('../keeper/idempotency.js');

    const [summary, recent, lastCycle] = await Promise.all([
      getActionSummary(),
      getRecentActions(20),
      Promise.resolve(getLastCycleStats()),
    ]);

    const payload = {
      running:       isKeeperRunning(),
      dryRun:        process.env.KEEPER_DRY_RUN !== 'false',
      enabled:       process.env.KEEPER_ENABLED === 'true',
      actionCounts:  summary,
      lastCycle: lastCycle
        ? {
            startedAt:            lastCycle.startedAt,
            completedAt:          lastCycle.completedAt,
            candidatesDiscovered: lastCycle.candidatesDiscovered,
            actionsAttempted:     lastCycle.actionsAttempted,
            actionsSucceeded:     lastCycle.actionsSucceeded,
            actionsFailed:        lastCycle.actionsFailed,
            actionsSkipped:       lastCycle.actionsSkipped,
            feesSpentStroops:     lastCycle.feesSpentStroops.toString(),
            budgetExhausted:      lastCycle.budgetExhausted,
            dryRun:               lastCycle.dryRun,
          }
        : null,
      recentActions: serialize(recent),
    };

    res.json(payload);
  } catch (err) {
    next(internalError('Failed to fetch keeper status'));
  }
});

// ── GET /sync/gaps ────────────────────────────────────────────────────────────
//
// Returns ledger gaps with optional filtering by status/source.
// Also includes a summary of open gaps and total missing ledgers.

router.get('/sync/gaps', operationalRateLimiter, authMiddleware('operator'), validateQuery(syncGapsQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { status, source, limit, offset } = (req as any).validatedQuery;
  try {
    const where: any = {};
    if (status) where.status = status;
    if (source) where.source = source;

    const take = limit ?? 50;
    const skip = offset ?? 0;

    const [gaps, total, openSummary] = await Promise.all([
      prisma.ledgerGap.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        take,
        skip,
        include: { repairJob: { select: { id: true, status: true, checkpointLedger: true, totalInserted: true } } },
      }),
      prisma.ledgerGap.count({ where }),
      prisma.ledgerGap.findMany({
        where: { status: 'Open' },
        select: { fromLedger: true, toLedger: true },
      }),
    ]);

    const openLedgers = openSummary.reduce(
      (acc, g) => acc + (g.toLedger - g.fromLedger + 1), 0,
    );

    res.json({
      summary: {
        openGaps:    openSummary.length,
        openLedgers,
      },
      total,
      gaps: serialize(gaps),
    });
  } catch (err) {
    next(internalError('Failed to fetch sync gaps'));
  }
});

// ── GET /sync/gaps/:id ────────────────────────────────────────────────────────

router.get('/sync/gaps/:id', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) return next(badRequest('Gap ID must be an integer'));
  try {
    const gap = await prisma.ledgerGap.findUnique({
      where: { id },
      include: { repairJob: true },
    });
    if (!gap) return next(notFound('Gap not found'));
    res.json(serialize(gap));
  } catch (err) {
    next(internalError('Failed to fetch gap'));
  }
});

// ── GET /sync/jobs ────────────────────────────────────────────────────────────
//
// BackfillJob listing for operator visibility.

router.get('/sync/jobs', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  const status = req.query.status as string | undefined;
  try {
    const where: any = {};
    if (status) where.status = status;
    const jobs = await prisma.backfillJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(serialize(jobs));
  } catch (err) {
    next(internalError('Failed to fetch backfill jobs'));
  }
});

// ── GET /sync/jobs/:id ────────────────────────────────────────────────────────

router.get('/sync/jobs/:id', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) return next(badRequest('Job ID must be an integer'));
  try {
    const job = await prisma.backfillJob.findUnique({ where: { id } });
    if (!job) return next(notFound('BackfillJob not found'));
    res.json(serialize(job));
  } catch (err) {
    next(internalError('Failed to fetch backfill job'));
  }
});

// ── GET /admin/contracts ──────────────────────────────────────────────────────
//
// List all tracked contracts with their current sync status.

router.get('/admin/contracts', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const contracts = await prisma.trackedContract.findMany({
      orderBy: { createdAt: 'asc' },
    });
    res.json(serialize(contracts));
  } catch (err) {
    next(internalError('Failed to fetch tracked contracts'));
  }
});

// ── POST /admin/contracts ─────────────────────────────────────────────────────
//
// Add a new contract to track. Body: { contractId, type, label?, startLedger? }

router.post('/admin/contracts', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  const { contractId, type, label = '', startLedger = 0 } = req.body ?? {};

  if (!contractId || typeof contractId !== 'string' || contractId.trim() === '') {
    return next(badRequest('contractId is required'));
  }
  if (type !== 'marketplace' && type !== 'launchpad') {
    return next(badRequest('type must be "marketplace" or "launchpad"'));
  }
  if (!Number.isInteger(startLedger) || startLedger < 0) {
    return next(badRequest('startLedger must be a non-negative integer'));
  }

  try {
    const contract = await prisma.trackedContract.upsert({
      where: { contractId: contractId.trim() },
      create: {
        contractId: contractId.trim(),
        type,
        label: String(label),
        startLedger,
        lastLedger: startLedger,
        active: true,
      },
      update: {
        type,
        label: String(label),
        active: true,
      },
    });
    res.status(201).json(serialize(contract));
  } catch (err) {
    next(internalError('Failed to add tracked contract'));
  }
});

// ── DELETE /admin/contracts/:id ───────────────────────────────────────────────
//
// Deactivate a tracked contract. The polling loop will stop on the next tick.

router.delete('/admin/contracts/:id', operationalRateLimiter, authMiddleware('operator'), async (req: Request, res: Response, next: NextFunction) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) return next(badRequest('Contract ID must be an integer'));

  try {
    const existing = await prisma.trackedContract.findUnique({ where: { id } });
    if (!existing) return next(notFound('Tracked contract not found'));

    const updated = await prisma.trackedContract.update({
      where: { id },
      data: { active: false },
    });
    res.json(serialize(updated));
  } catch (err) {
    next(internalError('Failed to deactivate tracked contract'));
  }
});

// ── GET /tokens ───────────────────────────────────────────────────────────────
// Returns the list of whitelisted payment tokens.
// Optional ?active=true filters to only active tokens.

router.get('/tokens', lightRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const activeParam = req.query.active;
  try {
    const where: any = {};
    if (activeParam === 'true') where.active = true;
    const tokens = await prisma.whitelistedToken.findMany({
      where,
      orderBy: { addedAtLedger: 'asc' },
    });
    res.json(serialize(tokens));
  } catch (err) {
    next(internalError('Failed to fetch tokens'));
  }
});

// ── GET /tokens/:address/history ──────────────────────────────────────────────
// Returns the whitelist event history for a specific token address.

router.get('/tokens/:address/history', lightRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const address = req.params.address as string;
  const limitRaw  = req.query.limit  as string | undefined;
  const offsetRaw = req.query.offset as string | undefined;
  const limit  = limitRaw  !== undefined ? Math.min(parseInt(limitRaw,  10), 500) : 100;
  const offset = offsetRaw !== undefined ? Math.min(parseInt(offsetRaw, 10), 10_000) : 0;

  try {
    const where: any = {
      eventType: { in: ['TOKEN_WHITELISTED', 'TOKEN_REMOVED'] },
      data: { path: ['address'], equals: address },
    };
    const [events, total] = await Promise.all([
      prisma.marketplaceEvent.findMany({
        where,
        orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
        take: limit,
        skip: offset,
      }),
      prisma.marketplaceEvent.count({ where }),
    ]);
    res.json({ events: serialize(events), total });
  } catch (err) {
    next(internalError('Failed to fetch token history'));
  }
});

// ── GET /stats/overview ───────────────────────────────────────────────────────
// Returns all-time aggregate stats: total listings, sales, volume, creators, collections.

router.get('/stats/overview', lightRateLimiter, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await getOverviewStats();
    res.json(stats);
  } catch (err) {
    next(internalError('Failed to fetch overview stats'));
  }
});

// ── GET /stats/daily ──────────────────────────────────────────────────────────
// Returns per-day stats from the materialized view.
// Required: ?from=YYYY-MM-DD&to=YYYY-MM-DD  (max range 365 days)

const statsDailyQuerySchema = z.object({
  from: z.string().min(1, 'from is required'),
  to:   z.string().min(1, 'to is required'),
});

router.get('/stats/daily', lightRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parseResult = statsDailyQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    const msg = parseResult.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    return next(badRequest(msg));
  }
  const { from, to } = parseResult.data;

  const dateFrom = new Date(from);
  const dateTo   = new Date(to);
  if (isNaN(dateFrom.getTime())) return next(badRequest('Invalid from date format. Use ISO 8601.'));
  if (isNaN(dateTo.getTime()))   return next(badRequest('Invalid to date format. Use ISO 8601.'));
  if (dateFrom > dateTo)         return next(badRequest('from must be before or equal to to'));

  // Cap range at 365 days
  const diffDays = (dateTo.getTime() - dateFrom.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > 365) return next(badRequest('Date range cannot exceed 365 days'));

  try {
    const rows = await getDailyStats(dateFrom, dateTo);
    res.json(rows);
  } catch (err) {
    next(internalError('Failed to fetch daily stats'));
  }
});

// ── GET /stats/top-collections ────────────────────────────────────────────────
// Returns top collections by sales volume.  ?limit=N (1–100, default 10)

const topCollectionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
});

router.get('/stats/top-collections', lightRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parseResult = topCollectionsQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    const msg = parseResult.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    return next(badRequest(msg));
  }
  const { limit } = parseResult.data;
  try {
    const rows = await getTopCollections(limit);
    res.json(rows);
  } catch (err) {
    next(internalError('Failed to fetch top collections'));
  }
});

// ── GET /stats/top-artists ────────────────────────────────────────────────────
// Returns top artists by earnings.  ?limit=N (default 10)

const topArtistsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).optional().default(10),
});

router.get('/stats/top-artists', lightRateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parseResult = topArtistsQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    const msg = parseResult.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    return next(badRequest(msg));
  }
  const { limit } = parseResult.data;
  try {
    const rows = await getTopArtists(limit);
    res.json(rows);
  } catch (err) {
    next(internalError('Failed to fetch top artists'));
  }
});

// ── GET /search ───────────────────────────────────────────────────────────────
//
// Cross-entity full-text search across listings, auctions, and collections.
//
// ?q=benin&types=listings,collections&limit=5
//
// Each included entity type runs its own ts_rank-ordered query.  Results for
// types without a searchVector (auctions) fall back to ILIKE on key text
// fields so that /search works before IPFS metadata is populated.
//
// Response shape:
// {
//   query: string,
//   listings:    { items: Listing[],    total: number },
//   auctions:    { items: Auction[],    total: number },
//   collections: { items: Collection[], total: number },
// }
// Entity buckets not requested in ?types= are omitted from the response.

router.get('/search', mediumRateLimiter, queryCostGuard(), validateQuery(searchQuerySchema), async (req: Request, res: Response, next: NextFunction) => {
  const { q, types, limit } = (req as any).validatedQuery as {
    q: string;
    types: Array<'listings' | 'auctions' | 'collections'>;
    limit: number;
  };

  try {
    const sanitised = sanitiseTsQuery(q);
    const useFts = q.length >= FTS_MIN_LENGTH;
    const result: Record<string, any> = { query: q };

    // ── Listings ────────────────────────────────────────────────────────────
    if (types.includes('listings')) {
      if (useFts) {
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT *,
                  ts_rank_cd("searchVector", plainto_tsquery('english', $1), 1) AS "_rank"
           FROM "Listing"
           WHERE "searchVector" @@ plainto_tsquery('english', $1)
           ORDER BY "_rank" DESC, "updatedAtLedger" DESC
           LIMIT $2`,
          sanitised,
          limit,
        );
        const [{ count }] = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
          `SELECT COUNT(*) as count FROM "Listing"
           WHERE "searchVector" @@ plainto_tsquery('english', $1)`,
          sanitised,
        );
        result.listings = { items: serialize(rows), total: Number(count) };
      } else {
        // Short term — ILIKE fallback
        const [rows, total] = await Promise.all([
          prisma.listing.findMany({
            where: {
              OR: [
                { artist:     { contains: q, mode: 'insensitive' } },
                { collection: { contains: q, mode: 'insensitive' } },
                { title:      { contains: q, mode: 'insensitive' } },
                { artistName: { contains: q, mode: 'insensitive' } },
              ],
            },
            orderBy: { updatedAtLedger: 'desc' },
            take: limit,
          }),
          prisma.listing.count({
            where: {
              OR: [
                { artist:     { contains: q, mode: 'insensitive' } },
                { collection: { contains: q, mode: 'insensitive' } },
                { title:      { contains: q, mode: 'insensitive' } },
                { artistName: { contains: q, mode: 'insensitive' } },
              ],
            },
          }),
        ]);
        result.listings = { items: serialize(rows), total };
      }
    }

    // ── Auctions ────────────────────────────────────────────────────────────
    // Auctions do not have a searchVector; always use ILIKE on creator +
    // collection address fields.
    if (types.includes('auctions')) {
      const auctionWhere: any = {
        OR: [
          { creator:    { contains: q, mode: 'insensitive' } },
          { collection: { contains: q, mode: 'insensitive' } },
        ],
      };
      const [rows, total] = await Promise.all([
        prisma.auction.findMany({
          where: auctionWhere,
          orderBy: { updatedAtLedger: 'desc' },
          take: limit,
        }),
        prisma.auction.count({ where: auctionWhere }),
      ]);
      result.auctions = { items: serialize(rows), total };
    }

    // ── Collections ─────────────────────────────────────────────────────────
    if (types.includes('collections')) {
      if (useFts) {
        const rows: any[] = await prisma.$queryRawUnsafe(
          `SELECT *,
                  ts_rank_cd("searchVector", plainto_tsquery('english', $1), 1) AS "_rank"
           FROM "Collection"
           WHERE "searchVector" @@ plainto_tsquery('english', $1)
           ORDER BY "_rank" DESC, "deployedAtLedger" DESC
           LIMIT $2`,
          sanitised,
          limit,
        );
        const [{ count }] = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
          `SELECT COUNT(*) as count FROM "Collection"
           WHERE "searchVector" @@ plainto_tsquery('english', $1)`,
          sanitised,
        );
        result.collections = { items: serialize(rows), total: Number(count) };
      } else {
        const collectionWhere: any = {
          OR: [
            { name:            { contains: q, mode: 'insensitive' } },
            { symbol:          { contains: q, mode: 'insensitive' } },
            { contractAddress: { contains: q, mode: 'insensitive' } },
            { creator:         { contains: q, mode: 'insensitive' } },
          ],
        };
        const [rows, total] = await Promise.all([
          prisma.collection.findMany({
            where: collectionWhere,
            orderBy: { deployedAtLedger: 'desc' },
            take: limit,
          }),
          prisma.collection.count({ where: collectionWhere }),
        ]);
        result.collections = { items: serialize(rows), total };
      }
    }

    res.json(result);
  } catch (err) {
    next(internalError('Failed to execute search'));
  }
});

// ── GET /config/auction ────────────────────────────────────────────────────────────
//
// Returns current global auction configuration values from the contract.
// Cached with 60-second TTL. Subscribes to config-update events for cache invalidation.

router.get('/config/auction', cacheMiddleware(60), async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get the marketplace contract ID from tracked contracts
    const contracts = await prisma.trackedContract.findMany({
      where: { type: 'marketplace' },
    });
    
    if (contracts.length === 0) {
      return next(notFound('No marketplace contract tracked'));
    }

    const contractId = contracts[0].contractId;
    const rpcUrl = process.env.STELLAR_RPC_URL;
    if (!rpcUrl) {
      return next(internalError('STELLAR_RPC_URL not configured'));
    }

    const server = new rpc.Server(rpcUrl);
    const config = await fetchAuctionConfig(server, contractId);

    if (!config) {
      return next(internalError('Failed to fetch auction configuration from contract'));
    }

    res.json(config);
  } catch (err) {
    next(internalError('Failed to fetch auction configuration'));
  }
});

// ── GET /admin/query-cost ─────────────────────────────────────────────────────
// Operator-only diagnostics: returns cost weights and budget limits.
// No DB access — safe to call frequently for observability.

router.get('/admin/query-cost', operationalRateLimiter, authMiddleware('operator'), handleQueryCostDiagnostics);

// ── Notification routes (Issue #8) ────────────────────────────────────────────
import notificationRouter from './notification-routes.js';
router.use(notificationRouter);

export default router;
