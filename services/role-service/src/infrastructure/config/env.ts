import { amqpEnvSchema, authEnvSchema, baseEnvSchema, parseEnv } from '@toka/nest-common';
import { z } from 'zod';

export const envSchema = baseEnvSchema
  .extend(authEnvSchema.shape)
  .extend(amqpEnvSchema.shape)
  .extend({
    PORT: z.coerce.number().int().positive().default(3003),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'debe ser una URL de PostgreSQL'),
    SEED_DEMO_DATA: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  });

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

export const loadEnv = (): Env => parseEnv(envSchema);
