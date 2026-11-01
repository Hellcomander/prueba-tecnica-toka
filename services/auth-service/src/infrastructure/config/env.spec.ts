import { EnvValidationError, parseEnv } from '@toka/nest-common';
import { envSchema } from './env';

const base = {
  DATABASE_URL: 'postgresql://auth_svc:x@postgres:5432/auth_db',
  REDIS_URL: 'redis://:x@redis:6379',
  RABBITMQ_URL: 'amqp://toka:x@rabbitmq:5672',
  OIDC_ISSUER: 'http://auth-service:3001',
  ROLE_SERVICE_URL: 'http://role-service:3003',
};

describe('configuración de auth-service', () => {
  it('aplica defaults (puerto 3001, access token de 10 min, cookie no segura en local)', () => {
    expect(parseEnv(envSchema, base)).toMatchObject({
      PORT: 3001,
      ACCESS_TOKEN_TTL_SECONDS: 600,
      AUTHZ_CACHE_TTL_SECONDS: 600,
      COOKIE_SECURE: false,
      SEED_DEMO_DATA: true,
      JWT_KEYS_DIR: '/keys',
      AUTH_AUDIENCE: 'toka-api',
    });
    expect(parseEnv(envSchema, { ...base, COOKIE_SECURE: 'true', SEED_DEMO_DATA: 'false' })).toMatchObject({
      COOKIE_SECURE: true,
      SEED_DEMO_DATA: false,
    });
  });

  it('falla al arrancar si falta Redis, role-service o la base no es Postgres', () => {
    expect(() => parseEnv(envSchema, { ...base, DATABASE_URL: 'mysql://x' })).toThrow(EnvValidationError);
    expect(() => parseEnv(envSchema, { ...base, REDIS_URL: 'memcached://x' })).toThrow(/REDIS_URL/);
    const { ROLE_SERVICE_URL: _omitted, ...sinRole } = base;
    expect(() => parseEnv(envSchema, sinRole)).toThrow(/ROLE_SERVICE_URL/);
  });

  it('rechaza contraseñas de siembra demasiado cortas', () => {
    expect(() => parseEnv(envSchema, { ...base, SEED_ADMIN_PASSWORD: '123' })).toThrow(/SEED_ADMIN_PASSWORD/);
  });
});
