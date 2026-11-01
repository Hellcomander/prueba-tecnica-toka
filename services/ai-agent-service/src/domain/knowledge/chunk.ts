/**
 * Trocear la base de conocimiento para RAG. La unidad no es "N caracteres" sino **la sección**:
 * se corta por encabezados H2/H3 porque un apartado de una política es una idea completa, y una
 * cita que apunta a media frase no se puede verificar. Solo cuando una sección excede el tamaño
 * máximo se parte en ventanas con traslape, y se parte por párrafos antes que por caracteres.
 */

export interface KnowledgeDocument {
  /** Identificador estable del documento: el nombre de archivo sin extensión. */
  docId: string;
  title: string;
  /** Permiso necesario para que un pasaje de este documento se pueda recuperar (ACL). */
  requiredPermission: string | null;
  body: string;
}

export interface Chunk {
  /** `${docId}#${índice}`: estable mientras el documento no cambie de estructura. */
  id: string;
  docId: string;
  title: string;
  /** Encabezado de la sección, para que la cita diga de dónde salió. */
  section: string;
  requiredPermission: string | null;
  text: string;
}

export interface ChunkingOptions {
  maxChars: number;
  overlapChars: number;
}

export const DEFAULT_CHUNKING: ChunkingOptions = { maxChars: 1_000, overlapChars: 150 };

const HEADING = /^(#{2,3})\s+(.+)$/;

interface Section {
  heading: string;
  lines: string[];
}

/** Separa el front-matter YAML simple (`clave: valor`) del cuerpo markdown. */
export function parseFrontMatter(raw: string): { attributes: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { attributes: {}, body: normalized.trim() };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { attributes: {}, body: normalized.trim() };
  const attributes: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) attributes[key] = value.replace(/^["']|["']$/g, '');
  }
  return { attributes, body: normalized.slice(end + 4).trim() };
}

function splitIntoSections(body: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: '', lines: [] };
  for (const line of body.split('\n')) {
    const match = HEADING.exec(line);
    if (match) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      current = { heading: match[2].trim(), lines: [] };
      continue;
    }
    if (line.startsWith('# ')) continue; // el H1 es el título del documento
    current.lines.push(line);
  }
  if (current.lines.some((l) => l.trim())) sections.push(current);
  return sections;
}

/**
 * Parte un texto largo en ventanas de `maxChars` con `overlapChars` de traslape, cortando en el
 * límite de párrafo más cercano. El traslape existe para que una frase que cae justo en la
 * frontera siga siendo recuperable desde cualquiera de los dos lados.
 */
function windows(text: string, { maxChars, overlapChars }: ChunkingOptions): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(start + maxChars, text.length);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const breakAt = Math.max(text.lastIndexOf('\n\n', hardEnd), text.lastIndexOf('. ', hardEnd));
      if (breakAt > start + maxChars / 2) end = breakAt + 1;
    }
    parts.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return parts.filter((p) => p.length > 0);
}

export function chunkDocument(doc: KnowledgeDocument, options: ChunkingOptions = DEFAULT_CHUNKING): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of splitIntoSections(doc.body)) {
    const text = section.lines.join('\n').trim();
    if (!text) continue;
    for (const part of windows(text, options)) {
      chunks.push({
        id: `${doc.docId}#${chunks.length}`,
        docId: doc.docId,
        title: doc.title,
        section: section.heading || doc.title,
        requiredPermission: doc.requiredPermission,
        // El encabezado viaja dentro del texto embebido: "quién puede suspender" y el cuerpo de
        // la sección se buscan mejor juntos que por separado.
        text: section.heading ? `${section.heading}\n${part}` : part,
      });
    }
  }
  return chunks;
}
