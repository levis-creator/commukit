// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { IsEnum, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Transport configuration for a communications room. Drives which Janus
 * rooms are provisioned:
 *   - IN_PERSON → AudioBridge only
 *   - REMOTE    → VideoRoom only
 *   - HYBRID    → AudioBridge + VideoRoom
 */
export enum RoomMode {
  IN_PERSON = 'IN_PERSON',
  HYBRID = 'HYBRID',
  REMOTE = 'REMOTE',
  /** Chat-only: provisions a Matrix room with no Janus audio/video. */
  CHAT = 'CHAT',
}

export class ProvisionRoomDto {
  @ApiProperty({
    description: 'Unique identifier for the consumer application (e.g. "meetings-app", "my-saas").',
    example: 'my-app',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  appId: string;

  @ApiProperty({
    description: 'Domain entity type scoping this room (e.g. "meeting", "room", "session").',
    example: 'meeting',
    maxLength: 64,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  contextType: string;

  @ApiProperty({
    description: 'Unique identifier of the domain entity (e.g. the meeting UUID).',
    example: 'meeting-uuid-1234',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  contextId: string;

  @ApiProperty({
    description: 'Human-readable title used as the chat room name.',
    example: 'Weekly Product Sync',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({
    description:
      'Transport mode controlling which Janus rooms are provisioned. ' +
      'IN_PERSON → AudioBridge only; REMOTE → VideoRoom only; HYBRID → both.',
    enum: RoomMode,
    example: RoomMode.HYBRID,
  })
  @IsEnum(RoomMode)
  mode: RoomMode;
}
