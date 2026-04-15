import { Test, TestingModule } from '@nestjs/testing';
import { SipService } from './sip.service';
import { PrismaService } from '../database/prisma.service';

describe('SipService', () => {
  let service: SipService;
  let prisma: { $executeRawUnsafe: jest.Mock };

  beforeEach(async () => {
    // Reset env each test so they don't leak
    process.env.SIP_DOMAIN = 'comms.local';
    process.env.SIP_REGISTRAR_HOST = 'comms-kamailio';
    process.env.SIP_REGISTRAR_PORT = '5060';
    process.env.SIP_TRANSPORT = 'udp';
    delete process.env.SIP_PUBLIC_HOST;

    prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SipService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(SipService);
  });

  // ── Configuration & descriptor shape ───────────────────────────────────────

  describe('buildSessionDescriptor', () => {
    it('should build a descriptor with registrar and domain', () => {
      const descriptor = service.buildSessionDescriptor({
        username: 'comms_abc',
        password: 'secret',
      });

      expect(descriptor.status).toBe('available');
      expect(descriptor.username).toBe('comms_abc');
      expect(descriptor.password).toBe('secret');
      expect(descriptor.domain).toBe('comms.local');
      expect(descriptor.transport).toBe('udp');
      expect(descriptor.registrar).toBe('sip:comms-kamailio:5060;transport=udp');
      expect(descriptor.roomUri).toBeUndefined();
    });

    it('should include roomUri when a contextId is provided', () => {
      const descriptor = service.buildSessionDescriptor(
        { username: 'comms_abc', password: 'secret' },
        'ctx-123',
      );

      expect(descriptor.roomUri).toBe('sip:room-ctx-123@comms.local');
    });

    it('should use publicHost when set', async () => {
      process.env.SIP_PUBLIC_HOST = 'sip.example.com';
      // Rebuild service to pick up env
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SipService,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile();
      const freshService = module.get(SipService);

      const descriptor = freshService.buildSessionDescriptor({
        username: 'comms_abc',
        password: 'secret',
      });

      expect(descriptor.registrar).toBe('sip:sip.example.com:5060;transport=udp');
    });
  });

  // ── Credential issuance ────────────────────────────────────────────────────

  describe('ensureUserCredentials', () => {
    it('should mint a new password on first call', async () => {
      const result = await service.ensureUserCredentials(
        'myapp',
        'user-abc-123',
        'Jane Doe',
        null,
        null,
      );

      expect(result).not.toBeNull();
      expect(result!.username).toBe('comms_userabc123');
      // First call returns the new password
      expect(result!.password).toBeTruthy();
      expect(result!.password!.length).toBeGreaterThan(32);
      // Kamailio row is upserted
      expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
      const call = prisma.$executeRawUnsafe.mock.calls[0];
      expect(call[0]).toContain('INSERT INTO "subscriber"');
      expect(call[1]).toBe('comms_userabc123');
      expect(call[2]).toBe('comms.local');
    });

    it('should reuse stored credentials on subsequent calls', async () => {
      const result = await service.ensureUserCredentials(
        'myapp',
        'user-abc-123',
        'Jane Doe',
        'cached-password',
        'comms_userabc123',
      );

      expect(result).not.toBeNull();
      expect(result!.username).toBe('comms_userabc123');
      // Cached path returns null for password (caller keeps existing)
      expect(result!.password).toBeNull();
      // Should still upsert to keep Kamailio row fresh (idempotent)
      expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
    });

    it('should reject reserved usernames', async () => {
      // If a caller somehow produces a username that collides with a
      // reserved identity (janus, kamailio, etc.), ensureUserCredentials
      // must refuse to provision. The generator doesn't naturally
      // produce these, but the guard is a defense-in-depth check.
      const result = await service.ensureUserCredentials(
        'myapp',
        'anything',
        'Jane Doe',
        null,
        'janus', // explicit stored username matches reserved
      );

      expect(result).toBeNull();
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('should degrade gracefully when the database is unavailable', async () => {
      prisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('connection refused'));

      const result = await service.ensureUserCredentials(
        'myapp',
        'user-xyz',
        'Jane Doe',
        null,
        null,
      );

      expect(result).toBeNull();
    });

    it('should generate a stable username from the same domain user id', async () => {
      const r1 = await service.ensureUserCredentials('myapp', 'user-aaa', 'A', null, null);
      // Simulate a second call with the username we just stored
      prisma.$executeRawUnsafe.mockClear();
      const r2 = await service.ensureUserCredentials(
        'myapp',
        'user-aaa',
        'A',
        r1!.password,
        r1!.username,
      );

      expect(r2!.username).toBe(r1!.username);
    });
  });

  // ── Deprovisioning ─────────────────────────────────────────────────────────

  describe('deprovisionUser', () => {
    it('should DELETE the subscriber row', async () => {
      await service.deprovisionUser('comms_test');

      expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
      const call = prisma.$executeRawUnsafe.mock.calls[0];
      expect(call[0]).toContain('DELETE FROM "subscriber"');
      expect(call[1]).toBe('comms_test');
      expect(call[2]).toBe('comms.local');
    });

    it('should swallow errors (best-effort contract)', async () => {
      prisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('db down'));
      await expect(service.deprovisionUser('comms_test')).resolves.toBeUndefined();
    });

    it('should no-op on empty username', async () => {
      await service.deprovisionUser('');
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });
});
