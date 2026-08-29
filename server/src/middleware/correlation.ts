import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';

const VALID_CORRELATION_ID = /^[A-Za-z0-9_-]{8,128}$/;

declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
  }
}

/**
 * Accepts a well-formed inbound correlation ID or mints one, and echoes it on
 * the response so every hop (browser, BFF, downstream service) can be joined
 * in logs.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header(CORRELATION_HEADER);
  const correlationId = inbound && VALID_CORRELATION_ID.test(inbound) ? inbound : randomUUID();
  req.correlationId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  next();
}
