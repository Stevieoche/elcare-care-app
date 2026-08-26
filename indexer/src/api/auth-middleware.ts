import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { unauthorized, forbidden } from './errors.js';
import { getAuditService, AuditActionType, AuditOutcome } from '../audit/audit-service.js';
import { PrismaClient } from '@prisma/client';

// ── Route classification ────────────────────────────────────────────────────────
//
// Public:        no auth required (listings, auctions, offers, collections, search, SSE, health)
// Authenticated: optional wallet auth (wallets, stats, artists)
// Operator:      requires service credential (admin, reconciliation, backfill, keeper, sync)

export type RoutePolicy = 'public' | 'authenticated' | 'operator';

export interface AuthConfig {
  operatorToken: string | undefined;
  allowlist: string[];
}

let cachedConfig: AuthConfig | null = null;

export function loadAuthConfig(): AuthConfig {
  if (cachedConfig) return cachedConfig;

  const operatorToken = process.env.OPERATOR_TOKEN || process.env.HEALTH_DETAILS_TOKEN || '';
  const allowlist = (process.env.OPERATOR_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  cachedConfig = { operatorToken, allowlist };
  return cachedConfig;
}

/** Reset the cached config — used in tests to pick up env changes between cases. */
export function resetAuthConfigCache(): void {
  cachedConfig = null;
}

export let prismaClient: PrismaClient | null = null;

export function setPrismaClient(client: PrismaClient): void {
  prismaClient = client;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getClientIp(req: Request): string {
  // Respect X-Forwarded-For when the server is behind a trusted proxy (e.g.
  // nginx, AWS ALB). Fall back through socket address to 'unknown'.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  return (req.ip || req.socket?.remoteAddress || 'unknown').toString();
}

function extractWallet(req: Request): string | undefined {
  const header = req.headers['x-wallet-address'];
  if (typeof header === 'string' && header.length > 0) return header;
  const query = req.query.wallet;
  if (typeof query === 'string' && query.length > 0) return query;
  return undefined;
}

// ── Correlation helper ─────────────────────────────────────────────────────────

function getRequestId(res: Response): string | undefined {
  return (res.locals.requestId as string) || undefined;
}

// ── Audit logger ───────────────────────────────────────────────────────────────
//
// Every auth decision — allowed or denied — is emitted as a structured log line
// with a stable `event` field so log aggregators can build dashboards from it
// without parsing free-form strings. The `requestId` correlation key ties each
// audit entry to the surrounding request/response log lines.

export function auditLog(
  req: Request,
  res: Response,
  outcome: 'allowed' | 'denied',
  reason: string,
  policy: RoutePolicy,
): void {
  logger.info('auth.decision', {
    event: 'auth.decision',
    outcome,
    policy,
    reason,
    requestId: getRequestId(res),
    ip: getClientIp(req),
    wallet: extractWallet(req),
    path: req.path,
    method: req.method,
    userAgent: req.headers['user-agent'] || undefined,
  });

  // Log operator auth attempts to audit trail
  if (policy === 'operator' && prismaClient) {
    const auditService = getAuditService(prismaClient);
    auditService.log({
      actor: getClientIp(req),
      actionType: AuditActionType.AdminRoleChange,
      target: req.path,
      requestId: getRequestId(res) || undefined,
      outcome: outcome === 'allowed' ? AuditOutcome.Success : AuditOutcome.Failure,
      context: {
        reason,
        policy,
        method: req.method,
      },
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] as string,
    }).catch((err) => {
      // Don't block auth if audit logging fails
      logger.error('audit.log_failed', { error: err.message });
    });
  }
}

// ── Middleware ─────────────────────────────────────────────────────────────────

export function authMiddleware(policy: RoutePolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const config = loadAuthConfig();

    if (policy === 'public') {
      return next();
    }

    if (policy === 'authenticated') {
      // Authenticated routes accept any request; wallet is optional metadata.
      // No auth check needed — the route itself may use wallet for filtering.
      return next();
    }

    if (policy === 'operator') {
      const provided = req.headers['x-operator-token'] ?? req.query.operator_token;

      if (!config.operatorToken) {
        // No token configured — allow but emit a warning so operators know the
        // endpoint is effectively unprotected.
        logger.warn('auth.unconfigured', {
          event: 'auth.unconfigured',
          policy,
          path: req.path,
          requestId: getRequestId(res),
          ip: getClientIp(req),
        });
        return next();
      }

      if (!provided || provided !== config.operatorToken) {
        auditLog(req, res, 'denied', 'invalid_or_missing_token', policy);
        return next(unauthorized('Invalid or missing operator token'));
      }

      // Token is valid — check allowlist if configured
      if (config.allowlist.length > 0) {
        const clientIp = getClientIp(req);
        if (!config.allowlist.includes(clientIp)) {
          auditLog(req, res, 'denied', 'ip_not_in_allowlist', policy);
          return next(forbidden('Operator access not allowed from this IP'));
        }
      }

      auditLog(req, res, 'allowed', 'token_valid', policy);
      return next();
    }

    next();
  };
}

