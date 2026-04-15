import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuthorizeUserDto {
  @ApiProperty({
    description: 'Unique identifier for the consumer application.',
    example: 'parliament',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  appId: string;

  @ApiProperty({
    description: 'Domain entity type scoping this room.',
    example: 'sitting',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  contextType: string;

  @ApiProperty({
    description: 'The domain-side user ID (e.g. the parliament member UUID). Used to map to a Matrix identity.',
    example: 'member-uuid-5678',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  domainUserId: string;

  @ApiProperty({
    description:
      'Display name shown in Matrix chat and used for Janus participant matching. ' +
      'Bounded to prevent display-name injection into Matrix or audit logs.',
    example: 'Hon. Jane Doe',
    maxLength: 100,
  })
  /// Bounded so an attacker with a valid internal JWT can't push a huge
  /// display name into Matrix / our DB / audit log metadata.
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  displayName: string;

  @ApiPropertyOptional({
    description:
      'Optional roles for this session. Include "MODERATOR" to grant moderator-level ' +
      'permissions in the room (e.g. Clerk or Speaker accounts).',
    type: [String],
    example: ['MODERATOR'],
    maxItems: 32,
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  @ArrayMaxSize(32)
  @MaxLength(64, { each: true })
  roles?: string[];
}
