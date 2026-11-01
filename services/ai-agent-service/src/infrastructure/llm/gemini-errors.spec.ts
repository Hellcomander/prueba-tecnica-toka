import { retryDelaySeconds, translateGeminiError } from './gemini-errors';

/**
 * Fixtures con la forma real que documenta Google para `RESOURCE_EXHAUSTED`. El spike de F0 no
 * consiguió provocar un 429 con 30 llamadas concurrentes y no se gastó más cuota en forzarlo
 * (docs/spikes.md), así que la forma se cubre aquí en vez de depender de que el proveedor falle.
 */
const QUOTA_ERROR = Object.assign(new Error(JSON.stringify({
  error: {
    code: 429,
    message: 'You exceeded your current quota',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generate_requests_per_model_per_day' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '27s' },
    ],
  },
})), { status: 429 });

describe('traducción de errores de Gemini', () => {
  it('un 429 se convierte en una espera concreta tomada de RetryInfo', () => {
    const error = translateGeminiError(QUOTA_ERROR, 'gemini-3.5-flash');
    expect(error.code).toBe('AI_PROVIDER_RATE_LIMITED');
    expect(error.kind).toBe('unprocessable');
    expect(error.retryAfterSeconds).toBe(27);
  });

  it('un 429 sin RetryInfo usa una espera conservadora en vez de reintentar a ciegas', () => {
    const error = translateGeminiError(Object.assign(new Error('quota exceeded'), { status: 429 }), 'm');
    expect(error.retryAfterSeconds).toBe(60);
  });

  it('un modelo retirado se distingue de una caída: pasó de verdad en el spike', () => {
    const error = translateGeminiError(Object.assign(new Error('not found'), { status: 404 }), 'gemini-2.5-flash');
    expect(error.code).toBe('AI_MODEL_NOT_AVAILABLE');
    expect(error.message).toContain('gemini-2.5-flash');
  });

  it('un plazo vencido se reconoce por estado o por mensaje', () => {
    expect(translateGeminiError(Object.assign(new Error('x'), { status: 504 }), 'm').code).toBe('AI_PROVIDER_TIMEOUT');
    expect(translateGeminiError(new Error('The operation was aborted due to timeout'), 'm').code).toBe('AI_PROVIDER_TIMEOUT');
  });

  it('cualquier otra cosa es una indisponibilidad genérica, nunca un 500 sin explicar', () => {
    const error = translateGeminiError(Object.assign(new Error('boom'), { status: 500 }), 'm');
    expect(error.code).toBe('AI_PROVIDER_ERROR');
    expect(error.kind).toBe('unavailable');
  });

  it('retryDelaySeconds redondea hacia arriba y devuelve null si no viene', () => {
    expect(retryDelaySeconds('{"retryDelay":"1.2s"}')).toBe(2);
    expect(retryDelaySeconds('sin nada')).toBeNull();
  });
});
