import { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';

export const ErrorCode = {
  BAD_REQUEST:  'BAD_REQUEST',
  NOT_FOUND:    'NOT_FOUND',
  INTERNAL:     'INTERNAL_SERVER_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN:    'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMIT_EXCEEDED',
  QUERY_TOO_EXPENSIVE: 'QUERY_TOO_EXPENSIVE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ── Error classification ──────────────────────────────────────────────────────
//
// Two operational buckets: CLIENT_ERROR (4xx — caller's fault, not paged) and
// SERVER_ERROR (5xx — our fault, paged). Used in structured log lines so
// dashboards can route alerts without re-parsing status codes.

export type ErrorClass = 'CLIENT_ERROR' | 'SERVER_ERROR';

function classifyError(statusCode: number): ErrorClass {
  return statusCode >= 500 ? 'SERVER_ERROR' : 'CLIENT_ERROR';
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, ErrorCode.BAD_REQUEST, message, details);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, ErrorCode.NOT_FOUND, message);
}

export function unauthorized(message = 'Missing or invalid credentials'): ApiError {
  return new ApiError(401, ErrorCode.UNAUTHORIZED, message);
}

export function forbidden(message = 'Insufficient permissions'): ApiError {
  return new ApiError(403, ErrorCode.FORBIDDEN, message);
}

export function internalError(message = 'An unexpected error occurred'): ApiError {
  return new ApiError(500, ErrorCode.INTERNAL, message);
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return internalError();
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const apiErr = toApiError(err);
  const requestId: string | undefined = res.locals.requestId as string | undefined;
  const errorClass = classifyError(apiErr.statusCode);

  // Structured operational log — server errors include the original cause so
  // on-call engineers can triage without accessing raw stdout.
  if (apiErr.statusCode >= 500) {
    logger.error('request error', {
      requestId,
      errorClass,
      statusCode: apiErr.statusCode,
      code: apiErr.code,
      message: apiErr.message,
      path: req.path,
      method: req.method,
      // Safe: only include stack when not in production so CI logs are useful
      // but production logs never contain internal file paths.
      ...(process.env.NODE_ENV !== 'production' && err instanceof Error
        ? { stack: err.stack }
        : {}),
    });
  } else {
    // Client errors at debug level — useful for abuse detection but not noisy
    // in normal operational dashboards.
    logger.debug('client error', {
      requestId,
      errorClass,
      statusCode: apiErr.statusCode,
      code: apiErr.code,
      message: apiErr.message,
      path: req.path,
      method: req.method,
    });
  }

  type ErrorBody = {
    error: {
      code: string;
      message: string;
      requestId?: string;
      class: ErrorClass;
      details?: unknown;
    };
  };

  const body: ErrorBody = {
    error: {
      code:    apiErr.code,
      message: apiErr.message,
      class:   errorClass,
      // Include correlation ID so clients can reference it when reporting issues.
      ...(requestId ? { requestId } : {}),
    },
  };

  // Surface structured validation details for 4xx but never for 5xx (leak prevention).
  if (apiErr.statusCode < 500 && apiErr.details !== undefined) {
    body.error.details = apiErr.details;
  }

  res.status(apiErr.statusCode).json(body);
}
