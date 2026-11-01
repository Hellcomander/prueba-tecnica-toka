import axios, {
  AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';
import { clearAccessToken, getAccessToken, setAccessToken } from '@/state/access-token';
import { useAuthStore } from '@/state/auth-store';
import type { ProblemDetails } from '@toka/contracts/http';

interface RetriableRequest extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

interface RefreshResponse {
  accessToken: string;
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
        refreshRequest ??= refreshClient
          .post<RefreshResponse>('/auth/refresh')
          .then(({ data }) => {
            setAccessToken(data.accessToken);
            return data.accessToken;
          })
          .finally(() => {
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

export const api = installAuthInterceptors(axios.create(requestConfig), axios.create(requestConfig));

export function problemMessage(error: unknown): string {
  if (axios.isAxiosError<ProblemDetails>(error)) {
    const problem = error.response?.data;
    if (problem?.detail) return problem.detail;
    if (problem?.title) return problem.title;
  }
  return 'Ocurrió un error inesperado. Intenta de nuevo.';
}
