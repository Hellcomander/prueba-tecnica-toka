import { amqpEnvSchema, authEnvSchema, baseEnvSchema, parseEnv } from '@toka/nest-common';
import { z } from 'zod';

export const envSchema = baseEnvSchema
  .extend(authEnvSchema.shape)
  .extend(amqpEnvSchema.shape)
  .extend({
    PORT: z.coerce.number().int().positive().default(3004),
    MONGO_URL: z.string().regex(/^mongodb(\+srv)?:\/\//, 'debe empezar con mongodb:// o mongodb+srv://'),
  });

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

export const loadEnv = (): Env => parseEnv(envSchema);
