import { amqpEnvSchema, authEnvSchema, baseEnvSchema, parseEnv, redisEnvSchema } from '@toka/nest-common';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false'])
    .default(String(def) as 'true' | 'false')
    .transform((v) => v === 'true');

/**
 * Configuración del agente. Tres cosas que no son casuales:
 *
 *  - **Ningún identificador de modelo está fijo en el código.** Los modelos de Gemini aparecen y
 *    se retiran con semanas de aviso (en el spike de F0, `gemini-2.5-flash` ya respondía 404 a
 *    claves nuevas). Cambiar de modelo tiene que ser una variable de entorno, no un despliegue.
 *  - **Los precios también son configuración.** Un número de costo que envejece en silencio es
 *    peor que no tenerlo.
 *  - **`AI_PROVIDER=auto`** elige Gemini si hay API key y el proveedor mock si no. Así el stack
 *    arranca y se puede evaluar **sin API key**, que es como lo va a recibir quien revise esto.
 */
export const envSchema = baseEnvSchema
  .extend(authEnvSchema.shape)
  .extend(amqpEnvSchema.shape)
  .extend(redisEnvSchema.shape)
  .extend({
    PORT: z.coerce.number().int().positive().default(3005),

    AI_PROVIDER: z.enum(['auto', 'gemini', 'mock']).default('auto'),
    GEMINI_API_KEY: z.string().trim().default(''),
    GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash'),
    GEMINI_FALLBACK_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
    GEMINI_EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-001'),
    GEMINI_EMBEDDING_DIM: z.coerce.number().int().positive().default(768),
    /** Plazo propio por llamada: sin él, el spike midió un request colgado 232 s. */
    AI_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1_024),

    AI_GLOBAL_RPM: z.coerce.number().int().positive().default(8),
    AI_GLOBAL_RPD: z.coerce.number().int().positive().default(200),
    AI_USER_RPM: z.coerce.number().int().positive().default(4),
    AI_USER_DAILY_TOKENS: z.coerce.number().int().positive().default(50_000),

    QDRANT_URL: z.url(),
    QDRANT_COLLECTION: z.string().min(1).default('toka_kb'),

    USER_SERVICE_URL: z.url(),
    ROLE_SERVICE_URL: z.url(),
    AUDIT_SERVICE_URL: z.url(),
    TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),

    AI_PROMPT_VERSION: z.enum(['agent-v1', 'agent-v2']).default('agent-v2'),
    AI_CANARY: z.string().min(8).default('TOKA-CANARY-7F3A91'),
    AI_MAX_TOOL_STEPS: z.coerce.number().int().min(1).max(10).default(4),
    AI_RETRIEVAL_LIMIT: z.coerce.number().int().min(1).max(20).default(5),
    AI_RETRIEVAL_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.35),
    AI_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(300),

    /** Precios de la familia Flash (USD por millón de tokens). Ver docs/ai/evaluation.md. */
    AI_PRICE_INPUT_PER_MTOK: z.coerce.number().nonnegative().default(0.3),
    AI_PRICE_OUTPUT_PER_MTOK: z.coerce.number().nonnegative().default(2.5),
    AI_PRICE_EMBEDDING_PER_MTOK: z.coerce.number().nonnegative().default(0.15),

    KNOWLEDGE_BASE_DIR: z.string().min(1).default('knowledge-base'),
    AI_INGEST_ON_BOOT: bool(true),
  });

export type Env = z.infer<typeof envSchema>;

export const ENV = Symbol('ENV');

export const loadEnv = (): Env => parseEnv(envSchema);

/** `auto` con key → Gemini; `auto` sin key → mock. Es la decisión que hace el stack ejecutable sin secretos. */
export function resolveProvider(env: Pick<Env, 'AI_PROVIDER' | 'GEMINI_API_KEY'>): 'gemini' | 'mock' {
  if (env.AI_PROVIDER === 'mock') return 'mock';
  if (env.AI_PROVIDER === 'gemini') return 'gemini';
  return env.GEMINI_API_KEY ? 'gemini' : 'mock';
}
