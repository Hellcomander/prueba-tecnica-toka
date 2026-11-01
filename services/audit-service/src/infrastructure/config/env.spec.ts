import { EnvValidationError, parseEnv } from '@toka/nest-common';
import { envSchema } from './env';

const base = {
  MONGO_URL: 'mongodb://audit_svc:x@mongo:27017/audit_db?authSource=audit_db',
  RABBITMQ_URL: 'amqp://toka:x@rabbitmq:5672',
  OIDC_ISSUER: 'http://auth-service:3001',
};

describe('configuración de audit-service', () => {
  it('aplica defaults (puerto 3004, audiencia toka-api)', () => {
    expect(parseEnv(envSchema, base)).toMatchObject({ PORT: 3004, AUTH_AUDIENCE: 'toka-api' });
  });

  it('falla al arrancar si falta MONGO_URL o no es una URL de Mongo', () => {
    expect(() => parseEnv(envSchema, { ...base, MONGO_URL: 'postgresql://x' })).toThrow(EnvValidationError);
    expect(() => parseEnv(envSchema, { RABBITMQ_URL: base.RABBITMQ_URL, OIDC_ISSUER: base.OIDC_ISSUER })).toThrow(/MONGO_URL/);
  });
});
