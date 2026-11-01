/**
 * Validador de salida: lo último que se ejecuta antes de devolver una respuesta.
 *
 * Comprueba tres cosas, en orden de gravedad:
 *  1. **Fuga del canario.** Si el texto contiene la frase que solo está en el system prompt, el
 *     modelo lo está repitiendo: la respuesta se descarta entera, no se "limpia".
 *  2. **Secretos.** Patrones de API key, Bearer, URLs con contraseña y hashes argon2. Se redactan.
 *  3. **Citas.** Toda cita `[KB-n]` debe apuntar a un pasaje que de verdad se recuperó. Una cita
 *     a un número que no existe es una alucinación de la forma más detectable que hay.
 *
 * `passed` distingue **fallos** de **señales**. Fallan la validación la fuga del canario, una
 * cita inventada y un secreto redactado: las tres significan que la respuesta tal cual salió del
 * modelo no era publicable. `no_citations` no falla: se anota y se mide, pero una respuesta
 * legítima puede no citar nada —un rechazo ("no puedo compartir mis instrucciones"), un "no lo
 * sé" o un dato que vino de una herramienta—. Marcarla como no validada haría que la interfaz
 * desconfiara justo de las respuestas más prudentes.
 */

export type ValidationIssue = 'canary_leak' | 'secret_redacted' | 'invalid_citation' | 'no_citations';

export interface ValidationResult {
  passed: boolean;
  issues: ValidationIssue[];
  /** Texto saneado: con los secretos redactados y las citas inválidas eliminadas. */
  text: string;
  /** Índices de pasaje (base 1) realmente citados, en orden de aparición. */
  citedIndexes: number[];
}

const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\$argon2[a-z]{1,3}\$[^\s]+/gi,
  /\b(redis|postgres(?:ql)?|amqps?|mongodb):\/\/[^\s:]+:[^\s@]+@[^\s]+/gi,
];

const CITATION = /\[KB-(\d+)\]/g;

export interface OutputValidationInput {
  text: string;
  /** Cuántos pasajes se le dieron al modelo: las citas válidas van de 1 a este número. */
  passageCount: number;
  canary: string;
  /** Si la respuesta se apoya en la base de conocimiento, debería citar al menos una vez. */
  expectCitations: boolean;
}

export function validateOutput(input: OutputValidationInput): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (input.canary && input.text.includes(input.canary)) {
    return {
      passed: false,
      issues: ['canary_leak'],
      text: 'No puedo responder a eso. La solicitud intentó obtener las instrucciones internas del asistente.',
      citedIndexes: [],
    };
  }

  let text = input.text;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      issues.push('secret_redacted');
      text = text.replace(pattern, '[REDACTADO]');
    }
    pattern.lastIndex = 0;
  }

  const cited: number[] = [];
  let hadInvalid = false;
  text = text.replace(CITATION, (whole, raw: string) => {
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 1 || index > input.passageCount) {
      hadInvalid = true;
      return '';
    }
    if (!cited.includes(index)) cited.push(index);
    return whole;
  });
  if (hadInvalid) issues.push('invalid_citation');
  if (input.expectCitations && cited.length === 0) issues.push('no_citations');

  const failed = issues.some((issue) => issue !== 'no_citations');
  return { passed: !failed, issues, text: text.replace(/[ \t]{2,}/g, ' ').trim(), citedIndexes: cited };
}
