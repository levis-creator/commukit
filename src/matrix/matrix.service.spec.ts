import { Test, TestingModule } from '@nestjs/testing';
import { MatrixService } from './matrix.service';
import { RedisService } from '../redis/redis.service';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('MatrixService', () => {
  let service: MatrixService;
  let redis: jest.Mocked<RedisService>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MatrixService,
        {
          provide: RedisService,
          useValue: {
            isReady: jest.fn().mockReturnValue(false),
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compile();

    service = module.get(MatrixService);
    redis = module.get(RedisService);

    // Simulate successful init by setting internal state
    (service as any).available = true;
    (service as any).botAccessToken = 'bot-token';
  });

  describe('ensureRoom', () => {
    it('should create a private room with bot when room does not exist', async () => {
      // Room alias lookup fails (404)
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: () => Promise.resolve('Not found'),
        })
        // Room creation succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({ room_id: '!newroom:parliament.local' }),
        });

      const roomId = await service.ensureRoom('parliament', 'ctx-123', 'Test Room');

      expect(roomId).toBe('!newroom:parliament.local');
      // Verify createRoom was called with correct preset
      const createCall = mockFetch.mock.calls[1];
      const body = JSON.parse(createCall[1].body);
      expect(body.preset).toBe('private_chat');
      expect(body.visibility).toBe('private');
      expect(body.name).toBe('Test Room');
    });

    it('should return existing room from alias lookup', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ room_id: '!existing:parliament.local' }),
      });

      const roomId = await service.ensureRoom('parliament', 'ctx-456', 'Existing');

      expect(roomId).toBe('!existing:parliament.local');
      // Only one fetch (alias lookup), no create
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return cached room on subsequent calls', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ room_id: '!cached:parliament.local' }),
      });

      await service.ensureRoom('parliament', 'ctx-789', 'First');
      const second = await service.ensureRoom('parliament', 'ctx-789', 'Second');

      expect(second).toBe('!cached:parliament.local');
      // Only one network call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return null when Matrix is unavailable', async () => {
      (service as any).available = false;

      const roomId = await service.ensureRoom('parliament', 'ctx-999', 'Test');

      expect(roomId).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('ensureUserToken', () => {
    it('should login existing user and return token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'user-token-123' }),
      });
      // setDisplayName call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const result = await service.ensureUserToken('user-1', 'Hon. Smith', 'stored-pw');

      expect(result).toEqual({
        accessToken: 'user-token-123',
        matrixUserId: expect.stringContaining('@comms_'),
      });
    });

    it('should register user when login fails', async () => {
      // Login fails
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ errcode: 'M_FORBIDDEN' }),
      });
      // getNonce
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ nonce: 'abc123' }),
      });
      // Register succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'new-user-token' }),
      });

      const result = await service.ensureUserToken('user-new', 'New Member', null);

      expect(result?.accessToken).toBe('new-user-token');
    });

    it('should return null when Matrix is unavailable', async () => {
      (service as any).available = false;

      const result = await service.ensureUserToken('user-1', 'Test', null);

      expect(result).toBeNull();
    });
  });

  describe('inviteAndJoin', () => {
    it('should invite and then join user to room', async () => {
      // Invite
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });
      // Join
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await service.inviteAndJoin(
        '!room:parliament.local',
        '@user:parliament.local',
        'user-token',
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Verify invite uses bot token
      const inviteCall = mockFetch.mock.calls[0];
      expect(inviteCall[1].headers['Authorization']).toBe('Bearer bot-token');
      // Verify join uses member token
      const joinCall = mockFetch.mock.calls[1];
      expect(joinCall[1].headers['Authorization']).toBe('Bearer user-token');
    });

    it('should deduplicate invite calls', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await service.inviteAndJoin('!room:local', '@user:local', 'token');
      await service.inviteAndJoin('!room:local', '@user:local', 'token');

      // Second call is deduped — only 2 fetch calls total (invite + join from first)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // /messages proxy removed — Flutter clients paginate directly against Matrix.
});
