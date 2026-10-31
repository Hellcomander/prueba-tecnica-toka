import { randomUUID } from 'node:crypto';
import { ACCESS_TOKEN_TYP, API_AUDIENCE, INTERNAL_AUDIENCE, type Permission } from '@toka/contracts';
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type JWTVerifyGetKey, SignJWT } from 'jose';

type KeyLike = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export interface AccessTokenOverrides {
  sub?: string;
  email?: string;
  roles?: string[];
  permissions?: Permission[] | string[];
  sid?: string;
  aud?: string;
  iss?: string;
  token_use?: string;
  expiresIn?: string | number;
  typ?: string;
}

/**
 * Para tests: genera un par RS256 real y firma tokens como lo hará auth-service. Los tests de
 * guards usan llaves y firmas reales, no mocks de jose.
 */
export class TestTokenFactory {
  private constructor(
    readonly issuer: string,
    private readonly privateKey: KeyLike,
    readonly publicJwk: JWK,
  ) {}

  static async create(issuer = 'http://auth.test'): Promise<TestTokenFactory> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    return new TestTokenFactory(issuer, privateKey, publicJwk);
  }

  keyResolver(): JWTVerifyGetKey {
    return createLocalJWKSet({ keys: [this.publicJwk] });
  }

  accessToken(overrides: AccessTokenOverrides = {}): Promise<string> {
    return new SignJWT({
      token_use: overrides.token_use ?? 'access',
      email: overrides.email ?? 'admin@toka.test',
      roles: overrides.roles ?? ['admin'],
      permissions: overrides.permissions ?? ['users:read', 'users:write'],
      sid: overrides.sid ?? 'session-1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: overrides.typ ?? ACCESS_TOKEN_TYP })
      .setIssuer(overrides.iss ?? this.issuer)
      .setAudience(overrides.aud ?? API_AUDIENCE)
      .setSubject(overrides.sub ?? '7b0c6f0e-6d1e-4c39-9f43-4a1f3b9e2a10')
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? '10m')
      .sign(this.privateKey);
  }

  serviceToken(scope: string, overrides: { aud?: string; sub?: string; expiresIn?: string | number } = {}): Promise<string> {
    return new SignJWT({ token_use: 'service', scope })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: ACCESS_TOKEN_TYP })
      .setIssuer(this.issuer)
      .setAudience(overrides.aud ?? INTERNAL_AUDIENCE)
      .setSubject(overrides.sub ?? 'service:auth-service')
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? '60s')
      .sign(this.privateKey);
  }
}
