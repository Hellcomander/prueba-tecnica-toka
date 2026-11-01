import { Inject, Injectable } from '@nestjs/common';
import { isPermission, type Permission, type UserAuthorization } from '@toka/contracts';
import type { AuthorizationCache } from '../../application/ports';
import { ENV, type Env } from '../config/env';
import { RedisService } from './redis.service';

const key = (userId: string) => `auth:authz:${userId}`;

/**
 * Copia "stale" de la última autorización conocida de cada usuario (S1). Solo se usa cuando
 * role-service no responde; su TTL (10 min por defecto) es el tope de cuánto puede sobrevivir un
 * permiso ya retirado durante una caída.
 */
@Injectable()
export class RedisAuthorizationCache implements AuthorizationCache {
  constructor(
    private readonly redis: RedisService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async find(userId: string): Promise<UserAuthorization | null> {
    const raw = await this.redis.get(key(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { roles?: unknown; permissions?: unknown };
    const roles = Array.isArray(parsed.roles) ? parsed.roles.filter((r): r is string => typeof r === 'string') : [];
    const permissions = Array.isArray(parsed.permissions)
      ? (parsed.permissions.filter((p): p is Permission => typeof p === 'string' && isPermission(p)) as Permission[])
      : [];
    return { userId, roles, permissions };
  }

  async save(authorization: UserAuthorization): Promise<void> {
    await this.redis.set(
      key(authorization.userId),
      JSON.stringify({ roles: authorization.roles, permissions: authorization.permissions }),
      'EX',
      this.env.AUTHZ_CACHE_TTL_SECONDS,
    );
  }
}
