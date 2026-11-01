import { API_MODE } from '@/config';
import { api, refreshSession } from '@/lib/api';
import { useAuthStore, type SessionUser } from './auth-store';

/**
 * El nombre del usuario no lo tiene auth-service: su dominio son las credenciales, y el perfil
 * es de user-service. La SPA lo pide aparte y tolera que falle, porque no poder saludar por el
 * nombre no es razón para dejar a alguien fuera de la aplicación.
 */
export async function loadProfile(): Promise<void> {
  try {
    const { data } = await api.get<{ fullName?: string }>('/users/me');
    if (data?.fullName) useAuthStore.getState().mergeProfile({ fullName: data.fullName });
  } catch {
    /* se sigue mostrando el correo */
  }
}

/** Arranca la sesión tras un login correcto y completa el perfil en segundo plano. */
export function startSession(user: SessionUser, accessToken: string): void {
  useAuthStore.getState().setSession(user, accessToken);
  if (API_MODE === 'real') void loadProfile();
}

/**
 * Restaura la sesión al abrir o recargar la SPA.
 *
 * El access token vive solo en memoria (decisión deliberada: un XSS no se lo lleva), así que un
 * reload lo pierde. Lo que sobrevive es la cookie de refresh, HttpOnly, y con ella se pide un
 * token nuevo. Sin este paso, recargar la página te devolvía al login con la sesión todavía
 * viva en el servidor.
 *
 * En modo demo no hay cookie ni servidor, así que no hay nada que restaurar.
 */
let restoring: Promise<void> | null = null;

export function restoreSession(): Promise<void> {
  // Una sola vez por carga de página: React StrictMode ejecuta los efectos dos veces en
  // desarrollo, y no tiene sentido rotar el refresh dos veces al abrir la aplicación.
  restoring ??= doRestore();
  return restoring;
}

async function doRestore(): Promise<void> {
  const store = useAuthStore.getState();
  if (API_MODE !== 'real') {
    store.finishRestoring();
    return;
  }
  try {
    const session = await refreshSession();
    if (!session.user) throw new Error('la respuesta de refresh no trae usuario');
    store.setSession(session.user, session.accessToken);
    void loadProfile();
  } catch {
    // Sin cookie válida: es el caso normal de la primera visita, no un error que reportar.
    store.clearSession();
  }
}
