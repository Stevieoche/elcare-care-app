/**
 * query-cost.ts
 *
 * Cost model for API queries.
 *
 * Motivation
 * ----------
 * Complex filters, full-text search, large limits, wide time ranges, and
 * cross-table JOINs can consume disproportionate database resources even when
 * rate limiting is in place. A single malicious or poorly-written query can
 * saturate the read pool and degrade availability for all users.
 *
 * This module assigns a numeric cost to each query parameter combination and
 * rejects queries that exceed a configurable budget. Cached responses skip
 * the database entirely and are therefore exempt from cost enforcement.
 *
 * Cost model
 * ----------
 * Each parameter contributes an additive cost unit:
 *
 *   limit > 100        +20   (large page)
 *   limit > 50         +10   (medium page)
 *   offset > 1000      +15   (deep pagination)
 *   search / q (FTS)   +25   (GIN index scan + ts_rank)
 *   minPrice+maxPrice  +5    (price range filter with index)
 *   multi-filter       +5    (combining 3+ filters)
 *   sort               +5    (non-default sort mode)
 *   from / to (time)   +10   (time-range aggregation)
 *   join (bids/IPFS)   +15   (implicit from endpoint)
 *   stats aggregation  +20   (GROUP BY / SUM queries)
 *
 * Query budget defaults (configurable via env):
 *   QUERY_COST_BUDGET_PUBLIC       = 60  (anonymous / wallet-authed)
 *   QUERY_COST_BUDGET_OPERATOR     = 200 (operator token present)
 *
 * A cached response returns cost = 0 (cache hit detected before this guard).
 *
 * Operator-only diagnostics
 * -------------------------
 * GET /admin/query-cost returns the cost table and current budget limits
 * without leaking internal execution plans or DB schema.
 */

import { Request, Response, NextFunction } from 'express';
import { ApiError, ErrorCode } from './errors.js';
import { logger } from '../logger.js';

// ── Stable error code ─────────────────────────────────────────────────────────

export const QUERY_TOO_EXPENSIVE_CODE = 'QUERY_TOO_EXPENSIVE' as const;

// ── Types (defined first so everything below can reference them) ───────────────

export interface CostBreakdown {
  components: Array<{ reason: string; cost: number }>;
  total: number;
}

export interface CostOptions {
  /** Effective limit (coerced, defaults applied). */
  limit?: number;
  /** Effective offset. */
  offset?: number;
  /** Free-text search parameter present and non-empty. */
  hasSearch?: boolean;
  /** Whether search term meets FTS length threshold (≥ 3 chars). */
  isFtsSearch?: boolean;
  /** Price-range filter active (minPrice or maxPrice set). */
  hasPriceRange?: boolean;
  /** Number of active query filters (excluding limit/offset/search). */
  activeFilters?: number;
  /** Explicit sort parameter present. */
  hasSort?: boolean;
  /** Time-range parameters present (from/to or range shorthand). */
  hasTimeRange?: boolean;
  /** Route implicitly performs a JOIN (e.g., auction detail + bids). */
  hasJoin?: boolean;
  /** Endpoint performs aggregation queries (stats, metrics). */
  isAggregation?: boolean;
  /** Number of entity types targeted (cross-entity search). */
  entityTypeCount?: number;
}

export interface QueryCostMiddlewareOptions {
  /** Extra cost options beyond what the middleware auto-detects from req.query. */
  extraOpts?: Partial<CostOptions>;
  /** Whether this endpoint performs an implicit JOIN. */
  hasJoin?: boolean;
  /** Whether this endpoint performs aggregation. */
  isAggregation?: boolean;
}

// ── Error class ───────────────────────────────────────────────────────────────

export class QueryTooExpensiveError extends ApiError {
  constructor(
    public readonly estimatedCost: number,
    public readonly budget: number,
    public readonly breakdown: CostBreakdown,
  ) {
    super(
      400,
      ErrorCode.QUERY_TOO_EXPENSIVE,
      `Query cost ${estimatedCost} exceeds budget ${budget}. Reduce limit, narrow filters, or use cursor pagination.`,
      { estimatedCost, budget, breakdown },
    );
    this.name = 'QueryTooExpensiveError';
  }
}

// ── Env helper ────────────────────────────────────────────────────────────────

function envInt(name: string, defaultVal: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  const n = parseInt(raw, 10);
  return isNaN(n) ? defaultVal : n;
}

// ── Cost weights (all env-overridable) ────────────────────────────────────────

