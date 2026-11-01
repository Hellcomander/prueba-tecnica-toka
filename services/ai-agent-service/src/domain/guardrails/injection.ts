/**
 * Detector heurístico de inyección de prompt.
 *
 * Qué es y qué no es: esto **no** bloquea la pregunta ni pretende ser una defensa completa —no
 * existe un detector perfecto y prometerlo sería peor que no tenerlo—. Es una señal que se marca
 * en `flags`, se registra y se muestra en la interfaz. La defensa real es estructural y está en
 * otra parte: el contexto recuperado viaja delimitado y declarado como datos, las tools son de
 * solo lectura, cada tool exige el permiso del usuario y el servicio destino vuelve a autorizar.
 * Aun si el modelo "obedeciera" a un texto inyectado, no podría hacer nada que el usuario no
 * pudiera hacer por sí mismo.
 *
 * Se revisa tanto la pregunta del usuario como **los pasajes recuperados**: la inyección
 * indirecta —texto malicioso dentro de un documento de la base de conocimiento— es el vector que
 * de verdad importa en un sistema RAG.
 */

export type InjectionTarget = 'question' | 'context';

export interface InjectionSignal {
  rule: string;
  target: InjectionTarget;
  excerpt: string;
}

interface Rule {
  name: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { name: 'override_instructions', pattern: /\b(ignora|olvida|descarta)\b[^.\n]{0,40}\b(instrucciones|reglas|lo anterior|system prompt|contexto)\b/i },
  { name: 'override_instructions_en', pattern: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|above|prior|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?)\b/i },
  { name: 'role_hijack', pattern: /\b(ahora|a partir de ahora|desde ahora)\b[^.\n]{0,30}\b(eres|actúa como|compórtate como)\b/i },
  { name: 'role_hijack_en', pattern: /\b(you are now|act as|pretend to be|from now on you)\b/i },
  { name: 'system_prompt_exfiltration', pattern: /\b(revela|muestra|imprime|repite|dime)\b[^.\n]{0,40}\b(system prompt|instrucciones del sistema|tus instrucciones|tu prompt)\b/i },
  { name: 'system_prompt_exfiltration_en', pattern: /\b(reveal|show|print|repeat|output)\b[^.\n]{0,40}\b(system prompt|your instructions|initial prompt)\b/i },
  { name: 'canary_probe', pattern: /\b(canary|palabra clave secreta|secret token)\b/i },
  { name: 'privilege_escalation', pattern: /\b(como|siendo)\s+(administrador|admin|root)\b[^.\n]{0,30}\b(dame|muéstrame|entrégame)\b/i },
  { name: 'fake_system_turn', pattern: /^\s*(system|sistema|assistant|asistente)\s*:/im },
  { name: 'delimiter_escape', pattern: /(<\/?(?:contexto|context|system|instrucciones)>|\[\/?(?:INST|SYSTEM)\])/i },
];

const MAX_EXCERPT = 120;

function scan(text: string, target: InjectionTarget): InjectionSignal[] {
  const signals: InjectionSignal[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) signals.push({ rule: rule.name, target, excerpt: match[0].slice(0, MAX_EXCERPT) });
  }
  return signals;
}

export function detectInjection(input: { question: string; passages?: readonly string[] }): InjectionSignal[] {
  const signals = scan(input.question, 'question');
  for (const passage of input.passages ?? []) signals.push(...scan(passage, 'context'));
  return signals;
}
