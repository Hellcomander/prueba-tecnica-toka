import { EnvValidationError, parseEnv } from '@toka/nest-common';
import { envSchema } from './env';

const base = {
  DATABASE_URL: 'postgresql://role_svc:x@postgres:5432/role_db',
  RABBITMQ_URL: 'amqp://toka:x@rabbitmq:5672',
  OIDC_ISSUER: 'http://auth-service:3001',
};

describe('configuración de role-service', () => {
  it('aplica defaults (puerto 3003, semilla demo activa)', () => {
    expect(parseEnv(envSchema, base)).toMatchObject({ PORT: 3003, SEED_DEMO_DATA: true, AUTH_AUDIENCE: 'toka-api' });
    expect(parseEnv(envSchema, { ...base, SEED_DEMO_DATA: 'false' }).SEED_DEMO_DATA).toBe(false);
  });

  it('falla al arrancar si falta la base o la URL no es de Postgres', () => {
    expect(() => parseEnv(envSchema, { ...base, DATABASE_URL: 'mysql://x' })).toThrow(EnvValidationError);
    expect(() => parseEnv(envSchema, { RABBITMQ_URL: base.RABBITMQ_URL, OIDC_ISSUER: base.OIDC_ISSUER })).toThrow(/DATABASE_URL/);
  });
});