export const COST_WEIGHTS = {
  /** Large page (limit > 100). */
  LARGE_PAGE:        () => envInt('QUERY_COST_LARGE_PAGE',        20),
  /** Medium page (limit 51–100). */
  MEDIUM_PAGE:       () => envInt('QUERY_COST_MEDIUM_PAGE',       10),
  /** Deep pagination (offset > 1000). */
  DEEP_OFFSET:       () => envInt('QUERY_COST_DEEP_OFFSET',       15),
  /** Full-text search (tsvector GIN scan + ts_rank). */
  FTS_SEARCH:        () => envInt('QUERY_COST_FTS_SEARCH',        25),
  /** Short ILIKE search (< 3 chars). */
  ILIKE_SEARCH:      () => envInt('QUERY_COST_ILIKE_SEARCH',      10),
  /** Price range filter. */
  PRICE_RANGE:       () => envInt('QUERY_COST_PRICE_RANGE',        5),
  /** Multiple combined filters (>= 3 active). */
  MULTI_FILTER:      () => envInt('QUERY_COST_MULTI_FILTER',       5),
  /** Non-default sort mode. */
  SORT:              () => envInt('QUERY_COST_SORT',               5),
  /** Time-range query (from/to params). */
  TIME_RANGE:        () => envInt('QUERY_COST_TIME_RANGE',        10),
  /** Implicit JOIN (e.g., auction detail + bids). */
  JOIN:              () => envInt('QUERY_COST_JOIN',              15),
  /** Stats / aggregation endpoint (GROUP BY, SUM, COUNT DISTINCT). */
  STATS_AGGREGATION: () => envInt('QUERY_COST_STATS_AGGREGATION', 20),
  /** Cross-entity search — charged per extra entity type beyond 1. */
  CROSS_ENTITY:      () => envInt('QUERY_COST_CROSS_ENTITY',      15),
} as const;

// ── Per-tier budgets ──────────────────────────────────────────────────────────

/** Maximum query cost for public / wallet-authenticated callers. */
export function publicBudget(): number  { return envInt('QUERY_COST_BUDGET_PUBLIC',   60); }
/** Maximum query cost for operator-authenticated callers. */
export function operatorBudget(): number { return envInt('QUERY_COST_BUDGET_OPERATOR', 200); }

// ── Cost estimation ───────────────────────────────────────────────────────────

export function estimateCost(opts: CostOptions): CostBreakdown {
  const components: Array<{ reason: string; cost: number }> = [];

  // Limit cost
  const limit = opts.limit ?? 20;
  if (limit > 100) {
    components.push({ reason: `limit=${limit} > 100 (large page)`, cost: COST_WEIGHTS.LARGE_PAGE() });
  } else if (limit > 50) {
    components.push({ reason: `limit=${limit} > 50 (medium page)`, cost: COST_WEIGHTS.MEDIUM_PAGE() });
  }

  // Offset cost
  const offset = opts.offset ?? 0;
  if (offset > 1000) {
    components.push({ reason: `offset=${offset} > 1000 (deep pagination)`, cost: COST_WEIGHTS.DEEP_OFFSET() });
  }

  // Search cost
  if (opts.hasSearch) {
    if (opts.isFtsSearch) {
      components.push({ reason: 'full-text search (tsvector GIN + ts_rank)', cost: COST_WEIGHTS.FTS_SEARCH() });
    } else {
      components.push({ reason: 'ILIKE search (short-term fallback)', cost: COST_WEIGHTS.ILIKE_SEARCH() });
    }
  }

  // Price range
  if (opts.hasPriceRange) {
    components.push({ reason: 'price-range filter', cost: COST_WEIGHTS.PRICE_RANGE() });
  }

  // Multi-filter
  const filterCount = opts.activeFilters ?? 0;
  if (filterCount >= 3) {
    components.push({ reason: `${filterCount} combined filters`, cost: COST_WEIGHTS.MULTI_FILTER() });
  }

  // Sort
  if (opts.hasSort) {
    components.push({ reason: 'non-default sort', cost: COST_WEIGHTS.SORT() });
  }

  // Time range
  if (opts.hasTimeRange) {
    components.push({ reason: 'time-range filter', cost: COST_WEIGHTS.TIME_RANGE() });
  }

  // JOIN
  if (opts.hasJoin) {
    components.push({ reason: 'implicit JOIN (bids / IPFS / related rows)', cost: COST_WEIGHTS.JOIN() });
  }

  // Aggregation
  if (opts.isAggregation) {
    components.push({ reason: 'aggregation query (GROUP BY / SUM / COUNT DISTINCT)', cost: COST_WEIGHTS.STATS_AGGREGATION() });
  }

  // Cross-entity search — cost scales with number of extra entity types
  const entityCount = opts.entityTypeCount ?? 1;
  if (entityCount > 1) {
    components.push({
      reason: `cross-entity search (${entityCount} types)`,
      cost: COST_WEIGHTS.CROSS_ENTITY() * (entityCount - 1),
    });
  }

  const total = components.reduce((sum, c) => sum + c.cost, 0);
  return { components, total };
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Express middleware that estimates query cost from validated/raw query params
 * and rejects over-budget requests before they hit the database.
 *
 * Usage:
 *   router.get('/listings', queryCostGuard(), validateQuery(...), handler)
 *   router.get('/auctions/:id', queryCostGuard({ hasJoin: true }), handler)
 *   router.get('/stats', queryCostGuard({ isAggregation: true }), handler)
 *
 * Reads from req.validatedQuery (set by validateQuery) when available, falls
 * back to raw req.query. Place AFTER validateQuery in the chain so coerced
 * types are available.
 *
 * Cache hits (res.locals.cacheHit = true, set by cacheMiddleware) bypass cost
 * checking entirely — no DB access occurs on a cache hit.
 */
export function queryCostGuard(opts: QueryCostMiddlewareOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Cache hit — no DB cost incurred, skip enforcement.
    if (res.locals.cacheHit) {
      return next();
    }

    // Prefer coerced+validated params; fall back to raw query string values.
    const q: Record<string, unknown> = (req as any).validatedQuery ?? req.query;

    const rawLimit  = q.limit;
    const rawOffset = q.offset;
    const limit  = typeof rawLimit  === 'number' ? rawLimit  : (rawLimit  ? parseInt(String(rawLimit),  10) : undefined);
    const offset = typeof rawOffset === 'number' ? rawOffset : (rawOffset ? parseInt(String(rawOffset), 10) : undefined);

    const searchTerm  = typeof q.search === 'string' ? q.search : (typeof q.q === 'string' ? q.q : undefined);
    const hasSearch   = searchTerm !== undefined && searchTerm.length > 0;
    const isFtsSearch = hasSearch && searchTerm!.length >= 3;

    const hasPriceRange = q.minPrice !== undefined || q.maxPrice !== undefined;
    const hasTimeRange  = q.from !== undefined || q.to !== undefined || q.range !== undefined;
    // ascending cursor direction is a non-default sort that adds cost
    const hasSort       = q.sort !== undefined || q.cursor_direction === 'asc';

    // Count active filter params (not limit/offset/search/sort/pagination)
    const filterParams  = ['artist', 'owner', 'status', 'creator', 'kind', 'listing_id', 'actionType', 'source'];
    const activeFilters = filterParams.filter((p) => q[p] !== undefined).length + (hasPriceRange ? 1 : 0);

    // Entity-type count for cross-entity search (/search?types=)
    let entityTypeCount = 1;
    if (typeof q.types === 'string') {
      entityTypeCount = q.types.split(',').filter(Boolean).length;
    } else if (Array.isArray(q.types)) {
      entityTypeCount = (q.types as string[]).length;
    }

    const costOpts: CostOptions = {
      limit:          (limit  !== undefined && !isNaN(limit))  ? limit  : undefined,
      offset:         (offset !== undefined && !isNaN(offset)) ? offset : undefined,
      hasSearch,
      isFtsSearch,
      hasPriceRange,
      activeFilters,
      hasSort,
      hasTimeRange,
      hasJoin:        opts.hasJoin        ?? false,
      isAggregation:  opts.isAggregation  ?? false,
      entityTypeCount,
      ...(opts.extraOpts ?? {}),
    };

    const breakdown = estimateCost(costOpts);

    // Budget: operator token holders get a higher limit.
    const isOperator = !!(
      req.headers['x-operator-token'] ||
      (typeof req.query.operator_token === 'string' && req.query.operator_token.length > 0)
    );
    const budget = isOperator ? operatorBudget() : publicBudget();

    // Attach cost diagnostics to res.locals for observability (always).
    res.locals.queryCost = { breakdown, budget, isOperator };

    if (breakdown.total > budget) {
      logger.warn('query.too_expensive', {
        event:      'query.too_expensive',
        path:       req.path,
        method:     req.method,
        cost:       breakdown.total,
        budget,
        isOperator,
        components: breakdown.components,
      });
      return next(new QueryTooExpensiveError(breakdown.total, budget, breakdown));
    }

    next();
  };
}

