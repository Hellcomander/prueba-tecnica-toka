import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ACCESS_TOKEN_TYP, API_AUDIENCE, INTERNAL_AUDIENCE } from '@toka/contracts';
import { SignJWT } from 'jose';
import { type AccessTokenRequest, AUTH_SETTINGS, type AuthSettings, type SignedAccessToken, type TokenSigner } from '../../application/ports';
import { FileKeyStore } from './key-store';

const SERVICE_TOKEN_TTL_SECONDS = 60;
/** Margen para no usar un token de servicio que vencerá en el viaje. */
const SERVICE_TOKEN_SKEW_SECONDS = 10;

/**
 * Emisión de JWT RS256 con jose. El `typ: at+jwt` (RFC 9068) y el `aud` separan los dos tipos de
 * token: el de usuario (toka-api) nunca sirve en una ruta /internal/*, y el de servicio
 * (toka-internal) nunca sirve en una ruta de usuario. Los verificadores de nest-common lo exigen.
 */
@Injectable()
export class JoseTokenSigner implements TokenSigner {
  private serviceTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly keys: FileKeyStore,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
  ) {}

  async signAccessToken(request: AccessTokenRequest): Promise<SignedAccessToken> {
    const { privateKey, kid } = await this.keys.load();
    const jti = randomUUID();
    const token = await new SignJWT({
      token_use: 'access',
      email: request.email,
      sid: request.sessionId,
      roles: request.roles,
      permissions: request.permissions,
    })
      .setProtectedHeader({ alg: 'RS256', kid, typ: ACCESS_TOKEN_TYP })
      .setIssuer(this.settings.issuer)
      .setAudience(API_AUDIENCE)
      .setSubject(request.userId)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(`${this.settings.accessTokenTtlSeconds}s`)
      .sign(privateKey);
    return { token, jti, expiresInSeconds: this.settings.accessTokenTtlSeconds };
  }

  /**
   * Token de servicio para la llamada S1. auth se lo firma a sí mismo con la misma llave que
   * role-service ya valida por JWKS: no hay secreto compartido que rotar ni credencial de
   * servicio que guardar en el entorno. Dura 60 s, así que robarlo de un log sirve de poco.
   */
  async signServiceToken(scope: string): Promise<string> {
    const cached = this.serviceTokens.get(scope);
    const now = Math.floor(Date.now() / 1_000);
    if (cached && cached.expiresAt - SERVICE_TOKEN_SKEW_SECONDS > now) return cached.token;

    const { privateKey, kid } = await this.keys.load();
    const token = await new SignJWT({ token_use: 'service', scope })
      .setProtectedHeader({ alg: 'RS256', kid, typ: ACCESS_TOKEN_TYP })
      .setIssuer(this.settings.issuer)
      .setAudience(INTERNAL_AUDIENCE)
      .setSubject('service:auth-service')
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${SERVICE_TOKEN_TTL_SECONDS}s`)
      .sign(privateKey);
    this.serviceTokens.set(scope, { token, expiresAt: now + SERVICE_TOKEN_TTL_SECONDS });
    return token;
  }
}
