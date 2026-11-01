import { createHash } from 'node:crypto';
import { DomainError } from './shared/domain-error';

const MIN_LENGTH = 3;
const MAX_LENGTH = 1_000;

/**
 * Value object de la pregunta. Valida por construcción y normaliza para la caché: dos preguntas
 * que solo difieren en espacios o mayúsculas deben compartir respuesta.
 *
 * El tope de longitud no es cosmético: el prompt entero se paga por token, y un texto enorme es
 * además el vehículo natural de una inyección larga.
 */
export class Question {
  private constructor(
    readonly text: string,
    readonly normalized: string,
  ) {}

  static of(raw: string): Question {
    const text = raw.trim().replace(/\s+/g, ' ');
    if (text.length < MIN_LENGTH) {
      throw new DomainError('QUESTION_TOO_SHORT', 'validation', `La pregunta debe tener al menos ${MIN_LENGTH} caracteres`);
    }
    if (text.length > MAX_LENGTH) {
      throw new DomainError('QUESTION_TOO_LONG', 'validation', `La pregunta no puede pasar de ${MAX_LENGTH} caracteres`);
    }
    return new Question(text, text.toLowerCase());
  }

  /** Identificador de la pregunta para caché y eventos: nunca se publica el texto en claro. */
  hash(): string {
    return createHash('sha256').update(this.normalized).digest('hex');
  }
}
