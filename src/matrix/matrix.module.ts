import { Global, Module } from '@nestjs/common';
import { MatrixService } from './matrix.service';

@Global()
@Module({
  providers: [MatrixService],
  exports: [MatrixService],
})
export class MatrixModule {}
