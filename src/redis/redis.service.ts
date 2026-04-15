import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Thin Redis wrapper providing graceful degradation for the communications service.
 *
 * All methods are fail-safe: errors are caught and logged, and the caller
 * receives a safe default (`null` / `false`) rather than an exception. This
 * lets Redis be an optional performance layer — the service remains functional
 * if Redis is temporarily unavailable, just without caching or distributed locks.
 *
 * Key namespaces used by this service:
 * - `comms:authorize:cooldown:<appId>:<contextId>:<domainUserId>` — per-user authorize cooldown (SET NX, 10s TTL)
 * - `comms:matrix:token:<domainUserId>` — cached Matrix access token for logout-on-close
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private ready = false;

  /** Initializes and connects the Redis client. Connection failures are non-fatal. */
  onModuleInit() {
    const host = process.env.REDIS_HOST ?? 'localhost';
    const port = Number(process.env.REDIS_PORT ?? '6379');
    const password = process.env.REDIS_PASSWORD ?? '';
    const db = Number(process.env.REDIS_DB ?? '0');

    this.client = new Redis({
      host,
      port,
      password: password || undefined,
      db,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    this.client.on('ready', () => {
      this.ready = true;
      this.logger.log(`Redis connected at ${host}:${port} (db ${db})`);
    });
    this.client.on('error', (err) => {
      this.ready = false;
      this.logger.warn(`Redis error: ${err?.message ?? err}`);
    });
    this.client.on('end', () => {
      this.ready = false;
      this.logger.warn('Redis connection closed');
    });

    this.client.connect().catch((err) => {
      this.ready = false;
      this.logger.warn(`Redis connect failed: ${err?.message ?? err}`);
    });
  }

  onModuleDestroy() {
    if (this.client) {
      this.client.quit().catch(() => undefined);
    }
  }

  /** Returns true when the Redis connection is established and ready for commands. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Get a cached value by key.
   * @returns The string value, or `null` if the key does not exist or Redis is unavailable.
   */
  async get(key: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(key);
    } catch (err) {
      this.logger.warn(`Redis get failed for ${key}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Set a key to a value, optionally with a TTL.
   * @param ttlSeconds - Optional expiry in seconds. Omit for no expiry.
   * @returns `true` on success, `false` if Redis is unavailable or the write failed.
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    if (!this.client) return false;
    try {
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
      return true;
    } catch (err) {
      this.logger.warn(`Redis set failed for ${key}: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Sets [key] to [value] only if the key does not already exist (Redis SET NX).
   * Returns true on success, false when the key already existed or Redis is
   * unavailable. Use this for distributed locks and one-shot flags.
   */
  async setIfAbsent(
    key: string,
    value: string,
    ttlSeconds?: number,
  ): Promise<boolean> {
    if (!this.client) return false;
    try {
      const result = ttlSeconds && ttlSeconds > 0
        ? await this.client.set(key, value, 'EX', ttlSeconds, 'NX')
        : await this.client.set(key, value, 'NX');
      return result === 'OK';
    } catch (err: any) {
      this.logger.warn(`Redis setIfAbsent failed for ${key}: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Delete a key. No-ops silently if Redis is unavailable.
   */
  async del(key: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.del(key);
    } catch (err) {
      this.logger.warn(`Redis del failed for ${key}: ${err?.message ?? err}`);
    }
  }
}
