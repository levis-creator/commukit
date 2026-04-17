// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum CommunicationRole {
  MODERATOR = 'MODERATOR',
  PARTICIPANT = 'PARTICIPANT',
  OBSERVER = 'OBSERVER',
}

export class AuthorizeUserDto {
  @ApiProperty({
    description: 'Unique identifier for the consumer application.',
    example: 'my-app',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  appId: string;

  @ApiProperty({
    description: 'Domain entity type scoping this room.',
    example: 'meeting',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  contextType: string;

  @ApiProperty({
    description: 'The domain-side user ID used to map to a chat identity (e.g. your app\'s user UUID).',
    example: 'user-uuid-5678',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  domainUserId: string;

  @ApiProperty({
    description:
      'Display name shown in chat and used for audio/video participant matching. ' +
      'Bounded to prevent display-name injection into the chat provider or audit logs.',
    example: 'Jane Doe',
    maxLength: 100,
  })
  /// Bounded so an attacker with a valid internal JWT can't push a huge
  /// display name into the chat provider / our DB / audit log metadata.
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  displayName: string;

  @ApiPropertyOptional({
    description:
      'Optional roles for this session. Include "MODERATOR" to grant moderator-level ' +
      'permissions in the room.',
    type: [String],
    example: ['MODERATOR'],
    maxItems: 32,
  })
  @IsArray()
  @IsEnum(CommunicationRole, { each: true })
  @IsOptional()
  @ArrayMaxSize(32)
  roles?: CommunicationRole[];
}
