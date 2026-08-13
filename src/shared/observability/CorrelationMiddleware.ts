import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { CorrelationContext } from './CorrelationContext';

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Respeita o `x-correlation-id` do provedor quando presente, para o mesmo id
 * atravessar API, fila, outbox e worker.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId =
      (Array.isArray(incoming) ? incoming[0] : incoming) ?? CorrelationContext.newCorrelationId();

    res.setHeader(CORRELATION_HEADER, correlationId);

    CorrelationContext.run({ correlationId }, () => {
      next();
    });
  }
}
