import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * Phase 6 cross-cutting observability — re-uses the parliament backend's
 * `X-Request-Id` when present so a single request is traceable across
 * comms + parliament + matrix + janus.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const requestId =
      (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID();
    (req as any).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const started = Date.now();
    this.logger.log(`[${requestId}] ← ${req.method} ${req.originalUrl}`);
    res.on('finish', () => {
      const elapsed = Date.now() - started;
      const line = `[${requestId}] → ${req.method} ${req.originalUrl} ${res.statusCode} ${elapsed}ms`;
      if (res.statusCode >= 500) this.logger.error(line);
      else if (res.statusCode >= 400) this.logger.warn(line);
      else this.logger.log(line);
    });
    next();
  }
}
