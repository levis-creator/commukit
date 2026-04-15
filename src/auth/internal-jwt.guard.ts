import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

/**
 * Validates internal service-to-service JWTs.
 *
 * Expects `Authorization: Bearer <token>` where the token is signed with
 * `INTERNAL_SERVICE_SECRET` and has `aud: "communications-service"`.
 */
@Injectable()
export class InternalJwtGuard implements CanActivate {
  private readonly logger = new Logger(InternalJwtGuard.name);
  private readonly secret: string;

  constructor() {
    this.secret = process.env.INTERNAL_SERVICE_SECRET ?? '';
    if (!this.secret) {
      this.logger.warn(
        'INTERNAL_SERVICE_SECRET is not set. Internal endpoints will reject all requests.',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers?.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing internal authorization token');
    }

    const token = authHeader.slice(7);

    try {
      const payload = jwt.verify(token, this.secret, {
        audience: 'communications-service',
      });
      request.internalCaller = payload;
      return true;
    } catch (err) {
      this.logger.warn(
        `Internal JWT validation failed: ${err instanceof Error ? err.message : err}`,
      );
      throw new UnauthorizedException('Invalid internal authorization token');
    }
  }
}
