// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { PrismaService } from '../database/prisma.service';
import { MessagingService } from '../messaging/messaging.service';
import { RedisService } from '../redis/redis.service';
import { CHAT_PROVIDER, MEDIA_PROVIDER } from '../providers/tokens';
import type { ChatProvider } from '../providers/chat-provider.interface';
import type { MediaProvider } from '../providers/media-provider.interface';
import { RoomMode } from './dto/provision-room.dto';
import { CommunicationRole } from './dto/authorize-user.dto';

describe('RoomsService', () => {
  let service: RoomsService;
  let prisma: jest.Mocked<PrismaService>;
  let matrix: jest.Mocked<ChatProvider>;
  let janus: jest.Mocked<MediaProvider>;
  let messaging: jest.Mocked<MessagingService>;

  const mockRoom = {
    id: 'room-uuid-1',
    appId: 'parliament',
    contextType: 'SITTING',
    contextId: 'sitting-uuid-1',
    title: 'Regular Sitting',
    mode: 'REMOTE',
    status: 'PROVISIONED',
    matrixRoomId: '!abc:parliament.local',
    audioRoomId: null,
    videoRoomId: 123456,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoomsService,
        {
          provide: PrismaService,
          useValue: {
            communicationRoom: {
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            communicationUser: {
              findUnique: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
            },
            communicationMembership: {
              upsert: jest.fn(),
              findUnique: jest.fn(),
              findMany: jest.fn().mockResolvedValue([]),
            },
            communicationAuditLog: {
              create: jest.fn().mockResolvedValue({}),
            },
          },
        },
        {
          provide: CHAT_PROVIDER,
          useValue: {
            id: 'matrix',
            ensureRoom: jest.fn(),
            ensureUserToken: jest.fn(),
            inviteAndJoin: jest.fn(),
            updateDisplayName: jest.fn().mockResolvedValue(true),
            logoutMember: jest.fn(),
            isAvailable: jest.fn(),
            publicServerUrl: 'http://matrix:8020',
            serverName: 'parliament.local',
          },
        },
        {
          provide: RedisService,
          useValue: {
            isReady: jest.fn().mockReturnValue(false),
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(true),
            setIfAbsent: jest.fn().mockResolvedValue(true),
            del: jest.fn(),
          },
        },
        {
          provide: MEDIA_PROVIDER,
          useValue: {
            id: 'janus',
            ensureAudioBridgeRoom: jest.fn(),
            ensureVideoRoom: jest.fn(),
            destroyVideoRoom: jest.fn().mockResolvedValue(undefined),
            listParticipants: jest.fn(),
            listVideoParticipants: jest.fn(),
            muteParticipant: jest.fn(),
            unmuteParticipant: jest.fn(),
            muteRoom: jest.fn(),
            kickAudioParticipant: jest.fn(),
            kickVideoParticipant: jest.fn(),
            isAvailable: jest.fn(),
            buildIceServers: jest.fn(),
            wsUrl: 'ws://janus:8188',
          },
        },
        {
          provide: MessagingService,
          useValue: {
            publish: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(RoomsService);
    prisma = module.get(PrismaService);
    matrix = module.get(CHAT_PROVIDER);
    janus = module.get(MEDIA_PROVIDER);
    messaging = module.get(MessagingService);
  });

  // ── provision ──────────────────────────────────────────────────────────────

  describe('provision', () => {
    const dto = {
      appId: 'parliament',
      contextType: 'SITTING',
      contextId: 'sitting-uuid-1',
      title: 'Regular Sitting',
      mode: RoomMode.REMOTE,
    };

    it('should be idempotent — returns existing room', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(mockRoom);

      const result = await service.provision(dto);

      expect(result).toEqual({ roomId: 'room-uuid-1', status: 'PROVISIONED' });
      expect(prisma.communicationRoom.create).not.toHaveBeenCalled();
    });

    it('should reject mode change on existing room', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(mockRoom);

      await expect(
        service.provision({ ...dto, mode: RoomMode.IN_PERSON }),
      ).rejects.toThrow(ConflictException);
    });

    it('should create correct transports for REMOTE mode', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(null);
      (matrix.ensureRoom as jest.Mock).mockResolvedValue('!new:parliament.local');
      (janus.ensureVideoRoom as jest.Mock).mockResolvedValue(789);
      (prisma.communicationRoom.create as jest.Mock).mockResolvedValue({
        ...mockRoom,
        id: 'new-room',
        matrixRoomId: '!new:parliament.local',
        videoRoomId: 789,
      });

      await service.provision(dto);

      expect(matrix.ensureRoom).toHaveBeenCalledWith(
        'parliament',
        'sitting-uuid-1',
        'Regular Sitting',
      );
      expect(janus.ensureVideoRoom).toHaveBeenCalledWith('sitting-uuid-1');
      expect(janus.ensureAudioBridgeRoom).not.toHaveBeenCalled();
    });

    it('should create correct transports for IN_PERSON mode', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(null);
      (matrix.ensureRoom as jest.Mock).mockResolvedValue('!room:local');
      (janus.ensureAudioBridgeRoom as jest.Mock).mockResolvedValue(456);
      (prisma.communicationRoom.create as jest.Mock).mockResolvedValue({
        ...mockRoom,
        mode: 'IN_PERSON',
        audioRoomId: 456,
        videoRoomId: null,
      });

      await service.provision({ ...dto, mode: RoomMode.IN_PERSON });

      expect(janus.ensureAudioBridgeRoom).toHaveBeenCalled();
      expect(janus.ensureVideoRoom).not.toHaveBeenCalled();
    });

    it('should create both transports for HYBRID mode', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(null);
      (matrix.ensureRoom as jest.Mock).mockResolvedValue('!room:local');
      (janus.ensureAudioBridgeRoom as jest.Mock).mockResolvedValue(111);
      (janus.ensureVideoRoom as jest.Mock).mockResolvedValue(222);
      (prisma.communicationRoom.create as jest.Mock).mockResolvedValue({
        ...mockRoom,
        mode: 'HYBRID',
        audioRoomId: 111,
        videoRoomId: 222,
      });

      await service.provision({ ...dto, mode: RoomMode.HYBRID });

      expect(janus.ensureAudioBridgeRoom).toHaveBeenCalled();
      expect(janus.ensureVideoRoom).toHaveBeenCalled();
    });

    it('should publish communications.room.provisioned event', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(null);
      (matrix.ensureRoom as jest.Mock).mockResolvedValue(null);
      (janus.ensureVideoRoom as jest.Mock).mockResolvedValue(null);
      (prisma.communicationRoom.create as jest.Mock).mockResolvedValue({
        ...mockRoom,
        id: 'new-room',
      });

      await service.provision(dto);

      expect(messaging.publish).toHaveBeenCalledWith(
        'communications.room.provisioned',
        expect.objectContaining({ contextId: 'sitting-uuid-1' }),
      );
    });
  });

  // ── activate ───────────────────────────────────────────────────────────────

  describe('activate', () => {
    it('should transition PROVISIONED → ACTIVE', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(mockRoom);
      (prisma.communicationRoom.update as jest.Mock).mockResolvedValue({
        ...mockRoom,
        status: 'ACTIVE',
      });

      const result = await service.activate('sitting-uuid-1', 'parliament', 'SITTING');

      expect(result.status).toBe('ACTIVE');
      expect(prisma.communicationRoom.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'ACTIVE' } }),
      );
    });

    it('should reject activation of non-PROVISIONED room', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue({
        ...mockRoom,
        status: 'ACTIVE',
      });

      await expect(
        service.activate('sitting-uuid-1', 'parliament', 'SITTING'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for unknown room', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.activate('unknown', 'parliament', 'SITTING'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── close ──────────────────────────────────────────────────────────────────

  describe('close', () => {
    it('should transition ACTIVE → CLOSED', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue({
        ...mockRoom,
        status: 'ACTIVE',
      });
      (prisma.communicationRoom.update as jest.Mock).mockResolvedValue({
        ...mockRoom,
        status: 'CLOSED',
      });

      const result = await service.close('sitting-uuid-1', 'parliament', 'SITTING');

      expect(result.status).toBe('CLOSED');
    });

    it('should destroy VideoRoom on close', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue({
        ...mockRoom,
        status: 'ACTIVE',
        videoRoomId: 123456,
      });
      (prisma.communicationRoom.update as jest.Mock).mockResolvedValue({
        ...mockRoom,
        status: 'CLOSED',
      });

      await service.close('sitting-uuid-1', 'parliament', 'SITTING');

      expect(janus.destroyVideoRoom).toHaveBeenCalledWith('sitting-uuid-1', 123456);
    });

    it('should reject closing already CLOSED room', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue({
        ...mockRoom,
        status: 'CLOSED',
      });

      await expect(
        service.close('sitting-uuid-1', 'parliament', 'SITTING'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── authorizeUser ──────────────────────────────────────────────────────────

  describe('authorizeUser', () => {
    const dto = {
      appId: 'parliament',
      contextType: 'SITTING',
      domainUserId: 'user-uuid-1',
      displayName: 'Hon. Kimani',
      roles: [CommunicationRole.PARTICIPANT],
    };

    const activeRoom = { ...mockRoom, status: 'ACTIVE' };
    const commUser = {
      id: 'comm-user-1',
      appId: 'parliament',
      domainUserId: 'user-uuid-1',
      matrixUserId: '@parliament_user1:parliament.local',
      displayName: 'Hon. Kimani',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(activeRoom);
      (prisma.communicationUser.findUnique as jest.Mock).mockResolvedValue(commUser);
      (prisma.communicationMembership.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.communicationMembership.upsert as jest.Mock).mockResolvedValue({});
      (janus.isAvailable as jest.Mock).mockReturnValue(true);
      (janus.buildIceServers as jest.Mock).mockReturnValue([
        { urls: ['stun:stun.l.google.com:19302'] },
      ]);
      // `authorizeUser` re-calls `ensureAudioBridgeRoom` / `ensureVideoRoom`
      // with the persisted room refs to reconcile live state. Default each
      // mock to echo whatever the caller passed so sessions report
      // `available`. Individual tests override when they need a specific ID.
      (janus.ensureAudioBridgeRoom as jest.Mock).mockImplementation(
        async (_ctx: string, knownRoomId?: number | null) => knownRoomId ?? 0,
      );
      (janus.ensureVideoRoom as jest.Mock).mockImplementation(
        async (_ctx: string, knownRoomId?: number | null) => knownRoomId ?? 0,
      );
    });

    it('should return full session with available capabilities', async () => {
      (matrix.ensureUserToken as jest.Mock).mockResolvedValue({
        accessToken: 'syt_token',
        matrixUserId: '@parliament_user1:parliament.local',
      });

      const session = await service.authorizeUser('sitting-uuid-1', dto);

      expect(session.roomId).toBe('room-uuid-1');
      expect(session.chat?.status).toBe('available');
      expect(session.chat?.accessToken).toBe('syt_token');
      expect(session.videoRoom?.status).toBe('available');
      expect(session.videoRoom?.iceServers).toHaveLength(1);
      expect(session.audioBridge).toBeNull(); // REMOTE mode
      expect(session.modeImmutable).toBe(true);
    });

    it('should create membership record (idempotent)', async () => {
      (matrix.ensureUserToken as jest.Mock).mockResolvedValue({
        accessToken: 'syt_token',
        matrixUserId: '@parliament_user1:parliament.local',
      });

      await service.authorizeUser('sitting-uuid-1', dto);

      expect(prisma.communicationMembership.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { roomId_userId: { roomId: 'room-uuid-1', userId: 'comm-user-1' } },
        }),
      );
    });

    it('should return chat unavailable when Matrix is down', async () => {
      (matrix.ensureUserToken as jest.Mock).mockResolvedValue(null);

      const session = await service.authorizeUser('sitting-uuid-1', dto);

      expect(session.chat?.status).toBe('unavailable');
      expect(session.chat?.reason).toContain('unreachable');
      // Video should still work
      expect(session.videoRoom?.status).toBe('available');
    });

    it('should return videoRoom unavailable when Janus is down', async () => {
      (matrix.ensureUserToken as jest.Mock).mockResolvedValue({
        accessToken: 'syt_token',
        matrixUserId: '@parliament_user1:parliament.local',
      });
      (janus.isAvailable as jest.Mock).mockReturnValue(false);

      const session = await service.authorizeUser('sitting-uuid-1', dto);

      expect(session.videoRoom?.status).toBe('unavailable');
      // Chat should still work
      expect(session.chat?.status).toBe('available');
    });

    it('should reject authorization for CLOSED room', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue({
        ...mockRoom,
        status: 'CLOSED',
      });

      await expect(
        service.authorizeUser('sitting-uuid-1', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create new communication user on first authorize', async () => {
      (prisma.communicationUser.findUnique as jest.Mock).mockResolvedValue(null);
      (matrix.ensureUserToken as jest.Mock).mockResolvedValue({
        accessToken: 'syt_token',
        matrixUserId: '@parliament_newuser:parliament.local',
      });
      (prisma.communicationUser.create as jest.Mock).mockResolvedValue({
        ...commUser,
        id: 'new-comm-user',
      });

      await service.authorizeUser('sitting-uuid-1', dto);

      expect(prisma.communicationUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            appId: 'parliament',
            domainUserId: 'user-uuid-1',
            displayName: 'Hon. Kimani',
          }),
        }),
      );
    });

    it('should include audioBridge for HYBRID room', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue({
        ...activeRoom,
        mode: 'HYBRID',
        audioRoomId: 555,
        videoRoomId: 666,
      });
      (matrix.ensureUserToken as jest.Mock).mockResolvedValue({
        accessToken: 'syt_token',
        matrixUserId: '@parliament_user1:parliament.local',
      });

      const session = await service.authorizeUser('sitting-uuid-1', dto);

      expect(session.audioBridge?.status).toBe('available');
      expect(session.audioBridge?.roomId).toBe(555);
      expect(session.videoRoom?.status).toBe('available');
      expect(session.videoRoom?.roomId).toBe(666);
    });

    it('should return LiveKit credentials when the active media provider is livekit', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue({
        ...activeRoom,
        mode: 'HYBRID',
        audioRoomId: 555,
        videoRoomId: 666,
      });
      (matrix.ensureUserToken as jest.Mock).mockResolvedValue({
        accessToken: 'syt_token',
        matrixUserId: '@parliament_user1:parliament.local',
      });
      (janus as any).id = 'livekit';
      (janus as any).wsUrl = 'wss://livekit.example.com';
      (janus as any).roomNameFor = jest.fn((roomId: number) => `comms-${roomId}`);
      (janus as any).createParticipantToken = jest
        .fn()
        .mockResolvedValue('livekit.jwt.token');

      const session = await service.authorizeUser('sitting-uuid-1', dto);

      expect(session.audioBridge?.credentials).toEqual({
        provider: 'livekit',
        room: 'comms-555',
        url: 'wss://livekit.example.com',
        token: 'livekit.jwt.token',
      });
      expect(session.videoRoom?.credentials).toEqual({
        provider: 'livekit',
        room: 'comms-666',
        url: 'wss://livekit.example.com',
        token: 'livekit.jwt.token',
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
      });
    });
  });

  // ── Multi-app isolation ────────────────────────────────────────────────────
  //
  // Regression suite proving that a non-parliament consumer can use the same
  // communications service without colliding on rooms, authorization, or
  // rate limits. Each assertion below targets a specific isolation contract
  // that a new consumer app depends on.

  describe('multi-app isolation', () => {
    const meetingsRoom = {
      id: 'meeting-room-uuid',
      appId: 'meetings',
      contextType: 'MEETING',
      contextId: 'meeting-abc',
      title: 'Product Sync',
      mode: 'HYBRID',
      status: 'ACTIVE',
      matrixRoomId: '!meeting:matrix.local',
      audioRoomId: 777,
      videoRoomId: 888,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('provisions rooms for non-parliament consumers', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(null);
      (matrix.ensureRoom as jest.Mock).mockResolvedValue('!meeting:matrix.local');
      (janus.ensureAudioBridgeRoom as jest.Mock).mockResolvedValue(777);
      (janus.ensureVideoRoom as jest.Mock).mockResolvedValue(888);
      (prisma.communicationRoom.create as jest.Mock).mockResolvedValue(
        meetingsRoom,
      );

      await service.provision({
        appId: 'meetings',
        contextType: 'MEETING',
        contextId: 'meeting-abc',
        title: 'Product Sync',
        mode: RoomMode.HYBRID,
      });

      // Matrix room provisioned with the caller's appId so alias collisions
      // across consumer apps are impossible.
      expect(matrix.ensureRoom).toHaveBeenCalledWith(
        'meetings',
        'meeting-abc',
        'Product Sync',
      );

      // Prisma row persisted with appId + the new `mode` field name.
      expect(prisma.communicationRoom.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            appId: 'meetings',
            contextType: 'MEETING',
            mode: RoomMode.HYBRID,
          }),
        }),
      );

      // Event payload uses the new `mode` key (with legacy alias for
      // backwards-compatible consumers).
      expect(messaging.publish).toHaveBeenCalledWith(
        'communications.room.provisioned',
        expect.objectContaining({ appId: 'meetings', mode: RoomMode.HYBRID }),
      );
    });

    it('rejects authorize-user for a CLOSED non-parliament room', async () => {
      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue({
        ...meetingsRoom,
        status: 'CLOSED',
      });

      await expect(
        service.authorizeUser('meeting-abc', {
          appId: 'meetings',
          contextType: 'MEETING',
          domainUserId: 'user-42',
          displayName: 'Alice',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('scopes the authorize cooldown by appId', async () => {
      const setIfAbsent = jest.fn().mockResolvedValue(true);
      (service as any).redis.setIfAbsent = setIfAbsent;
      (service as any).redis.isReady = jest.fn().mockReturnValue(true);

      (prisma.communicationRoom.findUnique as jest.Mock).mockResolvedValue(
        meetingsRoom,
      );
      (prisma.communicationUser.findUnique as jest.Mock).mockResolvedValue({
        id: 'comm-user-meetings',
        appId: 'meetings',
        domainUserId: 'user-42',
        matrixUserId: '@comms_user42:matrix.local',
        displayName: 'Alice',
        matrixDisplayName: 'Alice',
        matrixPassword: 'stored-pw',
      });
      (matrix.ensureUserToken as jest.Mock).mockResolvedValue({
        accessToken: 'syt',
        matrixUserId: '@comms_user42:matrix.local',
        password: null,
      });

      await service.authorizeUser('meeting-abc', {
        appId: 'meetings',
        contextType: 'MEETING',
        domainUserId: 'user-42',
        displayName: 'Alice',
      });

      expect(setIfAbsent).toHaveBeenCalledWith(
        'comms:authorize:cooldown:meetings:meeting-abc:user-42',
        '1',
        10,
      );
    });
  });
});
