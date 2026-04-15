import { Test, TestingModule } from '@nestjs/testing';
import { SipBridgeService } from './sip-bridge.service';
import { JanusService } from '../janus/janus.service';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MEDIA_PROVIDER } from '../providers/tokens';
import type { MediaProvider } from '../providers/media-provider.interface';

describe('SipBridgeService', () => {
  let service: SipBridgeService;
  let janus: jest.Mocked<JanusService>;
  let prisma: any;
  let redis: jest.Mocked<RedisService>;
  let auditCalls: Array<{ action: string; actor: string | null; metadata: any; roomPk: string | null }>;

  beforeEach(async () => {
    process.env.SIP_BRIDGE_USERNAME = 'janus';
    process.env.SIP_BRIDGE_PASSWORD = 'test-secret';
    process.env.SIP_DOMAIN = 'comms.local';
    process.env.SIP_REGISTRAR_HOST = 'comms-kamailio';
    process.env.SIP_REGISTRAR_PORT = '5060';
    process.env.SIP_MAX_CALL_SECONDS = '3600';
    // Long interval so the reaper doesn't fire during tests
    process.env.SIP_REAPER_INTERVAL_MS = '3600000';

    auditCalls = [];

    janus = {
      isAvailable: jest.fn().mockReturnValue(true),
      sipCreateSession: jest.fn().mockResolvedValue('session-1'),
      sipAttachHandle: jest.fn().mockResolvedValue('handle-1'),
      sipSendMessage: jest.fn().mockResolvedValue({ janus: 'ack' }),
      sipLongPoll: jest.fn().mockResolvedValue([]),
      sipKeepalive: jest.fn().mockResolvedValue(undefined),
      sipDestroySession: jest.fn().mockResolvedValue(undefined),
    } as any;

    prisma = {
      communicationUser: {
        findUnique: jest.fn(),
      },
      communicationRoom: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      communicationMembership: {
        findUnique: jest.fn(),
      },
      communicationAuditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    redis = {
      isReady: jest.fn().mockReturnValue(true),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(true),
      del: jest.fn().mockResolvedValue(undefined),
      scanKeys: jest.fn().mockResolvedValue([]),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SipBridgeService,
        { provide: JanusService, useValue: janus },
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        {
          provide: 'AuditWriter',
          useValue: async (
            action: string,
            actor: string | null,
            metadata: any,
            roomPk: string | null,
          ) => {
            auditCalls.push({ action, actor, metadata, roomPk });
          },
        },
      ],
    }).compile();

    service = module.get(SipBridgeService);
    // Inject our audit capture directly so we don't depend on Nest's
    // @Optional injection of a token-based provider (which can be
    // flaky in jest's DI setup). The private auditWriter field is
    // reassigned here to a local capture function.
    (service as any).auditWriter = async (
      action: string,
      actor: string | null,
      metadata: any,
      roomPk: string | null,
    ) => {
      auditCalls.push({ action, actor, metadata, roomPk });
    };
  });

  afterEach(async () => {
    // Clean up timers and long-poll worker so tests don't leak
    if ((service as any).keepaliveTimer) clearInterval((service as any).keepaliveTimer);
    if ((service as any).reaperTimer) clearInterval((service as any).reaperTimer);
    if ((service as any).initRetryTimer) clearTimeout((service as any).initRetryTimer);
    (service as any).longPollAbort?.abort();
  });

  // ── bridgeStatus ────────────────────────────────────────────────────────

  describe('bridgeStatus', () => {
    it('returns "unregistered" when Janus is down', () => {
      janus.isAvailable.mockReturnValue(false);
      expect(service.bridgeStatus()).toBe('unregistered');
    });

    it('returns "unregistered" before the registered event arrives', () => {
      janus.isAvailable.mockReturnValue(true);
      expect(service.bridgeStatus()).toBe('unregistered');
    });

    it('returns "registered" after a registered event', async () => {
      // Simulate the registrar handle being set so sender matching works
      (service as any).registrarHandleId = 'handle-reg';
      await (service as any).onSipPluginEvent({
        janus: 'event',
        sender: 'handle-reg',
        plugindata: {
          plugin: 'janus.plugin.sip',
          data: { result: { event: 'registered' } },
        },
      });
      expect(service.bridgeStatus()).toBe('registered');
    });
  });

  // ── Compatibility guard: SIP + incompatible MediaProvider ────────────────
  //
  // The Janus SIP bridge declares `compatibleMediaProviders: ['janus']`.
  // If the operator boots the service with MEDIA_PROVIDER=livekit AND
  // SIP_ENABLED=true, SipBridgeService must refuse to REGISTER — otherwise
  // softphones would land in a Janus AudioBridge that no WebRTC client
  // ever joins. This suite locks in that invariant.

  describe('compatibility guard', () => {
    const buildBridgeWithMedia = async (
      mediaId: string,
    ): Promise<SipBridgeService> => {
      const localJanus = {
        isAvailable: jest.fn().mockReturnValue(true),
        sipCreateSession: jest.fn().mockResolvedValue('session-x'),
        sipAttachHandle: jest.fn().mockResolvedValue('handle-x'),
        sipSendMessage: jest.fn().mockResolvedValue({ janus: 'ack' }),
        sipLongPoll: jest.fn().mockResolvedValue([]),
        sipKeepalive: jest.fn().mockResolvedValue(undefined),
        sipDestroySession: jest.fn().mockResolvedValue(undefined),
      } as any;

      const fakeMedia: MediaProvider = {
        id: mediaId,
        wsUrl: 'ws://ignored',
        isAvailable: () => true,
        buildIceServers: () => [],
        ensureAudioBridgeRoom: async () => 1,
        ensureVideoRoom: async () => 1,
        destroyVideoRoom: async () => {},
        listParticipants: async () => [],
        listVideoParticipants: async () => [],
        muteParticipant: async () => true,
        unmuteParticipant: async () => true,
        muteRoom: async () => true,
        kickAudioParticipant: async () => true,
        kickVideoParticipant: async () => true,
      };

      const mod = await Test.createTestingModule({
        providers: [
          SipBridgeService,
          { provide: JanusService, useValue: localJanus },
          { provide: PrismaService, useValue: prisma },
          { provide: RedisService, useValue: redis },
          { provide: MEDIA_PROVIDER, useValue: fakeMedia },
        ],
      }).compile();
      const svc = mod.get(SipBridgeService);
      // Stash janus on the instance so the test can assert on its calls.
      (svc as any)._testJanus = localJanus;
      return svc;
    };

    it('refuses to REGISTER when media provider is livekit', async () => {
      const bridge = await buildBridgeWithMedia('livekit');
      // Silence the expected ERROR log so test output stays clean. The
      // logger is a per-instance field assigned in the constructor, so
      // overwrite it directly rather than spying on the prototype.
      (bridge as any).logger = {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };
      await bridge.onModuleInit();

      // No SIP session / handle / message calls — the bridge short-circuited.
      const j = (bridge as any)._testJanus;
      expect(j.sipCreateSession).not.toHaveBeenCalled();
      expect(j.sipAttachHandle).not.toHaveBeenCalled();
      expect(j.sipSendMessage).not.toHaveBeenCalled();

      // Status surfaces the misconfiguration instead of pretending to work.
      expect(bridge.bridgeStatus()).toBe('incompatible-media');
      expect(bridge.isBridgeRegistered()).toBe(false);

      // Verify the error log fired with the key phrase operators will grep for.
      expect((bridge as any).logger.error).toHaveBeenCalledWith(
        expect.stringContaining('refusing to start'),
      );

      // Clean up any stray timers the guard may have scheduled.
      if ((bridge as any).keepaliveTimer) clearInterval((bridge as any).keepaliveTimer);
      if ((bridge as any).reaperTimer) clearInterval((bridge as any).reaperTimer);
      if ((bridge as any).initRetryTimer) clearTimeout((bridge as any).initRetryTimer);
    });

    it('allows REGISTER when media provider is janus', async () => {
      const bridge = await buildBridgeWithMedia('janus');
      // Don't actually await onModuleInit — scheduleInit opens a long-poll
      // loop that we don't need here. Instead, inspect the state directly:
      // `incompatibleMedia` must NOT be set, and bridgeStatus() must not
      // return 'incompatible-media'.
      await bridge.onModuleInit();
      expect(bridge.bridgeStatus()).not.toBe('incompatible-media');
      expect((bridge as any).incompatibleMedia).toBe(false);

      if ((bridge as any).keepaliveTimer) clearInterval((bridge as any).keepaliveTimer);
      if ((bridge as any).reaperTimer) clearInterval((bridge as any).reaperTimer);
      if ((bridge as any).initRetryTimer) clearTimeout((bridge as any).initRetryTimer);
      (bridge as any).longPollAbort?.abort();
    });
  });

  // ── onSipPluginEvent: registration ────────────────────────────────────────

  describe('onSipPluginEvent: registration', () => {
    it('marks bridge registered and audits SIP_BRIDGE_REGISTERED', async () => {
      (service as any).registrarHandleId = 'handle-reg';
      await (service as any).onSipPluginEvent({
        janus: 'event',
        sender: 'handle-reg',
        plugindata: {
          plugin: 'janus.plugin.sip',
          data: { result: { event: 'registered' } },
        },
      });
      expect(service.isBridgeRegistered()).toBe(true);
      expect(auditCalls.find((a) => a.action === 'SIP_BRIDGE_REGISTERED')).toBeDefined();
    });

    it('marks registration_failed and audits SIP_BRIDGE_REGISTRATION_FAILED', async () => {
      (service as any).registrarHandleId = 'handle-reg';
      (service as any).registered = true;
      await (service as any).onSipPluginEvent({
        janus: 'event',
        sender: 'handle-reg',
        plugindata: {
          plugin: 'janus.plugin.sip',
          data: {
            result: { event: 'registration_failed', code: 401, reason: 'Unauthorized' },
          },
        },
      });
      expect(service.isBridgeRegistered()).toBe(false);
      expect(
        auditCalls.find((a) => a.action === 'SIP_BRIDGE_REGISTRATION_FAILED'),
      ).toBeDefined();
    });

    it('ignores events from plugins other than janus.plugin.sip', async () => {
      await (service as any).onSipPluginEvent({
        janus: 'event',
        sender: 'handle-x',
        plugindata: {
          plugin: 'janus.plugin.videoroom',
          data: { result: { event: 'registered' } },
        },
      });
      expect(service.isBridgeRegistered()).toBe(false);
    });
  });

  // ── onSipPluginEvent: incomingcall validation ────────────────────────────

  describe('onSipPluginEvent: incomingcall validation', () => {
    const baseEvent = {
      janus: 'event',
      sender: 'call-handle-1',
      plugindata: { plugin: 'janus.plugin.sip', data: { result: {} } },
      jsep: { type: 'offer', sdp: 'v=0\r\n...' },
    };

    // Helper to set up a valid incomingcall event with a specific context header
    function makeIncoming(contextId: string, sipUser = 'comms_user1') {
      return {
        ...baseEvent,
        plugindata: {
          plugin: 'janus.plugin.sip',
          data: {
            result: {
              event: 'incomingcall',
              call_id: 'call-abc',
              username: `sip:${sipUser}@comms.local`,
              headers: { 'X-Comms-Context-Id': contextId },
            },
          },
        },
      };
    }

    beforeEach(() => {
      // Pretend the bridge is registered so call handling is reached
      (service as any).registered = true;
      (service as any).sipSessionId = 'session-1';
      (service as any).registrarHandleId = 'handle-reg';
    });

    it('rejects when bridge not yet registered', async () => {
      (service as any).registered = false;
      await (service as any).onSipPluginEvent(makeIncoming('ctx-1'));
      const rejected = auditCalls.find((a) =>
        a.action === 'SIP_CALL_REJECTED_BRIDGE_NOT_READY',
      );
      expect(rejected).toBeDefined();
      // Also should have sent a decline message
      expect(janus.sipSendMessage).toHaveBeenCalledWith(
        'session-1',
        'call-handle-1',
        expect.objectContaining({ request: 'decline' }),
      );
    });

    it('rejects incomingcall without X-Comms-Context-Id header', async () => {
      const event = {
        ...baseEvent,
        plugindata: {
          plugin: 'janus.plugin.sip',
          data: {
            result: {
              event: 'incomingcall',
              call_id: 'call-abc',
              username: 'sip:comms_user1@comms.local',
              headers: {},
            },
          },
        },
      };
      await (service as any).onSipPluginEvent(event);
      expect(
        auditCalls.find((a) => a.action === 'SIP_CALL_REJECTED_MISSING_CONTEXT'),
      ).toBeDefined();
    });

    it('rejects unknown SIP users', async () => {
      prisma.communicationUser.findUnique.mockResolvedValue(null);
      await (service as any).onSipPluginEvent(makeIncoming('ctx-1'));
      expect(
        auditCalls.find((a) => a.action === 'SIP_CALL_REJECTED_UNKNOWN_USER'),
      ).toBeDefined();
    });

    it('rejects malformed From URI', async () => {
      const event = {
        ...baseEvent,
        plugindata: {
          plugin: 'janus.plugin.sip',
          data: {
            result: {
              event: 'incomingcall',
              call_id: 'call-abc',
              username: 'not-a-sip-uri',
              headers: { 'X-Comms-Context-Id': 'ctx-1' },
            },
          },
        },
      };
      await (service as any).onSipPluginEvent(event);
      expect(
        auditCalls.find((a) => a.action === 'SIP_CALL_REJECTED_UNKNOWN_USER'),
      ).toBeDefined();
    });

    it('rejects when room not found', async () => {
      prisma.communicationUser.findUnique.mockResolvedValue({
        id: 'u1',
        appId: 'myapp',
        domainUserId: 'user-1',
        displayName: 'Jane',
      });
      prisma.communicationRoom.findFirst.mockResolvedValue(null);
      await (service as any).onSipPluginEvent(makeIncoming('ctx-missing'));
      expect(
        auditCalls.find((a) => a.action === 'SIP_CALL_REJECTED_ROOM_NOT_FOUND'),
      ).toBeDefined();
    });

    it('rejects when room is not ACTIVE', async () => {
      prisma.communicationUser.findUnique.mockResolvedValue({
        id: 'u1',
        appId: 'myapp',
        domainUserId: 'user-1',
        displayName: 'Jane',
      });
      prisma.communicationRoom.findFirst.mockResolvedValue({
        id: 'room-1',
        appId: 'myapp',
        contextType: 'MEETING',
        contextId: 'ctx-1',
        status: 'PROVISIONED',
        janusAudioRoomId: 1234,
      });
      await (service as any).onSipPluginEvent(makeIncoming('ctx-1'));
      expect(
        auditCalls.find((a) => a.action === 'SIP_CALL_REJECTED_ROOM_INACTIVE'),
      ).toBeDefined();
    });

    it('rejects when user has no membership', async () => {
      prisma.communicationUser.findUnique.mockResolvedValue({
        id: 'u1',
        appId: 'myapp',
        domainUserId: 'user-1',
        displayName: 'Jane',
      });
      prisma.communicationRoom.findFirst.mockResolvedValue({
        id: 'room-1',
        appId: 'myapp',
        contextType: 'MEETING',
        contextId: 'ctx-1',
        status: 'ACTIVE',
        janusAudioRoomId: 1234,
      });
      prisma.communicationMembership.findUnique.mockResolvedValue(null);
      await (service as any).onSipPluginEvent(makeIncoming('ctx-1'));
      expect(
        auditCalls.find((a) => a.action === 'SIP_CALL_REJECTED_NOT_MEMBER'),
      ).toBeDefined();
    });

    it('rejects when membership is invalidated (leftAt set)', async () => {
      prisma.communicationUser.findUnique.mockResolvedValue({
        id: 'u1',
        appId: 'myapp',
        domainUserId: 'user-1',
        displayName: 'Jane',
      });
      prisma.communicationRoom.findFirst.mockResolvedValue({
        id: 'room-1',
        appId: 'myapp',
        contextType: 'MEETING',
        contextId: 'ctx-1',
        status: 'ACTIVE',
        janusAudioRoomId: 1234,
      });
      prisma.communicationMembership.findUnique.mockResolvedValue({
        id: 'm1',
        leftAt: new Date(),
      });
      await (service as any).onSipPluginEvent(makeIncoming('ctx-1'));
      expect(
        auditCalls.find((a) => a.action === 'SIP_CALL_REJECTED_SESSION_INVALIDATED'),
      ).toBeDefined();
    });

    it('accepts and bridges a valid inbound call', async () => {
      prisma.communicationUser.findUnique.mockResolvedValue({
        id: 'u1',
        appId: 'myapp',
        domainUserId: 'user-1',
        displayName: 'Jane',
      });
      prisma.communicationRoom.findFirst.mockResolvedValue({
        id: 'room-1',
        appId: 'myapp',
        contextType: 'MEETING',
        contextId: 'ctx-1',
        status: 'ACTIVE',
        janusAudioRoomId: 1234,
      });
      prisma.communicationMembership.findUnique.mockResolvedValue({
        id: 'm1',
        leftAt: null,
      });

      await (service as any).onSipPluginEvent(makeIncoming('ctx-1'));

      // Should have audited success
      expect(auditCalls.find((a) => a.action === 'SIP_CALL_BRIDGED')).toBeDefined();
      // Should have sent `accept` with the JSEP offer
      const acceptCall = janus.sipSendMessage.mock.calls.find(
        (call) => call[2]?.request === 'accept',
      );
      expect(acceptCall).toBeDefined();
      // Should have saved call state to Redis
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^janus:sip:call:/),
        expect.any(String),
        expect.any(Number),
      );
    });
  });

  // ── Reaper ─────────────────────────────────────────────────────────────

  describe('reapStuckCalls', () => {
    it('kills calls that exceed SIP_MAX_CALL_SECONDS', async () => {
      (service as any).sipSessionId = 'session-1';
      const stuckCall = {
        callId: 'call-stuck',
        sipSessionId: 'session-1',
        sipHandleId: 'handle-stuck',
        audioHandleId: 'handle-audio-stuck',
        audioBridgeRoomId: 1234,
        contextId: 'ctx-1',
        contextType: 'MEETING',
        appId: 'myapp',
        domainUserId: 'user-1',
        sipUsername: 'comms_user1',
        createdAt: Date.now() - 4000 * 1000, // older than maxCallSeconds (3600)
      };

      redis.scanKeys.mockResolvedValue(['janus:sip:call:call-stuck']);
      redis.get.mockResolvedValue(JSON.stringify(stuckCall));
      prisma.communicationRoom.findUnique.mockResolvedValue({ id: 'room-1' });

      await (service as any).reapStuckCalls();

      expect(auditCalls.find((a) => a.action === 'SIP_CALL_TIMEOUT_REAPED')).toBeDefined();
      // Should have sent the hangup request to Janus
      expect(janus.sipSendMessage).toHaveBeenCalledWith(
        'session-1',
        'handle-stuck',
        expect.objectContaining({ request: 'hangup' }),
      );
      // Should have cleaned up Redis state
      expect(redis.del).toHaveBeenCalledWith('janus:sip:call:call-stuck');
    });

    it('leaves fresh calls alone', async () => {
      (service as any).sipSessionId = 'session-1';
      const freshCall = {
        callId: 'call-fresh',
        sipSessionId: 'session-1',
        sipHandleId: 'handle-fresh',
        audioHandleId: null,
        audioBridgeRoomId: null,
        contextId: 'ctx-1',
        contextType: 'MEETING',
        appId: 'myapp',
        domainUserId: 'user-1',
        sipUsername: 'comms_user1',
        createdAt: Date.now() - 1000, // 1 second old
      };

      redis.scanKeys.mockResolvedValue(['janus:sip:call:call-fresh']);
      redis.get.mockResolvedValue(JSON.stringify(freshCall));

      await (service as any).reapStuckCalls();

      expect(auditCalls.find((a) => a.action === 'SIP_CALL_TIMEOUT_REAPED')).toBeUndefined();
      expect(janus.sipSendMessage).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ request: 'hangup' }),
      );
    });
  });

  // ── hangupSipCall ──────────────────────────────────────────────────────

  describe('hangupSipCall', () => {
    it('is idempotent for unknown callIds', async () => {
      redis.get.mockResolvedValue(null);
      await expect(service.hangupSipCall('no-such-call')).resolves.toBeUndefined();
      // No audit, no Janus calls
      expect(janus.sipSendMessage).not.toHaveBeenCalled();
    });

    it('tears down a known call and audits', async () => {
      (service as any).sipSessionId = 'session-1';
      const state = {
        callId: 'call-ok',
        sipSessionId: 'session-1',
        sipHandleId: 'handle-sip',
        audioHandleId: 'handle-audio',
        audioBridgeRoomId: 1234,
        contextId: 'ctx-1',
        contextType: 'MEETING',
        appId: 'myapp',
        domainUserId: 'user-1',
        sipUsername: 'comms_user1',
        createdAt: Date.now() - 5000,
      };
      redis.get.mockResolvedValue(JSON.stringify(state));
      prisma.communicationRoom.findUnique.mockResolvedValue({ id: 'room-1' });

      await service.hangupSipCall('call-ok');

      expect(auditCalls.find((a) => a.action === 'SIP_CALL_HUNG_UP')).toBeDefined();
      expect(redis.del).toHaveBeenCalledWith('janus:sip:call:call-ok');
    });
  });
});
