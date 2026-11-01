import axios, {
  AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';
import { clearAccessToken, getAccessToken, setAccessToken } from '@/state/access-token';
import { useAuthStore, type SessionUser } from '@/state/auth-store';
import type { ProblemDetails } from '@toka/contracts/http';

interface RetriableRequest extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

/** Lo que devuelven `/auth/login` y `/auth/refresh`. `user` no trae nombre: auth no lo guarda. */
export interface SessionPayload {
  accessToken: string;
  tokenType?: string;
  expiresIn?: number;
  user?: SessionUser;
}

const REFRESH_LOCK = 'toka-refresh';

/**
 * Serializa el refresh ENTRE PESTAÑAS, no solo dentro de una.
 *
 * Sin esto, dos pestañas que reciben 401 a la vez presentan la misma cookie: auth rota la
 * primera y lee la segunda como reúso de un token robado, así que revoca la familia entera
 * y cierra la sesión en ambas. El usuario no hizo nada malo y el log dice "refresh reuse".
 *
 * Donde no existe la Web Locks API (jsdom, navegadores viejos) se degrada al candado por
 * pestaña, que es mejor que nada y es el comportamiento que ya había.
 */
function withRefreshLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return typeof locks?.request === 'function' ? (locks.request(REFRESH_LOCK, run) as Promise<T>) : run();
}

export function installAuthInterceptors(client: AxiosInstance, refreshClient: AxiosInstance): AxiosInstance {
  let refreshRequest: Promise<string> | null = null;

  client.interceptors.request.use((config) => {
    const token = getAccessToken();
    if (token) config.headers.set('Authorization', `Bearer ${token}`);
    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    async (error: AxiosError<ProblemDetails>) => {
      const request = error.config as RetriableRequest | undefined;
      const isAuthEndpoint = request?.url?.includes('/auth/login') || request?.url?.includes('/auth/refresh');

      if (error.response?.status !== 401 || !request || request._retry || isAuthEndpoint) {
        return Promise.reject(error);
      }

      request._retry = true;
      try {
        refreshRequest ??= withRefreshLock(() =>
          refreshClient.post<SessionPayload>('/auth/refresh').then(({ data }) => {
            setAccessToken(data.accessToken);
            return data.accessToken;
          }),
        ).finally(() => {
          refreshRequest = null;
        });

        const token = await refreshRequest;
        request.headers.set('Authorization', `Bearer ${token}`);
        return client(request);
      } catch (refreshError) {
        clearAccessToken();
        useAuthStore.getState().clearSession();
        return Promise.reject(refreshError);
      }
    },
  );
  return client;
}

const requestConfig = {
  baseURL: '/api/v1',
  withCredentials: true,
  headers: { Accept: 'application/json, application/problem+json' },
};

const refreshClient = axios.create(requestConfig);
export const api = installAuthInterceptors(axios.create(requestConfig), refreshClient);

/**
 * Refresco explícito, para restaurar la sesión al abrir la SPA: el access token vive solo en
 * memoria (a propósito, por XSS), pero la cookie de refresh sobrevive al reload. Comparte el
 * mismo candado entre pestañas que el interceptor.
 */
export const refreshSession = (): Promise<SessionPayload> =>
  withRefreshLock(() =>
    refreshClient.post<SessionPayload>('/auth/refresh').then(({ data }) => {
      setAccessToken(data.accessToken);
      return data;
    }),
  );

export function problemMessage(error: unknown): string {
  if (axios.isAxiosError<ProblemDetails>(error)) {
    const problem = error.response?.data;
    if (problem?.detail) return problem.detail;
    if (problem?.title) return problem.title;
  }
  return 'Ocurrió un error inesperado. Intenta de nuevo.';
}