// ── Route map ──────────────────────────────────────────────────────────────────

export const PUBLIC_ROUTES = new Set([
  '/health',
  '/readyz',
  '/version',
  '/metrics',
  '/openapi.json',
  '/docs',
  '/cors-test',
  '/events',
  '/listings',
  '/listings/{id}',
  '/listings/{id}/history',
  '/listings/{id}/price-history',
  '/auctions',
  '/auctions/{id}',
  '/auctions/{id}/blocked-bidders',
  '/offers',
  '/collections',
  '/collections/{address}/fee',
  '/collections/{address}/vouchers',
  '/creators/{address}/collections',
  '/search',
  '/activity/recent',
  '/artists/{address}/metrics',
  '/ipfs/{cid}',
  '/tokens',
  '/tokens/{address}/history',
  '/stats',
  '/stats/overview',
  '/stats/daily',
  '/stats/top-collections',
  '/stats/top-artists',
  '/config/auction',
  '/notifications/stream',
  '/notifications/summary',
]);

export const AUTHENTICATED_ROUTES = new Set([
  '/wallets/{address}/activity',
  '/wallets/{address}/royalty-stats',
  '/wallets/{address}/royalty-breakdown',
  '/wallets/{address}/notifications',
]);

export const OPERATOR_ROUTES = new Set([
  '/health/details',
  '/reconciliation/status',
  '/backfill/status',
  '/keeper/status',
  '/sync/gaps',
  '/sync/gaps/{id}',
  '/sync/jobs',
  '/sync/jobs/{id}',
  '/admin/contracts',
  '/admin/audit',
  '/admin/audit/{requestId}',
  '/admin/audit/stats',
  // Poller recovery & gap-repair controls
  '/admin/poller/resume',
  '/admin/poller/halt',
  '/admin/poller/revert',
  '/admin/gap-repair/trigger',
  // Dead-letter management
  '/admin/dead-letters',
  '/admin/dead-letters/{id}/replay',
  // Query cost diagnostics (operator-only)
  '/admin/query-cost',
]);

export function classifyRoute(path: string): RoutePolicy {
  // Normalise dynamic path segments to their template form so the set lookups
  // work for both parametric URLs (/wallets/GABC.../activity) and the template
  // strings used in the sets above (/wallets/{address}/activity).
  //
  // Important: normalisation is applied to _individual path segments_ so that
  // static segments like "reconciliation", "contracts", "notifications" are
  // never swallowed by a wildcard regex.

  const normalised = path
    // 1. Full Stellar addresses: exactly 56-char G/C/S base32 strings
    .replace(/\/G[A-Z2-7]{55}(?=\/|$)/g, '/{address}')
    .replace(/\/C[A-Z2-7]{55}(?=\/|$)/g, '/{address}')
    .replace(/\/S[A-Z2-7]{55}(?=\/|$)/g, '/{address}')
    // 2. Pure-numeric IDs (no letters)
    .replace(/\/\d+(?=\/|$)/g, '/{id}')
    // 3. IPFS CIDs: start with Qm (SHA2) or bafy (SHA3/blake) — content-addressed hashes
    .replace(/\/Qm[A-Za-z0-9]{44}(?=\/|$)/g, '/{cid}')
    .replace(/\/bafy[A-Za-z0-9]+(?=\/|$)/g, '/{cid}')
    // 4. UUIDs (requestId in /admin/audit/{requestId})
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/{requestId}');

  // Try exact matches on both the normalised form and the original path to handle
  // routes that were registered with template syntax.
  if (PUBLIC_ROUTES.has(normalised) || PUBLIC_ROUTES.has(path)) return 'public';
  if (AUTHENTICATED_ROUTES.has(normalised) || AUTHENTICATED_ROUTES.has(path)) return 'authenticated';
  if (OPERATOR_ROUTES.has(normalised) || OPERATOR_ROUTES.has(path)) return 'operator';

  // Default: unclassified routes are treated as public (least surprise), but
  // a warning is emitted so CI can catch newly-added unclassified routes.
  logger.warn('auth.unclassified_route', {
    event: 'auth.unclassified_route',
    path,
    normalised,
  });
  return 'public';
}

