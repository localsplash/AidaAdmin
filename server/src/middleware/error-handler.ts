import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../logger.js';

/**
 * Terminal error handler: logs the full error server-side and returns a safe,
 * correlation-tagged body with no stack traces or internal detail.
 */
export function createErrorHandler(logger: Logger) {
  return function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
    logger.error({ err, correlationId: req.correlationId, path: req.path }, 'unhandled error');
    if (res.headersSent) {
      return;
    }
    res.status(500).json({
      error: 'internal_error',
      message: 'An unexpected error occurred',
      correlationId: req.correlationId,
    });
  };
}
