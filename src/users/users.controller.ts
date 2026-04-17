// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import {
  Body,
  Controller,
  Optional,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InternalJwtGuard } from '../auth/internal-jwt.guard';
import { PrismaService } from '../database/prisma.service';
import { SipService } from '../sip/sip.service';
import { GetSipCredentialsDto } from './dto/sip-credentials.dto';

/**
 * Internal users controller — exposes user-scoped operations that aren't
 * tied to a specific room.
 *
 * Currently hosts the standalone `sip-credentials` endpoint which consumer
 * apps call to fetch SIP softphone credentials for a domain user outside
 * of any room-authorize flow (e.g. for a "connect your softphone" settings
 * screen).
 *
 * All routes require a valid internal JWT (same pattern as RoomsController).
 */
@ApiTags('Users (Internal)')
@ApiBearerAuth()
@UseGuards(InternalJwtGuard)
@Controller('internal/v1/users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly sip?: SipService,
  ) {}

  /**
   * Returns (or lazily mints) SIP credentials for a domain user.
   *
   * Response shape matches the `sip` field of `authorize-user` so consumer
   * apps can reuse the same rendering code in both contexts.
   */
  @Post('sip-credentials')
  @ApiOperation({
    summary: 'Get SIP credentials for a user',
    description:
      'Returns SIP DIGEST credentials that the caller can hand to the user ' +
      "so they can configure a free SIP softphone (Linphone, Zoiper, MicroSIP, " +
      'Jitsi, Bria) against the self-hosted registrar. ' +
      'Idempotent — calling repeatedly returns the same username. ' +
      'Returns 503 when SIP is disabled in this deployment.',
  })
  @ApiResponse({ status: 200, description: 'SIP session credentials' })
  @ApiResponse({ status: 503, description: 'SIP disabled in this deployment' })
  async getSipCredentials(@Body() dto: GetSipCredentialsDto) {
    if (!this.sip) {
      throw new ServiceUnavailableException('SIP disabled');
    }

    // Ensure a CommunicationUser row exists (idempotent). We write this row
    // directly here rather than through RoomsService.authorizeUser because
    // there's no room in play — this is a pre-room "hand the user their
    // softphone creds" flow.
    let commUser = await this.prisma.communicationUser.findUnique({
      where: {
        appId_domainUserId: {
          appId: dto.appId,
          domainUserId: dto.domainUserId,
        },
      },
    });

    if (!commUser) {
      commUser = await this.prisma.communicationUser.create({
        data: {
          appId: dto.appId,
          domainUserId: dto.domainUserId,
          displayName: dto.displayName,
          participantType: 'DOMAIN',
        },
      });
    } else if (commUser.displayName !== dto.displayName) {
      commUser = await this.prisma.communicationUser.update({
        where: { id: commUser.id },
        data: { displayName: dto.displayName },
      });
    }

    const sipResult = await this.sip.ensureUserCredentials(
      dto.appId,
      dto.domainUserId,
      dto.displayName,
      commUser.sipPassword ?? null,
      commUser.sipUsername ?? null,
    );

    if (!sipResult) {
      return { status: 'unavailable', reason: 'SIP credential provisioning failed' };
    }

    // Persist any new fields back to the user row.
    const updates: Record<string, any> = {};
    if (sipResult.provider === 'janus') {
      if (!commUser.sipUsername) updates.sipUsername = sipResult.username;
      if (sipResult.password) updates.sipPassword = sipResult.password;
      if (commUser.sipDisplayName !== dto.displayName) {
        updates.sipDisplayName = dto.displayName;
      }
      if (Object.keys(updates).length > 0) {
        commUser = await this.prisma.communicationUser.update({
          where: { id: commUser.id },
          data: updates,
        });
      }
    }

    const password =
      sipResult.password ??
      (sipResult.provider === 'janus' ? commUser.sipPassword : null);
    if (!password) {
      return { status: 'unavailable', reason: 'SIP credential provisioning failed' };
    }

    return this.sip.buildSessionDescriptor({
      username: sipResult.username,
      password,
    }, null, null);
  }
}
