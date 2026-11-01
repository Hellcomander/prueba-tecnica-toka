import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERNAL_AUDIENCE, SCOPES } from '@toka/contracts';
import { JwtVerifier } from '@toka/nest-common';
import { decodeProtectedHeader } from 'jose';
import type { AuthSettings } from '../../application/ports';
import { JoseTokenSigner } from './jose-token-signer';
import { FileKeyStore } from './key-store';

const settings: AuthSettings = {
  issuer: 'http://auth.test',
  accessTokenTtlSeconds: 600,
  refreshTokenTtlSeconds: 3_600,
  sessionTtlSeconds: 7_200,
  demoPasswords: { admin: 'x', auditor: 'y', viewer: 'z' },
};

const newDir = () => mkdtemp(join(tmpdir(), 'toka-keys-'));

describe('FileKeyStore', () => {
  it('genera el par la primera vez, lo persiste y lo reutiliza en el siguiente arranque', async () => {
    const dir = await newDir();
    const first = await new FileKeyStore(dir).load();
    const second = await new FileKeyStore(dir).load();

    // Mismo kid = misma llave: los tokens emitidos antes del reinicio siguen validando.
    expect(second.kid).toBe(first.kid);
    expect(first.kid).toEqual(expect.any(String));
  });

  it('el JWKS publica solo material público', async () => {
    const jwks = await new FileKeyStore(await newDir()).jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(jwks.keys[0][secret]).toBeUndefined();
  });

  it('dos arranques simultáneos no se pisan: gana uno y el otro adopta su llave', async () => {
    const dir = await newDir();
    // Sin el flag 'wx' los dos escribirían y uno quedaría firmando con una llave que nadie conoce.
    const [a, b] = await Promise.all([new FileKeyStore(dir).load(), new FileKeyStore(dir).load()]);
    expect(a.kid).toBe(b.kid);
    expect((await new FileKeyStore(dir).load()).kid).toBe(a.kid);
  });
});

describe('JoseTokenSigner', () => {
  const build = async () => {
    const keys = new FileKeyStore(await newDir());
    const signer = new JoseTokenSigner(keys, settings);
    const verifier = new JwtVerifier({ issuer: settings.issuer, keyResolver: keys.verificationKeyResolver() });
    return { keys, signer, verifier };
  };

  it('el access token lleva el kid del JWKS y lo valida el verificador compartido', async () => {
    const { keys, signer, verifier } = await build();
    const signed = await signer.signAccessToken({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'admin@toka.local',
      sessionId: 'sid-1',
      roles: ['admin'],
      permissions: ['users:write'],
    });

    expect(decodeProtectedHeader(signed.token)).toMatchObject({ alg: 'RS256', typ: 'at+jwt', kid: (await keys.load()).kid });
    expect(await verifier.verifyAccessToken(signed.token)).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      email: 'admin@toka.local',
      roles: ['admin'],
      permissions: ['users:write'],
      sessionId: 'sid-1',
      tokenUse: 'access',
    });
  });

  it('el token de servicio de S1 cumple el contrato que valida role-service y se reusa mientras vive', async () => {
    const { signer, verifier } = await build();
    const token = await signer.signServiceToken(SCOPES.AUTHZ_READ);

    const principal = await verifier.verifyServiceToken(token, SCOPES.AUTHZ_READ);
    expect(principal).toEqual({ id: 'service:auth-service', scopes: [SCOPES.AUTHZ_READ], tokenUse: 'service' });
    // Audiencias separadas: un token de servicio no sirve como token de usuario, ni al revés.
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
    await expect(verifier.verifyServiceToken(token, 'otro:scope')).rejects.toThrow(/otro:scope/);
    expect(INTERNAL_AUDIENCE).toBe('toka-internal');

    // Se firma una vez por minuto, no en cada login.
    expect(await signer.signServiceToken(SCOPES.AUTHZ_READ)).toBe(token);
  });
});
