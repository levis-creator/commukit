import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { RoomLifecycleDto } from './room-lifecycle.dto';

export class MicControlDto extends RoomLifecycleDto {
  @ApiProperty({
    description: 'The domain-side user ID of the participant to target.',
    example: 'member-uuid-5678',
  })
  @IsString()
  @IsNotEmpty()
  domainUserId: string;
}
