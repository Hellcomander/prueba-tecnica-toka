import { Inject, Injectable } from '@nestjs/common';
import { ACCESS_TOKEN_TYP, API_AUDIENCE, type Permission } from '@toka/contracts';
import { ACCOUNT_REPOSITORY, type AccountRepository } from '../../domain/ports';
import { DomainError } from '../../domain/shared/domain-error';
import { toUserInfoView, type UserInfoView } from '../mappers/views';
import { AUTH_SETTINGS, type AuthSettings, KEY_SET_PROVIDER, type KeySetProvider } from '../ports';

export interface AuthenticatedClaims {
  id: string;
  email: string;
  roles: string[];
  permissions: Permission[];
  sessionId: string;
}

/**
 * Datos del token actual. Se confirma contra la base que la cuenta sigue viva: un access token
 * es válido hasta que expira, y userinfo es el lugar natural para que la UI note una suspensión
 * antes de los 10 minutos.
 */
@Injectable()
export class UserInfoQuery {
  constructor(@Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository) {}

  async execute(claims: AuthenticatedClaims): Promise<UserInfoView> {
    const account = await this.accounts.findById(claims.id);
    if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', 'unauthorized', 'La cuenta ya no existe');
    account.assertCanAuthenticate();
    return toUserInfoView(account, claims.sessionId, { userId: account.id, roles: claims.roles, permissions: claims.permissions });
  }
}

/**
 * Discovery OIDC con SOLO lo que este servicio implementa de verdad. No se anuncian
 * `token_endpoint` ni `authorization_endpoint`: auth-service no expone los flujos de OAuth 2.0,
 * emite sus tokens en /api/v1/auth/login. Publicar endpoints inexistentes rompería a cualquier
 * cliente OIDC genérico que confiara en el documento.
 */
@Injectable()
export class DiscoveryQuery {
  constructor(@Inject(AUTH_SETTINGS) private readonly settings: AuthSettings) {}

  execute(): Record<string, unknown> {
    const issuer = this.settings.issuer.replace(/\/$/, '');
    return {
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      userinfo_endpoint: `${issuer}/api/v1/auth/userinfo`,
      id_token_signing_alg_values_supported: ['RS256'],
      subject_types_supported: ['public'],
      token_endpoint_auth_signing_alg_values_supported: ['RS256'],
      claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'sid', 'email', 'roles', 'permissions', 'token_use'],
      response_types_supported: [],
      grant_types_supported: [],
      scopes_supported: [],
      audiences_supported: [API_AUDIENCE],
      access_token_types_supported: [ACCESS_TOKEN_TYP],
    };
  }
}

@Injectable()
export class JwksQuery {
  constructor(@Inject(KEY_SET_PROVIDER) private readonly keys: KeySetProvider) {}

  execute(): Promise<{ keys: Record<string, unknown>[] }> {
    return this.keys.jwks();
  }
}
