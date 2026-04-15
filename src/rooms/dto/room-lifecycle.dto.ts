import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RoomLifecycleDto {
  @ApiProperty({
    description: 'Unique identifier for the consumer application.',
    example: 'my-app',
  })
  @IsString()
  @IsNotEmpty()
  appId: string;

  @ApiProperty({
    description: 'Domain entity type scoping this room.',
    example: 'meeting',
  })
  @IsString()
  @IsNotEmpty()
  contextType: string;
}
