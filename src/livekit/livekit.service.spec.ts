// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2025 Levis Nyingi and commukit contributors
import { Test, TestingModule } from '@nestjs/testing';
import { RedisService } from '../redis/redis.service';
import { LivekitService } from './livekit.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('LivekitService', () => {
  let service: LivekitService;
  let redis: jest.Mocked<RedisService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.LIVEKIT_URL = 'ws://livekit:7880';
    process.env.LIVEKIT_PUBLIC_URL = 'wss://livekit.example.com';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secret';

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LivekitService,
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

    service = module.get(LivekitService);
    redis = module.get(RedisService);
    (service as any).available = true;
  });

  it('creates a stable room and returns its numeric ref', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{}'),
    });

    const roomId = await service.ensureVideoRoom('ctx-livekit-1');

    expect(roomId).toBeGreaterThan(0);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://livekit:7880/twirp/livekit.RoomService/CreateRoom',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('lists participants using identities as provider-native ids', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            participants: [
              {
                identity: 'user-1',
                name: 'Jane Doe|user-1',
                tracks: [{ type: 'AUDIO', muted: false }],
              },
            ],
          }),
        ),
    });

    const participants = await service.listParticipants(123);

    expect(participants).toEqual([
      { id: 'user-1', display: 'Jane Doe|user-1', muted: false },
    ]);
  });

  it('builds participant tokens for room joins', async () => {
    const token = await service.createParticipantToken({
      roomId: 123,
      identity: 'user-1',
      name: 'Jane Doe',
      roomAdmin: true,
    });

    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });

  it('clears cached rooms on destroy', async () => {
    (redis.isReady as jest.Mock).mockReturnValue(true);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('{}'),
    });

    await service.destroyVideoRoom('ctx-livekit-2', 456);

    expect(redis.del).toHaveBeenCalledWith('comms:livekit:room:ctx-livekit-2');
  });
});
