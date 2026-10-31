import { API_AUDIENCE } from '@toka/contracts';
import { z } from 'zod';

export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError';
}

/**
 * Valida process.env contra un schema zod al arrancar (fail fast): un servicio mal configurado
 * no debe levantar a medias. El mensaje lista cada variable inválida.
 */
export function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new EnvValidationError(`Configuración inválida:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().positive(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
});

export const authEnvSchema = z.object({
  OIDC_ISSUER: z.url(),
  JWKS_URI: z.url().optional(),
  AUTH_AUDIENCE: z.string().min(1).default(API_AUDIENCE),
});

export const amqpEnvSchema = z.object({
  RABBITMQ_URL: z.string().regex(/^amqps?:\/\//, 'debe empezar con amqp:// o amqps://'),
});

export const redisEnvSchema = z.object({
  REDIS_URL: z.string().regex(/^rediss?:\/\//, 'debe empezar con redis:// o rediss://'),
});
