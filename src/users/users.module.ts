import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';

/**
 * UsersModule — hosts user-scoped internal endpoints that aren't tied to
 * a specific room.
 *
 * Currently just the `sip-credentials` controller. Kept in its own module
 * so it has a clean boundary to grow into (e.g. future per-user matrix
 * credential endpoints, user deprovisioning, etc.).
 *
 * The controller injects `SipService` with `@Optional()` so this module
 * loads safely whether or not SIP is enabled.
 */
@Module({
  controllers: [UsersController],
})
export class UsersModule {}