// ── Policy matrix ─────────────────────────────────────────────────────────────
//
// Flat record used for documentation and startup assertion.
// Every route in the codebase MUST appear here with an intentional policy.
// CI fails when a new route is registered without a corresponding entry —
// see assertAllRoutesClassified().

export type PolicyEntry = {
  policy: RoutePolicy;
  description: string;
  requiresWallet?: boolean;
};

export const ROUTE_POLICY_MATRIX: Record<string, PolicyEntry> = {
  // ── Health & diagnostics ──────────────────────────────────────────────────
  '/health':         { policy: 'public',   description: 'Liveness probe — no auth required' },
  '/readyz':         { policy: 'public',   description: 'Readiness probe — no auth required' },
  '/version':        { policy: 'public',   description: 'Version metadata — no auth required' },
  '/metrics':        { policy: 'public',   description: 'Prometheus scrape endpoint — no auth required' },
  '/health/details': { policy: 'operator', description: 'Full diagnostics including memory and SSE state' },

  // ── API docs ───────────────────────────────────────────────────────────────
  '/openapi.json':   { policy: 'public',   description: 'OpenAPI spec — publicly readable' },
  '/docs':           { policy: 'public',   description: 'Swagger UI — publicly readable' },

  // ── SSE & replay ──────────────────────────────────────────────────────────
  '/events':                   { policy: 'public', description: 'Global SSE stream — public feed with optional wallet filter' },
  '/notifications/stream':     { policy: 'public', description: 'Notification SSE — wallet-filtered stream (no PII, public)' },
  '/notifications/summary':    { policy: 'public', description: 'Notification bell summary — wallet query param, read-only' },

  // ── Listings ───────────────────────────────────────────────────────────────
  '/listings':                     { policy: 'public', description: 'Public listing catalogue' },
  '/listings/{id}':                { policy: 'public', description: 'Single listing detail' },
  '/listings/{id}/history':        { policy: 'public', description: 'Listing event history' },
  '/listings/{id}/price-history':  { policy: 'public', description: 'Listing price change audit trail' },

  // ── Auctions ───────────────────────────────────────────────────────────────
  '/auctions':                     { policy: 'public', description: 'Public auction catalogue' },
  '/auctions/{id}':                { policy: 'public', description: 'Single auction detail with bid history' },
  '/auctions/{id}/blocked-bidders':{ policy: 'public', description: 'Anti-shill blocked-bidder registry' },

  // ── Offers ─────────────────────────────────────────────────────────────────
  '/offers': { policy: 'public', description: 'Offer list — public (no private info)' },

  // ── Collections ────────────────────────────────────────────────────────────
  '/collections':                  { policy: 'public', description: 'Collection registry — public' },
  '/collections/{address}/fee':    { policy: 'public', description: 'Per-collection fee override — public' },
  '/collections/{address}/vouchers':{ policy: 'public', description: 'Lazy-mint vouchers — public' },
  '/creators/{address}/collections':{ policy: 'public', description: 'Creator collection list — public' },

  // ── Activity & search ──────────────────────────────────────────────────────
  '/activity/recent': { policy: 'public', description: '20 most-recent marketplace events — public' },
  '/search':          { policy: 'public', description: 'Cross-entity full-text search — public' },

  // ── IPFS ───────────────────────────────────────────────────────────────────
  '/ipfs/{cid}': { policy: 'public', description: 'IPFS metadata cache — public content-addressed' },

  // ── Tokens ─────────────────────────────────────────────────────────────────
  '/tokens':                  { policy: 'public', description: 'Whitelisted token registry — public' },
  '/tokens/{address}/history': { policy: 'public', description: 'Token whitelist event history — public' },

  // ── Stats ──────────────────────────────────────────────────────────────────
  '/stats':                { policy: 'public', description: 'Aggregate marketplace stats' },
  '/stats/overview':       { policy: 'public', description: 'All-time overview stats' },
  '/stats/daily':          { policy: 'public', description: 'Daily stats from materialized view' },
  '/stats/top-collections':{ policy: 'public', description: 'Top collections by volume' },
  '/stats/top-artists':    { policy: 'public', description: 'Top artists by earnings' },

  // ── Artists ────────────────────────────────────────────────────────────────
  '/artists/{address}/metrics': { policy: 'public', description: 'Per-artist performance metrics' },

  // ── Config ─────────────────────────────────────────────────────────────────
  '/config/auction': { policy: 'public', description: 'Global auction config from contract — public' },

  // ── Wallet-private reads (authenticated, wallet header optional) ──────────
  '/wallets/{address}/activity':          { policy: 'authenticated', requiresWallet: false, description: 'Wallet event feed — public address, no PII' },
  '/wallets/{address}/royalty-stats':     { policy: 'authenticated', requiresWallet: false, description: 'Royalty earnings summary' },
  '/wallets/{address}/royalty-breakdown': { policy: 'authenticated', requiresWallet: false, description: 'Per-sale royalty audit trail' },
  '/wallets/{address}/notifications':     { policy: 'authenticated', requiresWallet: false, description: 'Wallet notification feed — pre-classified events' },

  // ── Operational — operator token required ─────────────────────────────────
  '/reconciliation/status':        { policy: 'operator', description: 'Last reconciliation run status' },
  '/backfill/status':              { policy: 'operator', description: 'Active backfill job state' },
  '/keeper/status':                { policy: 'operator', description: 'Keeper running state and recent actions' },
  '/sync/gaps':                    { policy: 'operator', description: 'Ledger gap list' },
  '/sync/gaps/{id}':               { policy: 'operator', description: 'Single ledger gap detail' },
  '/sync/jobs':                    { policy: 'operator', description: 'BackfillJob list' },
  '/sync/jobs/{id}':               { policy: 'operator', description: 'Single BackfillJob detail' },
  '/admin/contracts':              { policy: 'operator', description: 'Tracked contract registry' },
  '/admin/audit':                  { policy: 'operator', description: 'Operational audit log query' },
  '/admin/audit/{requestId}':      { policy: 'operator', description: 'Single audit record by request ID' },
  '/admin/audit/stats':            { policy: 'operator', description: 'Audit statistics summary' },
  '/admin/poller/resume':          { policy: 'operator', description: 'Resume a halted poller' },
  '/admin/poller/halt':            { policy: 'operator', description: 'Manually halt the poller' },
  '/admin/poller/revert':          { policy: 'operator', description: 'Revert poller to earlier ledger' },
  '/admin/gap-repair/trigger':     { policy: 'operator', description: 'Trigger gap repair for a specific gap' },
  '/admin/dead-letters':           { policy: 'operator', description: 'Dead-letter event queue view' },
  '/admin/dead-letters/{id}/replay':{ policy: 'operator', description: 'Replay a dead-letter event' },
  '/admin/query-cost':             { policy: 'operator', description: 'Query cost model diagnostics' },

  // ── Dev-only (excluded from production) ───────────────────────────────────
  '/cors-test': { policy: 'public', description: 'CORS debug — non-production only' },
};

/**
 * Verify that every path in `routePaths` appears in ROUTE_POLICY_MATRIX.
 *
 * Called at startup (index.ts) and in the CI policy-matrix test so that
 * adding a new route without a matrix entry fails the build immediately.
 *
 * Returns the list of unclassified paths. Throws in production.
 */
export function assertAllRoutesClassified(routePaths: string[]): string[] {
  const unclassified: string[] = [];
  for (const path of routePaths) {
    if (!(path in ROUTE_POLICY_MATRIX)) {
      unclassified.push(path);
    }
  }

  if (unclassified.length > 0) {
    const msg = `[auth] Unclassified routes detected — add them to ROUTE_POLICY_MATRIX:\n  ${unclassified.join('\n  ')}`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    }
    logger.warn('auth.unclassified_routes', { event: 'auth.unclassified_routes', paths: unclassified });
  }

  return unclassified;
}
