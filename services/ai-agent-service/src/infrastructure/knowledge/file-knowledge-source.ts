import { Inject, Injectable } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Chunk, chunkDocument, parseFrontMatter } from '../../domain/knowledge/chunk';
import type { KnowledgeSource } from '../../domain/ports';
import { ENV, type Env } from '../config/env';

/**
 * La base de conocimiento son archivos markdown **versionados en el repositorio**, no filas en
 * una base de datos. Así un cambio de política se revisa en un pull request, se ve en el
 * historial y se despliega con el resto del código; y así el evaluador puede leer exactamente lo
 * que el agente sabe sin levantar nada.
 *
 * El front-matter declara el permiso necesario para ver el documento (`requiredPermission`), que
 * es lo que alimenta el ACL del store vectorial.
 */
@Injectable()
export class FileKnowledgeSource implements KnowledgeSource {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async load(): Promise<Chunk[]> {
    const dir = this.env.KNOWLEDGE_BASE_DIR;
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    const chunks: Chunk[] = [];
    for (const file of files) {
      const raw = await readFile(join(dir, file), 'utf8');
      const { attributes, body } = parseFrontMatter(raw);
      const docId = file.replace(/\.md$/, '');
      chunks.push(
        ...chunkDocument({
          docId,
          title: attributes.title ?? titleFrom(body) ?? docId,
          requiredPermission: attributes.requiredPermission && attributes.requiredPermission !== 'none' ? attributes.requiredPermission : null,
          body,
        }),
      );
    }
    return chunks;
  }
}

function titleFrom(body: string): string | null {
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : null;
}
