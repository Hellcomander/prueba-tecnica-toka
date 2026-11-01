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

/** `RetryInfo.retryDelay` llega como "27s" dentro del cuerpo JSON del error. */
export function retryDelaySeconds(message: string): number | null {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return match ? Math.ceil(Number(match[1])) : null;
}
