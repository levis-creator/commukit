// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * Cross-cutting observability — honours any inbound `X-Request-Id` the
 * consumer app sends so a single request can be traced end-to-end across
 * the consumer backend, comms-service, and downstream media/chat providers.
 * Generates a UUID when the header is absent.
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
