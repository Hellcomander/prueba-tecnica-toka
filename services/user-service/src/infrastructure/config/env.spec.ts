import { EnvValidationError, parseEnv } from '@toka/nest-common';
import { envSchema } from './env';

const base = {
  DATABASE_URL: 'postgresql://user_svc:x@postgres:5432/user_db',
  RABBITMQ_URL: 'amqp://toka:x@rabbitmq:5672',
  REDIS_URL: 'redis://:x@redis:6379',
  OIDC_ISSUER: 'http://auth-service:3001',
};

describe('configuración de user-service', () => {
  it('aplica defaults (puerto 3002, cache de 30 s)', () => {
    expect(parseEnv(envSchema, base)).toMatchObject({ PORT: 3002, STATS_CACHE_TTL_SECONDS: 30, AUTH_AUDIENCE: 'toka-api' });
    expect(parseEnv(envSchema, { ...base, STATS_CACHE_TTL_SECONDS: '5' }).STATS_CACHE_TTL_SECONDS).toBe(5);
  });

  it('falla al arrancar si falta la base, Redis o la URL no es de Postgres', () => {
    expect(() => parseEnv(envSchema, { ...base, DATABASE_URL: 'mysql://x' })).toThrow(EnvValidationError);
    const { REDIS_URL: _omit, ...withoutRedis } = base;
    expect(() => parseEnv(envSchema, withoutRedis)).toThrow(/REDIS_URL/);
  });
});
