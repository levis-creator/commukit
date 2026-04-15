import { Global, Module } from '@nestjs/common';
import { MessagingService } from './messaging.service';

@Global()
@Module({
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
