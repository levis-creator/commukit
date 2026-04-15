import { Global, Module } from '@nestjs/common';
import { InternalJwtGuard } from './internal-jwt.guard';

@Global()
@Module({
  providers: [InternalJwtGuard],
  exports: [InternalJwtGuard],
})
export class AuthModule {}
