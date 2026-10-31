import { API_AUDIENCE, SCOPES } from '@toka/contracts';
import { SignJWT, generateKeyPair } from 'jose';
import { JwtVerifier, TokenVerificationError } from './jwt-verifier';
import { TestTokenFactory } from './test-token-factory';

describe('JwtVerifier (RS256 con llaves reales)', () => {
  let tokens: TestTokenFactory;
  let verifier: JwtVerifier;

  beforeAll(async () => {
    tokens = await TestTokenFactory.create('http://auth.test');
    verifier = new JwtVerifier({ issuer: 'http://auth.test', keyResolver: tokens.keyResolver() });
  });

  const reasonOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return 'ok';
    } catch (e) {
      return (e as TokenVerificationError).reason;
    }
  };

  it('acepta un access token válido y mapea los claims', async () => {
    const user = await verifier.verifyAccessToken(
      await tokens.accessToken({ sub: 'u-1', permissions: ['users:read', 'not:a-permission'], roles: ['viewer'] }),
    );
    expect(user).toEqual({
      id: 'u-1',
      email: 'admin@toka.test',
      roles: ['viewer'],
      permissions: ['users:read'],
      sessionId: 'session-1',
      tokenUse: 'access',
    });
  });

  it('rechaza expirado, otra audiencia, otro emisor, typ incorrecto y token de servicio en ruta de usuario', async () => {
    expect(await reasonOf(verifier.verifyAccessToken(await tokens.accessToken({ expiresIn: Math.floor(Date.now() / 1000) - 120 })))).toBe('expired');
    expect(await reasonOf(verifier.verifyAccessToken(await tokens.accessToken({ aud: 'otra-api' })))).toBe('invalid');
    expect(await reasonOf(verifier.verifyAccessToken(await tokens.accessToken({ iss: 'http://evil' })))).toBe('invalid');
    expect(await reasonOf(verifier.verifyAccessToken(await tokens.accessToken({ typ: 'JWT' })))).toBe('invalid');
    expect(await reasonOf(verifier.verifyAccessToken(await tokens.serviceToken(SCOPES.AUTHZ_READ)))).toBe('invalid');
    expect(await reasonOf(verifier.verifyAccessToken(await tokens.accessToken({ token_use: 'service' })))).toBe('wrong_token_use');
  });

  it('rechaza un token firmado con otra llave, alterado o con alg HS256', async () => {
    const other = await TestTokenFactory.create('http://auth.test');
    expect(await reasonOf(verifier.verifyAccessToken(await other.accessToken()))).toBe('invalid');

    const [h, p, s] = (await tokens.accessToken()).split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.permissions = ['users:read', 'users:write', 'roles:assign'];
    const tampered = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.');
    expect(await reasonOf(verifier.verifyAccessToken(tampered))).toBe('invalid');

    const hs256 = await new SignJWT({ token_use: 'access' })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer('http://auth.test')
      .setAudience(API_AUDIENCE)
      .setSubject('u')
      .setJti('j')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('secreto-compartido-de-32-bytes!!'));
    expect(await reasonOf(verifier.verifyAccessToken(hs256))).toBe('invalid');
  });

  it('rechaza claims incompletos', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    expect(privateKey).toBeDefined();
    const incomplete = await tokens.accessToken({ roles: 'admin' as unknown as string[] });
    expect(await reasonOf(verifier.verifyAccessToken(incomplete))).toBe('invalid');
  });

  it('token de servicio: exige audiencia interna, token_use y scope', async () => {
    const principal = await verifier.verifyServiceToken(await tokens.serviceToken(SCOPES.AUTHZ_READ), SCOPES.AUTHZ_READ);
    expect(principal).toEqual({ id: 'service:auth-service', scopes: ['authz:read'], tokenUse: 'service' });
    expect(await reasonOf(verifier.verifyServiceToken(await tokens.serviceToken('otro:scope'), SCOPES.AUTHZ_READ))).toBe('insufficient_scope');
    expect(await reasonOf(verifier.verifyServiceToken(await tokens.accessToken(), SCOPES.AUTHZ_READ))).toBe('invalid');
    expect(await reasonOf(verifier.verifyServiceToken(await tokens.accessToken({ aud: 'toka-internal' }), SCOPES.AUTHZ_READ))).toBe('wrong_token_use');
  });

  it('sin keyResolver arma el JWKS remoto desde el issuer (sin llamar a la red al construir)', () => {
    expect(() => new JwtVerifier({ issuer: 'http://auth-service:3001/' })).not.toThrow();
    expect(new TokenVerificationError('invalid', 'x')).toBeInstanceOf(Error);
  });
});
