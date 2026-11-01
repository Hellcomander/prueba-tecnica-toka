import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { describeProblem, fieldErrorsOf } from './problem';

/**
 * Coloca los errores de validación del servidor sobre los campos del formulario.
 *
 * El 400 del backend trae `fieldErrors` con las mismas claves que los campos, así que se puede
 * señalar el campo culpable en vez de enseñar "la solicitud tiene campos inválidos" arriba del
 * todo. La validación del cliente existe para responder al instante, pero la del servidor es la
 * que manda: si llega algo que el cliente dejó pasar, se ve donde corresponde.
 *
 * `allowed` evita que un campo desconocido del servidor se pierda en silencio: lo que no
 * corresponde a un campo del formulario cae al mensaje general.
 */
export function applyServerErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  allowed: readonly Path<T>[],
  onGeneralError: (message: string) => void,
): void {
  const entries = Object.entries(fieldErrorsOf(error)).filter(([name]) =>
    (allowed as readonly string[]).includes(name),
  );
  if (entries.length === 0) {
    onGeneralError(describeProblem(error));
    return;
  }
  for (const [name, message] of entries) {
    setError(name as Path<T>, { type: 'server', message });
  }
}
