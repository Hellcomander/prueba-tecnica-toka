import { Inject, Injectable } from '@nestjs/common';
import type { UserAuthorization } from '@toka/contracts';
import { DomainError } from '../../domain/shared/domain-error';
import { AUTHORIZATION_CACHE, type AuthorizationCache, AUTHORIZATION_PROVIDER, type AuthorizationProvider } from '../ports';

/**
 * S1 con degradación controlada. auth necesita los roles y permisos de role-service para firmar
 * el JWT; la llamada va por la red interna con timeout, reintentos y circuit breaker.
 *
 * Si role-service no responde se usa la última copia conocida (Redis, TTL 10 min). Es un
 * compromiso consciente: durante esa ventana un permiso recién retirado puede seguir vigente,
 * a cambio de que una caída de role-service no tire el login de todo el sistema. El tope de
 * 10 minutos acota el daño y coincide con la vida del access token.
 *
 * Si tampoco hay copia, **falla cerrado**: 503. Nunca se emite un token "sin permisos" como si
 * fuera válido, porque el usuario lo viviría como una pérdida silenciosa de accesos y, peor, la
 * UI no podría distinguirlo de una cuenta legítimamente sin permisos.
 */
@Injectable()
export class AuthorizationResolver {
  constructor(
    @Inject(AUTHORIZATION_PROVIDER) private readonly provider: AuthorizationProvider,
    @Inject(AUTHORIZATION_CACHE) private readonly cache: AuthorizationCache,
  ) {}

  async resolve(userId: string): Promise<UserAuthorization> {
    try {
      const authorization = await this.provider.fetch(userId);
      await this.cache.save(authorization).catch(() => undefined);
      return authorization;
    } catch {
      const stale = await this.cache.find(userId).catch(() => null);
      if (stale) return stale;
      throw new DomainError(
        'AUTHORIZATION_UNAVAILABLE',
        'unavailable',
        'No se pudieron determinar tus permisos en este momento; vuelve a intentar en unos segundos',
      );
    }
  }
}
