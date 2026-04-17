// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { InternalJwtGuard } from '../auth/internal-jwt.guard';
import { RoomMode } from './dto/provision-room.dto';

describe('RoomsController', () => {
  let controller: RoomsController;
  let service: jest.Mocked<RoomsService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RoomsController],
      providers: [
        {
          provide: RoomsService,
          useValue: {
            provision: jest.fn(),
            activate: jest.fn(),
            close: jest.fn(),
            authorizeUser: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(InternalJwtGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(RoomsController);
    service = module.get(RoomsService);
  });

  describe('provision', () => {
    it('should delegate to RoomsService.provision', async () => {
      (service.provision as jest.Mock).mockResolvedValue({
        roomId: 'room-1',
        status: 'PROVISIONED',
      });

      const result = await controller.provision({
        appId: 'parliament',
        contextType: 'SITTING',
        contextId: 'sitting-1',
        title: 'Test Sitting',
        mode: RoomMode.REMOTE,
      });

      expect(result).toEqual({ roomId: 'room-1', status: 'PROVISIONED' });
    });
  });

  describe('activate', () => {
    it('should delegate to RoomsService.activate', async () => {
      (service.activate as jest.Mock).mockResolvedValue({
        roomId: 'room-1',
        status: 'ACTIVE',
      });

      const result = await controller.activate('sitting-1', {
        appId: 'parliament',
        contextType: 'SITTING',
      });

      expect(result.status).toBe('ACTIVE');
    });
  });

  describe('close', () => {
    it('should delegate to RoomsService.close', async () => {
      (service.close as jest.Mock).mockResolvedValue({
        roomId: 'room-1',
        status: 'CLOSED',
      });

      const result = await controller.close('sitting-1', {
        appId: 'parliament',
        contextType: 'SITTING',
      });

      expect(result.status).toBe('CLOSED');
    });
  });

  describe('authorizeUser', () => {
    it('should delegate to RoomsService.authorizeUser', async () => {
      const sessionResponse = {
        roomId: 'room-1',
        status: 'ACTIVE',
        chat: { status: 'available' as const },
        audioBridge: null,
        videoRoom: { status: 'available' as const, roomId: 123, wsUrl: 'ws://janus', iceServers: [] },
        modeImmutable: true,
      };
      (service.authorizeUser as jest.Mock).mockResolvedValue(sessionResponse);

      const result = await controller.authorizeUser('sitting-1', {
        appId: 'parliament',
        contextType: 'SITTING',
        domainUserId: 'user-1',
        displayName: 'Hon. Test',
      });

      expect(result.chat?.status).toBe('available');
      expect(result.videoRoom?.status).toBe('available');
    });
  });

  // /messages proxy removed — clients now paginate Matrix directly.
});

describe('InternalJwtGuard', () => {
  let guard: InternalJwtGuard;

  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'test-secret';
    guard = new InternalJwtGuard();
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_SECRET;
  });

  it('should reject requests without authorization header', () => {
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {} }),
      }),
    } as any;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject requests with invalid token', () => {
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: 'Bearer invalid-token' },
        }),
      }),
    } as any;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should accept valid internal JWT', () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { iss: 'parliament-backend' },
      'test-secret',
      { audience: 'communications-service', expiresIn: '60s' },
    );

    const request = {
      headers: { authorization: `Bearer ${token}` },
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as any;

    expect(guard.canActivate(context)).toBe(true);
    expect(request['internalCaller']).toBeDefined();
    expect(request['internalCaller'].iss).toBe('parliament-backend');
  });

  it('should reject JWT with wrong audience', () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { iss: 'parliament-backend' },
      'test-secret',
      { audience: 'wrong-service', expiresIn: '60s' },
    );

    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: `Bearer ${token}` },
        }),
      }),
    } as any;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should reject expired JWT', () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { iss: 'parliament-backend' },
      'test-secret',
      { audience: 'communications-service', expiresIn: '0s' },
    );

    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: `Bearer ${token}` },
        }),
      }),
    } as any;

    // Expired immediately
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
