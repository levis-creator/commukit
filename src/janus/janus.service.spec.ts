// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Test, TestingModule } from '@nestjs/testing';
import { JanusService } from './janus.service';
import { RedisService } from '../redis/redis.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('JanusService', () => {
  let service: JanusService;
  let redis: jest.Mocked<RedisService>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JanusService,
        {
          provide: RedisService,
          useValue: {
            isReady: jest.fn().mockReturnValue(false),
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(true),
            del: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(JanusService);
    redis = module.get(RedisService);

    // Simulate connected state
    (service as any).available = true;
    (service as any).janusVersion = 'test-v1';
  });

  // Helper: mock the full session→attach→message→destroy flow
  function mockJanusFlow(pluginResponse: any) {
    mockFetch
      // Create session
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ janus: 'success', data: { id: 'session-1' } }),
      })
      // Attach plugin
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ janus: 'success', data: { id: 'handle-1' } }),
      })
      // Plugin message (create room)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ plugindata: { data: pluginResponse } }),
      })
      // Destroy session
      .mockResolvedValueOnce({ ok: true });
  }

  describe('ensureAudioBridgeRoom', () => {
    it('should create AudioBridge room', async () => {
      mockJanusFlow({ audiobridge: 'created' });

      const roomId = await service.ensureAudioBridgeRoom('ctx-1');

      expect(roomId).toBeGreaterThan(0);
      // Verify plugin attachment was for audiobridge
      const attachCall = mockFetch.mock.calls[1];
      const body = JSON.parse(attachCall[1].body);
      expect(body.plugin).toBe('janus.plugin.audiobridge');
    });

    it('should treat error 486 (already exists) as success', async () => {
      mockJanusFlow({ error_code: 486, error: 'Room already exists' });

      const roomId = await service.ensureAudioBridgeRoom('ctx-2');

      expect(roomId).toBeGreaterThan(0);
    });

    it('should return null when Janus is unavailable', async () => {
      (service as any).available = false;

      const roomId = await service.ensureAudioBridgeRoom('ctx-3');

      expect(roomId).toBeNull();
    });
  });

  describe('ensureVideoRoom', () => {
    it('should create VideoRoom with SFU config', async () => {
      mockJanusFlow({ videoroom: 'created' });

      const roomId = await service.ensureVideoRoom('ctx-4');

      expect(roomId).toBeGreaterThan(0);
      // Verify the create message body
      const createCall = mockFetch.mock.calls[2];
      const body = JSON.parse(createCall[1].body);
      expect(body.body.request).toBe('create');
      expect(body.body.publishers).toBe(100);
      expect(body.body.videocodec).toBe('vp8');
      expect(body.body.bitrate).toBe(512000);
    });

    it('should treat error 427 (already exists) as success', async () => {
      mockJanusFlow({ error_code: 427, error: 'Room already exists' });

      const roomId = await service.ensureVideoRoom('ctx-5');

      expect(roomId).toBeGreaterThan(0);
    });

    it('should use knownRoomId when provided', async () => {
      mockJanusFlow({ videoroom: 'created' });

      const roomId = await service.ensureVideoRoom('ctx-6', 999);

      expect(roomId).toBe(999);
    });
  });

  describe('destroyVideoRoom', () => {
    it('should destroy the room and clear cache', async () => {
      (redis.isReady as jest.Mock).mockReturnValue(true);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ janus: 'success', data: { id: 'session-1' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ janus: 'success', data: { id: 'handle-1' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ plugindata: { data: { videoroom: 'destroyed' } } }),
        })
        .mockResolvedValueOnce({ ok: true });

      await service.destroyVideoRoom('ctx-7', 777);

      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('ctx-7'));
    });
  });

  describe('contextIdToRoomId (deterministic)', () => {
    it('should produce same ID for same input', () => {
      const id1 = (service as any).contextIdToRoomId('test-uuid-1');
      const id2 = (service as any).contextIdToRoomId('test-uuid-1');

      expect(id1).toBe(id2);
      expect(id1).toBeGreaterThan(0);
    });

    it('should produce different IDs for different inputs', () => {
      const id1 = (service as any).contextIdToRoomId('uuid-aaa');
      const id2 = (service as any).contextIdToRoomId('uuid-bbb');

      expect(id1).not.toBe(id2);
    });

    it('should fit within PostgreSQL Int range', () => {
      const id = (service as any).contextIdToRoomId('some-long-uuid-string');

      expect(id).toBeLessThanOrEqual(2147483647); // 2^31 - 1
      expect(id).toBeGreaterThan(0);
    });
  });

  describe('buildIceServers', () => {
    it('should return STUN servers from env', () => {
      process.env.JANUS_ICE_SERVERS = 'stun:stun.l.google.com:19302';
      delete process.env.JANUS_TURN_USERNAME;
      delete process.env.JANUS_TURN_CREDENTIAL;

      const servers = service.buildIceServers();

      expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
    });

    it('should include TURN servers when credentials provided', () => {
      process.env.JANUS_ICE_SERVERS =
        'stun:stun.l.google.com:19302,turn:turn.example.com:3478';
      process.env.JANUS_TURN_USERNAME = 'user';
      process.env.JANUS_TURN_CREDENTIAL = 'pass';

      const servers = service.buildIceServers();

      expect(servers).toHaveLength(2);
      expect(servers[0]).toEqual({ urls: ['stun:stun.l.google.com:19302'] });
      expect(servers[1]).toEqual({
        urls: ['turn:turn.example.com:3478'],
        username: 'user',
        credential: 'pass',
      });
    });
  });

  describe('health check (tryConnect)', () => {
    it('should mark available on successful probe', async () => {
      (service as any).available = false;
      (redis.isReady as jest.Mock).mockReturnValue(true);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ janus: 'server_info', name: 'Janus' }),
      });

      await (service as any).tryConnect();

      expect(service.isAvailable()).toBe(true);
    });

    it('should mark unavailable on failed probe', async () => {
      (service as any).available = true;

      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      await (service as any).tryConnect();

      expect(service.isAvailable()).toBe(false);
    });
  });
});
