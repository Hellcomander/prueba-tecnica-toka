import { DomainError } from '../../domain/shared/domain-error';

/**
 * Traducción de los errores de Gemini al vocabulario propio. Está en su propio archivo, separada
 * del cliente, porque es lógica con reglas y se prueba con fixtures de errores reales — no hace
 * falta una API key ni red para comprobar que un 429 se convierte en una espera concreta.
 *
 * El 429 es el único que lleva `retryAfterSeconds`: es un dato que el usuario puede usar ("vuelve
 * en 27 segundos"), no ruido técnico. Reintentar a ciegas contra un límite de cuota solo lo
 * empeora, así que el número sale de `google.rpc.RetryInfo.retryDelay` cuando el proveedor lo
 * manda, y de un valor conservador cuando no.
 */
export interface ProviderErrorShape {
  status?: number;
  code?: number;
  message?: string;
}

const DEFAULT_RETRY_SECONDS = 60;

export function translateGeminiError(error: unknown, model: string): DomainError {
  const shape = (error ?? {}) as ProviderErrorShape;
  const status = shape.status ?? shape.code;
  const message = error instanceof Error ? error.message : String(error ?? '');

  if (status === 429) {
    return new DomainError(
      'AI_PROVIDER_RATE_LIMITED',
      'unprocessable',
      'El proveedor del modelo agotó la cuota disponible.',
      retryDelaySeconds(message) ?? DEFAULT_RETRY_SECONDS,
    );
  }
  if (status === 404) {
    // Pasó de verdad en el spike de F0: `gemini-2.5-flash` dejó de estar disponible para claves
    // nuevas sin que cambiara nada del código.
    return new DomainError('AI_MODEL_NOT_AVAILABLE', 'unavailable', `El modelo ${model} no está disponible para esta clave.`);
  }
  if (status === 504 || /deadline|timeout|aborted/i.test(message)) {
    return new DomainError('AI_PROVIDER_TIMEOUT', 'unavailable', `El modelo ${model} no respondió a tiempo.`);
  }
  return new DomainError('AI_PROVIDER_ERROR', 'unavailable', `El proveedor del modelo no respondió (${status ?? 'sin estado'}).`);
}

/**
 * Campos estructurados del error, para el log. Existe porque registrar
 * `message.slice(0, 300)` corta justo donde empieza lo único accionable: **qué** cuota se agotó,
 * cuál era el límite y cuándo se restablece. Pasó de verdad: con el log truncado, un 429 por
 * agotar las 20 peticiones diarias del modelo primario era indistinguible de un 429 por ráfaga,
 * y la diferencia es "espera un minuto" contra "espera trece horas".
 */
export interface ProviderErrorFacts {
  status: number | null;
  code: string;
  /** p. ej. `generate_content_free_tier_requests`. */
  quotaMetric?: string;
  quotaLimit?: string;
  /** Modelo contra el que Google contabiliza la cuota: no siempre es el que se pidió. */
  quotaModel?: string;
  retryAfterSeconds?: number;
}

interface GoogleErrorDetail {
  '@type': string;
  retryDelay?: string;
  violations?: Array<{ quotaMetric?: string; quotaValue?: string; quotaDimensions?: Record<string, string> }>;
}

export function describeProviderError(error: unknown): ProviderErrorFacts {
  const shape = (error ?? {}) as ProviderErrorShape;
  const message = error instanceof Error ? error.message : String(error ?? '');
  const translated = translateGeminiError(error, '');
  const facts: ProviderErrorFacts = { status: shape.status ?? shape.code ?? null, code: translated.code };
  if (translated.retryAfterSeconds) facts.retryAfterSeconds = translated.retryAfterSeconds;

  for (const detail of parseDetails(message)) {
    if (!detail['@type'].endsWith('QuotaFailure')) continue;
    const violation = detail.violations?.[0];
    if (!violation) continue;
    if (violation.quotaMetric) facts.quotaMetric = violation.quotaMetric.split('/').pop();
    if (violation.quotaValue) facts.quotaLimit = violation.quotaValue;
    if (violation.quotaDimensions?.model) facts.quotaModel = violation.quotaDimensions.model;
  }
  return facts;
}

function parseDetails(message: string): GoogleErrorDetail[] {
  const start = message.indexOf('{');
  if (start === -1) return [];
  try {
    const body = JSON.parse(message.slice(start)) as { error?: { details?: GoogleErrorDetail[] } };
    return body.error?.details ?? [];
  } catch {
    return [];
  }
}

/** `RetryInfo.retryDelay` llega como "27s" dentro del cuerpo JSON del error. */
export function retryDelaySeconds(message: string): number | null {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return match ? Math.ceil(Number(match[1])) : null;
}
