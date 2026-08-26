/**
 * cache-middleware.ts
 *
 * Express cache middleware backed by Redis with thundering-herd protection.
 *
 * The middleware itself handles the fast-path cache read (Redis GET) and
 * cache write (Redis SETEX after a successful response). Concurrent misses
 * at the middleware layer are NOT coalesced here — coalescing happens inside
 * getCached() from cache-service.ts, which route handlers call directly for
 * expensive queries.
 *
 * This separation keeps the middleware simple and correct:
 *   - Middleware: HTTP caching (Cache-Control semantics, cacheHit flag)
 *   - getCached:  DB coalescing + distributed lock for thundering-herd
 */

import { Request, Response, NextFunction } from 'express';
import redisClient from '../redis.js';

export function isRedisReady(client: any): boolean {
  if (typeof client?.isReady === 'boolean') return client.isReady;
  if (typeof client?.status === 'string') return client.status === 'ready';
  return Boolean(client?.isOpen);
}

/**
 * Cache middleware with TTL support.
 *
 * - Cache hit  → sets res.locals.cacheHit = true, returns cached JSON immediately.
 * - Cache miss → calls next(), intercepts res.json, writes result to Redis.
 * - Redis down → calls next() transparently (degrade gracefully).
 *
 * @param ttl  Cache TTL in seconds
 */
export const cacheMiddleware = (ttl: number) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const client = redisClient as any;
    if (!isRedisReady(client)) {
      return next();
    }

    const cacheKey = `cache:${req.originalUrl || req.url}`;

    try {
      const cachedData = await client.get(cacheKey);
      if (cachedData) {
        res.locals.cacheHit = true;
        return res.json(JSON.parse(cachedData));
      }

      // Cache miss — intercept res.json to write result to Redis on success.
      const originalJson = res.json.bind(res);
      res.json = function (data: any) {
        // Write async, non-blocking. Never poison the cache on write failure.
        client.setEx(cacheKey, ttl, JSON.stringify(data)).catch((err: unknown) => {
          console.error('[cache-middleware] Failed to write cache:', err);
        });
        return originalJson(data);
      };

      next();
    } catch (err: unknown) {
      // Redis error — degrade gracefully, do not block the request.
      console.error('[cache-middleware] Redis error:', err);
      next();
    }
  };
};

/**
 * Invalidate cache keys matching a glob pattern.
 * @param pattern  e.g. "cache:*listing:123*"
 */
export async function invalidateCache(pattern: string): Promise<void> {
  const client = redisClient as any;
  if (!isRedisReady(client)) return;

  try {
    const keys: string[] = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(keys);
    }
  } catch (err: unknown) {
    console.error(`[cache-middleware] Failed to invalidate pattern ${pattern}:`, err);
  }
}

/**
 * Invalidate cache for a specific resource by type and ID.
 */
export async function invalidateCacheForResource(
  resourceType: string,
  resourceId: string | number,
): Promise<void> {
  await invalidateCache(`cache:*${resourceType}:${resourceId}*`);
}
