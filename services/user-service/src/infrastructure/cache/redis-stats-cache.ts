import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { StatsCache } from '../../application/ports';
import type { UserStats } from '../../application/queries/read-model';
import { ENV, type Env } from '../config/env';

const KEY = 'user-service:stats:v1';

/**
 * Cache de estadísticas en Redis. Degrada a *miss* ante cualquier fallo (Redis caído, JSON roto):
 * nunca propaga el error, así que un Redis lento o caído solo hace las consultas más lentas.
 * Sin cola offline, los comandos fallan de inmediato mientras no hay conexión.
 */
@Injectable()
export class RedisStatsCache implements StatsCache, OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @InjectPinoLogger(RedisStatsCache.name) private readonly logger: PinoLogger,
  ) {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2_000 });
    // Sin listener de 'error', ioredis imprime cada reintento de conexión sin pasar por el logger.
    this.redis.on('error', (err) => this.logger.warn({ event: 'cache.error', err }, 'cache.error'));
  }

  async get(): Promise<UserStats | null> {
    try {
      const raw = await this.redis.get(KEY);
      return raw ? (JSON.parse(raw) as UserStats) : null;
    } catch (err) {
      this.logger.warn({ event: 'cache.get_failed', err }, 'cache.get_failed');
      return null;
    }
  }

  async set(stats: UserStats): Promise<void> {
    try {
      await this.redis.set(KEY, JSON.stringify(stats), 'EX', this.env.STATS_CACHE_TTL_SECONDS);
    } catch (err) {
      this.logger.warn({ event: 'cache.set_failed', err }, 'cache.set_failed');
    }
  }

  async invalidate(): Promise<void> {
    try {
      await this.redis.del(KEY);
    } catch (err) {
      this.logger.warn({ event: 'cache.invalidate_failed', err }, 'cache.invalidate_failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}
