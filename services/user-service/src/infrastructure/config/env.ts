import { amqpEnvSchema, authEnvSchema, baseEnvSchema, parseEnv, redisEnvSchema } from '@toka/nest-common';
import { z } from 'zod';

export const envSchema = baseEnvSchema
  .extend(authEnvSchema.shape)
  .extend(amqpEnvSchema.shape)
  .extend(redisEnvSchema.shape)
  .extend({
    PORT: z.coerce.number().int().positive().default(3002),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'debe ser una URL de PostgreSQL'),
    /** Vigencia de las estadísticas en cache; además se invalidan al cambiar estados o roles. */
    STATS_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  });

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

export const loadEnv = (): Env => parseEnv(envSchema);
