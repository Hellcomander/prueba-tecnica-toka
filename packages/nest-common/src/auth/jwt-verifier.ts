import { Inject, Injectable } from '@nestjs/common';
import { ACCESS_TOKEN_TYP, API_AUDIENCE, INTERNAL_AUDIENCE, isPermission, type Permission } from '@toka/contracts';
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AuthenticatedUser, ServicePrincipal } from './auth.types';

export interface JwtVerifierOptions {
  /** `iss` esperado; también base del JWKS si no se da `jwksUri`. */
  issuer: string;
  audience?: string;
  jwksUri?: string;
  /** Resolver de llaves alternativo (tests: createLocalJWKSet). */
  keyResolver?: JWTVerifyGetKey;
  clockToleranceSec?: number;
}

export const JWT_VERIFIER_OPTIONS = Symbol('JWT_VERIFIER_OPTIONS');

export type TokenFailureReason = 'invalid' | 'expired' | 'wrong_token_use' | 'insufficient_scope';

export class TokenVerificationError extends Error {
  override readonly name = 'TokenVerificationError';
  constructor(
    readonly reason: TokenFailureReason,
    message: string,
  ) {
    super(message);
  }
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

/**
 * Validación distribuida de JWT: cada servicio verifica localmente con la llave pública del
 * emisor (JWKS en cache 10 min; refetch si llega un `kid` desconocido, como máximo cada 30 s).
 * Solo RS256: un token con `alg: none` o HS256 (ataque de confusión de algoritmo) se rechaza.
 */
@Injectable()
export class JwtVerifier {
  private readonly getKey: JWTVerifyGetKey;

  constructor(@Inject(JWT_VERIFIER_OPTIONS) private readonly options: JwtVerifierOptions) {
    this.getKey =
      options.keyResolver ??
      createRemoteJWKSet(new URL(options.jwksUri ?? `${options.issuer.replace(/\/$/, '')}/.well-known/jwks.json`), {
        cacheMaxAge: 600_000,
        cooldownDuration: 30_000,
        timeoutDuration: 2_000,
      });
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    const payload = await this.verify(token, this.options.audience ?? API_AUDIENCE);
    if (payload.token_use !== 'access') {
      throw new TokenVerificationError('wrong_token_use', 'Se esperaba un access token');
    }
    const { sub, email, sid, roles, permissions } = payload as JWTPayload & Record<string, unknown>;
    if (typeof sub !== 'string' || typeof email !== 'string' || typeof sid !== 'string' || !isStringArray(roles) || !isStringArray(permissions)) {
      throw new TokenVerificationError('invalid', 'Claims incompletos');
    }
    return {
      id: sub,
      email,
      roles,
      permissions: permissions.filter(isPermission) as Permission[],
      sessionId: sid,
      tokenUse: 'access',
    };
  }

  async verifyServiceToken(token: string, requiredScope: string): Promise<ServicePrincipal> {
    const payload = await this.verify(token, INTERNAL_AUDIENCE);
    if (payload.token_use !== 'service' || typeof payload.sub !== 'string') {
      throw new TokenVerificationError('wrong_token_use', 'Se esperaba un token de servicio');
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
    if (!scopes.includes(requiredScope)) {
      throw new TokenVerificationError('insufficient_scope', `Falta el scope ${requiredScope}`);
    }
    return { id: payload.sub, scopes, tokenUse: 'service' };
  }

  private async verify(token: string, audience: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.getKey, {
        issuer: this.options.issuer,
        audience,
        algorithms: ['RS256'],
        typ: ACCESS_TOKEN_TYP,
        clockTolerance: this.options.clockToleranceSec ?? 30,
        requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      });
      return payload;
    } catch (error) {
      if (error instanceof errors.JWTExpired) throw new TokenVerificationError('expired', 'El token expiró');
      throw new TokenVerificationError('invalid', 'Token inválido');
    }
  }
}
