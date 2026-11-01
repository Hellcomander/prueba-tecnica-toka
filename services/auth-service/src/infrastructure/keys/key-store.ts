import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { calculateJwkThumbprint, createLocalJWKSet, exportJWK, generateKeyPair, importJWK, type JWK, type JWTVerifyGetKey, type KeyLike } from 'jose';

export interface SigningKey {
  privateKey: KeyLike;
  publicJwk: JWK;
  kid: string;
}

const KEY_FILE = 'signing-key.json';
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/**
 * Par RS256 persistido en un volumen. Si no existe se genera al arrancar; si existe se reutiliza,
 * porque regenerarlo en cada arranque invalidaría todos los tokens vivos de todos los servicios.
 *
 * La escritura usa el flag 'wx' (falla si el archivo ya existe): es una operación atómica del
 * sistema de archivos, así que si dos réplicas arrancan a la vez, una gana y la otra lee la llave
 * de la ganadora en lugar de pisarla. Sin eso, la segunda dejaría firmando con una llave que
 * nadie más conoce.
 *
 * El `kid` es el thumbprint RFC 7638 de la llave pública: es estable, derivado del material, y
 * no hace falta coordinarlo con nadie.
 */
export class FileKeyStore {
  private loading?: Promise<SigningKey>;
  private resolver?: Promise<JWTVerifyGetKey>;

  constructor(private readonly directory: string) {}

  load(): Promise<SigningKey> {
    this.loading ??= this.loadOnce();
    return this.loading;
  }

  /** Documento JWKS tal como lo publica el endpoint (solo llaves públicas). */
  async jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    const { keys } = await this.publicJwks();
    return { keys: keys as unknown as Record<string, unknown>[] };
  }

  private async publicJwks(): Promise<{ keys: JWK[] }> {
    const key = await this.load();
    return { keys: [key.publicJwk] };
  }

  /**
   * Resolver local para que auth valide sus propios access tokens (userinfo, /api/v1/accounts)
   * sin pegarle por HTTP a su propio JWKS.
   */
  verificationKeyResolver(): JWTVerifyGetKey {
    return async (protectedHeader, token) => {
      this.resolver ??= this.publicJwks().then((jwks) => createLocalJWKSet(jwks));
      return (await this.resolver)(protectedHeader, token);
    };
  }

  private async loadOnce(): Promise<SigningKey> {
    const file = join(this.directory, KEY_FILE);
    const existing = await this.read(file);
    if (existing) return this.fromJwk(existing);

    const { privateKey } = await generateKeyPair('RS256', { extractable: true, modulusLength: 2048 });
    const jwk = await exportJWK(privateKey);
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(file, JSON.stringify(jwk), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      // Otro arranque ganó la carrera: su llave es la buena.
      const winner = await this.read(file);
      if (winner) return this.fromJwk(winner);
      throw error;
    }
    return this.fromJwk(jwk);
  }

  private async read(file: string): Promise<JWK | null> {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as JWK;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  private async fromJwk(jwk: JWK): Promise<SigningKey> {
    const privateKey = (await importJWK({ ...jwk, alg: 'RS256' }, 'RS256')) as KeyLike;
    // Solo los campos públicos: el JWKS jamás debe llevar d, p, q, dp, dq ni qi.
    const publicJwk: JWK = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' };
    const kid = await calculateJwkThumbprint(publicJwk, 'sha256');
    return { privateKey, publicJwk: { ...publicJwk, kid }, kid };
  }
}
