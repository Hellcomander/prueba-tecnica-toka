import { envSchema, resolveProvider } from './env';

const base = {
  OIDC_ISSUER: 'http://auth-service:3001',
  RABBITMQ_URL: 'amqp://rabbit:5672',
  REDIS_URL: 'redis://redis:6379',
  QDRANT_URL: 'http://qdrant:6333',
  USER_SERVICE_URL: 'http://user-service:3002',
  ROLE_SERVICE_URL: 'http://role-service:3003',
  AUDIT_SERVICE_URL: 'http://audit-service:3004',
};

describe('configuración del agente', () => {
  it('arranca sin ninguna variable opcional: el stack corre sin .env', () => {
    const env = envSchema.parse(base);
    expect(env.PORT).toBe(3005);
    expect(env.AI_PROVIDER).toBe('auto');
    expect(env.GEMINI_API_KEY).toBe('');
    expect(env.AI_INGEST_ON_BOOT).toBe(true);
  });

  it('falla al arrancar si falta una URL obligatoria, en vez de levantar a medias', () => {
    expect(() => envSchema.parse({ ...base, QDRANT_URL: undefined })).toThrow();
    expect(() => envSchema.parse({ ...base, AUDIT_SERVICE_URL: 'no-es-una-url' })).toThrow();
  });

  it('los modelos y los precios son configuración, no constantes de código', () => {
    const env = envSchema.parse({ ...base, GEMINI_MODEL: 'gemini-9-ultra', AI_PRICE_INPUT_PER_MTOK: '1.75' });
    expect(env.GEMINI_MODEL).toBe('gemini-9-ultra');
    expect(env.AI_PRICE_INPUT_PER_MTOK).toBe(1.75);
  });

  it('auto elige Gemini solo si hay API key', () => {
    expect(resolveProvider({ AI_PROVIDER: 'auto', GEMINI_API_KEY: '' })).toBe('mock');
    expect(resolveProvider({ AI_PROVIDER: 'auto', GEMINI_API_KEY: 'k' })).toBe('gemini');
  });

  it('mock se puede forzar aunque haya key: hace falta para evaluar de forma reproducible', () => {
    expect(resolveProvider({ AI_PROVIDER: 'mock', GEMINI_API_KEY: 'k' })).toBe('mock');
    expect(resolveProvider({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: '' })).toBe('gemini');
  });

  it('el canario tiene una longitud mínima: una frase corta aparecería por casualidad', () => {
    expect(() => envSchema.parse({ ...base, AI_CANARY: 'corto' })).toThrow();
  });
});
