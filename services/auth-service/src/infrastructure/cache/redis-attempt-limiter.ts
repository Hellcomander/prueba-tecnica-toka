import { Injectable } from '@nestjs/common';
import type { AttemptFailure, AttemptLimiter, AttemptStatus } from '../../application/ports';
import { FAILURE_WINDOW_MS, lockDurationMs } from '../../domain/security/lockout-policy';
import { RedisService } from './redis.service';

const failKey = (key: string) => `auth:fail:${key}`;
const lockKey = (key: string) => `auth:lock:${key}`;

/**
 * Contador de intentos en Redis. Dos llaves, las dos con TTL (el Redis del compose corre con
 * `noeviction`, así que nada puede quedarse sin vencer): un contador con ventana deslizante de
 * 15 min y, cuando se cruza el umbral, un candado con la duración que decide la política del
 * dominio. La política no vive aquí: este adaptador solo cuenta y guarda.
 */
@Injectable()
export class RedisAttemptLimiter implements AttemptLimiter {
  constructor(private readonly redis: RedisService) {}

  async status(key: string): Promise<AttemptStatus> {
    const ttlMs = await this.redis.pttl(lockKey(key));
    return ttlMs > 0 ? { locked: true, retryAfterSeconds: Math.ceil(ttlMs / 1_000) } : { locked: false, retryAfterSeconds: 0 };
  }

  async registerFailure(key: string): Promise<AttemptFailure> {
    const failures = await this.redis.incr(failKey(key));
    if (failures === 1) await this.redis.pexpire(failKey(key), FAILURE_WINDOW_MS);
    const durationMs = lockDurationMs(failures);
    if (durationMs === 0) return { failures, lockedUntil: null };
    await this.redis.set(lockKey(key), '1', 'PX', durationMs);
    return { failures, lockedUntil: new Date(Date.now() + durationMs) };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(failKey(key), lockKey(key));
  }
}
