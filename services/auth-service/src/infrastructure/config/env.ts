import { amqpEnvSchema, authEnvSchema, baseEnvSchema, parseEnv, redisEnvSchema } from '@toka/nest-common';
import { z } from 'zod';

const seconds = (def: number) => z.coerce.number().int().positive().default(def);

export const envSchema = baseEnvSchema
  .extend(authEnvSchema.shape)
  .extend(amqpEnvSchema.shape)
  .extend(redisEnvSchema.shape)
  .extend({
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'debe ser una URL de PostgreSQL'),
    /** Destino de la llamada S1, por la red interna de Docker (no por el gateway). */
    ROLE_SERVICE_URL: z.url(),
    ROLE_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(1_000),
    /** Volumen persistente del par RS256: sin él, cada reinicio invalidaría todos los tokens. */
    JWT_KEYS_DIR: z.string().min(1).default('/keys'),
    ACCESS_TOKEN_TTL_SECONDS: seconds(600),
    REFRESH_TOKEN_TTL_SECONDS: seconds(7 * 24 * 3_600),
    /** Tope absoluto de la sesión: renovar no la vuelve eterna. */
    SESSION_TTL_SECONDS: seconds(30 * 24 * 3_600),
    /** Vida de la copia stale de autorizaciones (S1). */
    AUTHZ_CACHE_TTL_SECONDS: seconds(600),
    /** En local el stack corre sobre http: la cookie Secure no viajaría. */
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SEED_DEMO_DATA: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    SEED_ADMIN_PASSWORD: z.string().min(10).default('Admin123!demo'),
    SEED_AUDITOR_PASSWORD: z.string().min(10).default('Auditor123!demo'),
    SEED_VIEWER_PASSWORD: z.string().min(10).default('Viewer123!demo'),
  });

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

export const loadEnv = (): Env => parseEnv(envSchema);
