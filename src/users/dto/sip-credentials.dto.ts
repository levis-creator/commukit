// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Request body for `POST /internal/v1/users/sip-credentials`.
 *
 * Returns SIP credentials for a domain user without authorizing them for
 * any specific room. Useful for consumer apps that want to show "configure
 * your softphone" instructions in a settings screen outside the room flow.
 *
 * The credentials are idempotent: calling this endpoint repeatedly for the
 * same domain user returns the same username, and only mints a new password
 * on first call. Subsequent calls return `password: <the one already on file>`.
 *
 * Available only when `SIP_ENABLED=true`. Returns 503 otherwise.
 */
export class GetSipCredentialsDto {
  @ApiProperty({
    description: 'Consumer application identifier (same value used when provisioning rooms).',
    example: 'myapp',
    maxLength: 64,
  })
  @IsString()
  @Length(1, 64)
  appId!: string;

  @ApiProperty({
    description: 'Stable domain user ID from the consumer app.',
    example: 'user-uuid-1234',
    maxLength: 128,
  })
  @IsString()
  @Length(1, 128)
  // Disallow pipe character to prevent display-name parser poisoning when
  // the user later joins AudioBridge via SIP.
  @Matches(/^[^|]+$/, {
    message: 'domainUserId must not contain "|"',
  })
  domainUserId!: string;

  @ApiProperty({
    description: 'Human-readable display name the softphone should advertise.',
    example: 'Jane Doe',
    maxLength: 200,
  })
  @IsString()
  @Length(1, 200)
  @Matches(/^[^|]+$/, {
    message: 'displayName must not contain "|"',
  })
  displayName!: string;
}
