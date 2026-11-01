/** Nombre de la cookie de refresh. El prefijo `toka_` evita chocar con otras apps del mismo host. */
export const REFRESH_COOKIE = 'toka_refresh';

/** Flag `Secure` de la cookie: true en producción (https), false en el stack local sobre http. */
export const COOKIE_SECURE = Symbol('COOKIE_SECURE');

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'strict';
  secure: boolean;
  path: string;
  expires?: Date;
}

export interface HttpResponseLike {
  cookie(name: string, value: string, options: CookieOptions): void;
  clearCookie(name: string, options: Omit<CookieOptions, 'expires'>): void;
}

export interface HttpRequestLike {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
}

/**
 * La cookie de refresh es:
 *  - HttpOnly: ningún script la lee, así un XSS no se lleva la sesión larga;
 *  - SameSite=Strict: no viaja en requests de otro sitio, lo que cierra el CSRF sobre /refresh;
 *  - Secure cuando COOKIE_SECURE=true (en producción, sí; en el stack local sobre http, no, o el
 *    navegador la descartaría);
 *  - Path acotado a /api/v1/auth: solo se manda a los tres endpoints que la necesitan.
 * El access token, en cambio, NO va en cookie: viaja en el body y el cliente lo manda en el
 * header Authorization, que es inmune a CSRF por construcción.
 */
export const refreshCookieOptions = (secure: boolean): Omit<CookieOptions, 'expires'> => ({
  httpOnly: true,
  sameSite: 'strict',
  secure,
  path: '/api/v1/auth',
});

export function setRefreshCookie(res: HttpResponseLike, token: string, expiresAt: Date, secure: boolean): void {
  res.cookie(REFRESH_COOKIE, token, { ...refreshCookieOptions(secure), expires: expiresAt });
}

export function clearRefreshCookie(res: HttpResponseLike, secure: boolean): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(secure));
}

export const readRefreshCookie = (req: HttpRequestLike): string | null => req.cookies?.[REFRESH_COOKIE] ?? null;

/** Contexto del intento para los eventos de seguridad (la IP real la resuelve `trust proxy`). */
export function attemptContext(req: HttpRequestLike): { ip: string | null; userAgent: string | null } {
  const agent = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: (Array.isArray(agent) ? agent[0] : agent)?.slice(0, 300) ?? null,
  };
}
