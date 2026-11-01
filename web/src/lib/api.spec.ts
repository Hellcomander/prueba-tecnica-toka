import axios, { AxiosError, type AxiosAdapter, type AxiosResponse } from 'axios';
import { clearAccessToken, getAccessToken } from '@/state/access-token';
import { useAuthStore, type SessionUser } from '@/state/auth-store';
import { installAuthInterceptors } from './api';

const sessionUser: SessionUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'admin@toka.local',
  fullName: 'Ana Admin',
  roles: ['admin'],
  permissions: ['users:read'],
};

function response<T>(config: Parameters<AxiosAdapter>[0], data: T, status: number): AxiosResponse<T> {
  return { config, data, status, statusText: status === 200 ? 'OK' : 'Unauthorized', headers: {}, request: {} };
}

function unauthorized(config: Parameters<AxiosAdapter>[0]) {
  return new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, response(config, {}, 401));
}

describe('refresh interceptor', () => {
  beforeEach(() => {
    clearAccessToken();
    useAuthStore.getState().clearSession();
  });

  it('comparte una sola petición de refresh entre respuestas 401 concurrentes', async () => {
    const client = axios.create();
    const refresh = axios.create();
    let refreshCalls = 0;
    client.defaults.adapter = async (config) => {
      if (!String(config.headers.get('Authorization') ?? '').startsWith('Bearer ')) throw unauthorized(config);
      return response(config, { ok: true }, 200);
    };
    refresh.defaults.adapter = async (config) => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return response(config, { accessToken: 'renewed' }, 200);
    };
    const api = installAuthInterceptors(client, refresh);

    const [first, second] = await Promise.all([api.get('/first'), api.get('/second')]);
    expect(first.data).toEqual({ ok: true });
    expect(second.data).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
    expect(getAccessToken()).toBe('renewed');
  });

  it('pide el candado de la Web Locks API para serializar el refresh entre pestañas', async () => {
    // Sin este candado, dos pestañas presentan la misma cookie: auth rota la primera y lee la
    // segunda como reúso de un token robado, revoca la familia y cierra ambas sesiones.
    const acquired: string[] = [];
    const locks = { request: jest.fn(async (name: string, run: () => Promise<unknown>) => { acquired.push(name); return run(); }) };
    Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });

    const client = axios.create();
    const refresh = axios.create();
    client.defaults.adapter = async (config) => {
      if (!String(config.headers.get('Authorization') ?? '').startsWith('Bearer ')) throw unauthorized(config);
      return response(config, { ok: true }, 200);
    };
    refresh.defaults.adapter = async (config) => response(config, { accessToken: 'renewed' }, 200);

    await installAuthInterceptors(client, refresh).get('/private');

    expect(acquired).toEqual(['toka-refresh']);
    expect(getAccessToken()).toBe('renewed');
    Reflect.deleteProperty(globalThis.navigator, 'locks');
  });

  it('sigue funcionando donde no existe la Web Locks API', async () => {
    expect((globalThis.navigator as Navigator & { locks?: unknown }).locks).toBeUndefined();
    const client = axios.create();
    const refresh = axios.create();
    client.defaults.adapter = async (config) => {
      if (!String(config.headers.get('Authorization') ?? '').startsWith('Bearer ')) throw unauthorized(config);
      return response(config, { ok: true }, 200);
    };
    refresh.defaults.adapter = async (config) => response(config, { accessToken: 'renewed' }, 200);

    const result = await installAuthInterceptors(client, refresh).get('/private');
    expect(result.data).toEqual({ ok: true });
  });

  it('limpia la sesión y propaga el error si refresh falla', async () => {
    useAuthStore.getState().setSession(sessionUser, 'expired');
    const client = axios.create();
    const refresh = axios.create();
    client.defaults.adapter = async (config) => { throw unauthorized(config); };
    refresh.defaults.adapter = async (config) => { throw unauthorized(config); };
    const api = installAuthInterceptors(client, refresh);

    await expect(api.get('/private')).rejects.toBeInstanceOf(AxiosError);
    expect(useAuthStore.getState().user).toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});