// ── GET /admin/query-cost — operator diagnostics ─────────────────────────────
//
// Returns the current cost weights and per-tier budget limits.
// No DB access. Does not expose execution plans or schema internals.

export function handleQueryCostDiagnostics(_req: Request, res: Response): void {
  res.json({
    weights: {
      LARGE_PAGE:        COST_WEIGHTS.LARGE_PAGE(),
      MEDIUM_PAGE:       COST_WEIGHTS.MEDIUM_PAGE(),
      DEEP_OFFSET:       COST_WEIGHTS.DEEP_OFFSET(),
      FTS_SEARCH:        COST_WEIGHTS.FTS_SEARCH(),
      ILIKE_SEARCH:      COST_WEIGHTS.ILIKE_SEARCH(),
      PRICE_RANGE:       COST_WEIGHTS.PRICE_RANGE(),
      MULTI_FILTER:      COST_WEIGHTS.MULTI_FILTER(),
      SORT:              COST_WEIGHTS.SORT(),
      TIME_RANGE:        COST_WEIGHTS.TIME_RANGE(),
      JOIN:              COST_WEIGHTS.JOIN(),
      STATS_AGGREGATION: COST_WEIGHTS.STATS_AGGREGATION(),
      CROSS_ENTITY:      COST_WEIGHTS.CROSS_ENTITY(),
    },
    budgets: {
      public:   publicBudget(),
      operator: operatorBudget(),
    },
    envVars: {
      QUERY_COST_BUDGET_PUBLIC:   process.env.QUERY_COST_BUDGET_PUBLIC   ?? '(default 60)',
      QUERY_COST_BUDGET_OPERATOR: process.env.QUERY_COST_BUDGET_OPERATOR ?? '(default 200)',
    },
  });
}
