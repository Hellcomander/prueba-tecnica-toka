import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { isPermission, type Permission, SCOPES, type UserAuthorization } from '@toka/contracts';
import { ResilientHttpClient } from '@toka/nest-common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { type AuthorizationProvider, TOKEN_SIGNER, type TokenSigner } from '../../application/ports';
import { ENV, type Env } from '../config/env';

interface AuthorizationResponse {
  userId?: unknown;
  roles?: unknown;
  permissions?: unknown;
}

/**
 * S1: GET /internal/v1/authorizations/{userId} contra role-service, por la red interna de Docker
 * (nunca por el gateway, que responde 404 a /internal/*). El cliente de nest-common pone timeout
 * de 1 s, 2 reintentos con full jitter y un circuit breaker: cuando role-service está caído, el
 * breaker abre y el login falla rápido en vez de acumular requests colgados.
 *
 * La credencial es un token de servicio de 60 s firmado por auth con su propia llave, con
 * `aud: toka-internal` y `scope: authz:read`; role-service lo valida con el mismo JWKS que ya usa
 * para los tokens de usuario. No hay API key compartida que rotar.
 */
@Injectable()
export class RoleAuthorizationProvider implements AuthorizationProvider, OnApplicationShutdown {
  private readonly client: ResilientHttpClient;

  constructor(
    @Inject(TOKEN_SIGNER) private readonly tokens: TokenSigner,
    @Inject(ENV) env: Env,
    @InjectPinoLogger(RoleAuthorizationProvider.name) logger: PinoLogger,
  ) {
    this.client = new ResilientHttpClient({
      name: 'role-service',
      baseURL: env.ROLE_SERVICE_URL,
      timeoutMs: env.ROLE_SERVICE_TIMEOUT_MS,
      retries: 2,
      logger: {
        info: (obj, msg) => logger.info(obj, msg),
        warn: (obj, msg) => logger.warn(obj, msg),
      },
    });
  }

  async fetch(userId: string): Promise<UserAuthorization> {
    const token = await this.tokens.signServiceToken(SCOPES.AUTHZ_READ);
    const body = await this.client.get<AuthorizationResponse>(`/internal/v1/authorizations/${userId}`, {
      authorization: `Bearer ${token}`,
    });
    return {
      userId,
      roles: Array.isArray(body?.roles) ? body.roles.filter((r): r is string => typeof r === 'string') : [],
      // Un permiso que este servicio no conoce se descarta: el catálogo de @toka/contracts manda.
      permissions: Array.isArray(body?.permissions)
        ? (body.permissions.filter((p): p is Permission => typeof p === 'string' && isPermission(p)) as Permission[])
        : [],
    };
  }

  onApplicationShutdown(): void {
    this.client.shutdown();
  }
}
