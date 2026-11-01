import axios from 'axios';
import type { ProblemDetails } from '@toka/contracts/http';
import { problemMessage } from './api';

/**
 * Lectura del `code` estable de RFC 9457. El backend lo promete en todos sus errores y es el
 * único campo con el que vale la pena ramificar: el `title` y el `detail` son texto para el
 * usuario y pueden cambiar, el `status` no distingue entre dos 409 que piden acciones distintas.
 */
export function problemCode(error: unknown): string | null {
  if (!axios.isAxiosError<ProblemDetails>(error)) return null;
  return error.response?.data?.code ?? null;
}

export function problemDetails(error: unknown): ProblemDetails | null {
  if (!axios.isAxiosError<ProblemDetails>(error)) return null;
  return error.response?.data ?? null;
}

/**
 * Errores de validación por campo (solo en 400). Las claves del backend coinciden con los
 * nombres de los campos del formulario, así que se pueden montar directamente sobre
 * react-hook-form en vez de enseñar un "la solicitud tiene campos inválidos" que no dice dónde.
 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  const problem = problemDetails(error);
  const entries = Object.entries(problem?.fieldErrors ?? {});
  return Object.fromEntries(entries.map(([field, messages]) => [field, messages.join(' ')]));
}

/**
 * Los 409 que la interfaz debe tratar distinto. Para SELF_SUSPENSION, LAST_ADMIN y ROLE_IN_USE
 * el `detail` del servidor ya explica el caso mejor que cualquier texto genérico, así que se
 * respeta; VERSION_CONFLICT sí se reescribe, porque además del mensaje la pantalla recarga el
 * registro y hay que decirle a la persona qué pasó con lo que acababa de escribir.
 */
const CODE_MESSAGES: Record<string, string> = {
  VERSION_CONFLICT:
    'Alguien más modificó este registro mientras lo editabas. Se recargaron los datos actuales: revisa el resultado y vuelve a aplicar tu cambio si sigue haciendo falta.',
};

/** Mensaje para la persona: código conocido, si no el detalle del servidor con sus campos. */
export function describeProblem(error: unknown): string {
  const code = problemCode(error);
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];

  const base = problemMessage(error);
  const fields = Object.values(fieldErrorsOf(error));
  return fields.length > 0 ? `${base}: ${fields.join(' ')}` : base;
}

export const isVersionConflict = (error: unknown): boolean => problemCode(error) === 'VERSION_CONFLICT';

/**
 * Segundos de la cabecera `Retry-After` (RFC 9110). El backend la manda en los límites del
 * asistente y en las indisponibilidades; va en la cabecera y no en el cuerpo, que es donde la
 * espera cualquier cliente HTTP. Con este número la pantalla puede enseñar una cuenta regresiva
 * de verdad en vez de un "intenta más tarde" que no dice cuándo.
 */
export function retryAfterSeconds(error: unknown): number | null {
  if (!axios.isAxiosError(error)) return null;
  const raw = error.response?.headers?.['retry-after'];
  const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}
