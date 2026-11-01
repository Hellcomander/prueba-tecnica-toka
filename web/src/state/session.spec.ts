import type { SessionUser } from './auth-store';

const backendUser: SessionUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'ana.admin@toka.local',
  roles: ['admin'],
  permissions: ['users:read'],
};

// auth-service no guarda el perfil, así que /auth/refresh no trae fullName; el nombre llega
// después desde user-service. Estos dobles reproducen ese reparto.
const refreshSession = jest.fn();
const apiGet = jest.fn();

jest.mock('@/config', () => ({ API_MODE: 'real' }));
jest.mock('@/lib/api', () => ({
  refreshSession: (...args: unknown[]) => refreshSession(...args),
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));

/**
 * session.ts memoriza el intento de restauración (una vez por carga de página), así que cada
 * caso necesita un registro de módulos limpio. El store y el token se importan DENTRO del
 * mismo registro: si no, el test miraría una instancia distinta de la que usa session.ts.
 */
async function loadFresh() {
  let session!: typeof import('./session');
  let store!: typeof import('./auth-store');
  let token!: typeof import('./access-token');
  await jest.isolateModulesAsync(async () => {
    session = await import('./session');
    store = await import('./auth-store');
    token = await import('./access-token');
  });
  return { session, auth: store.useAuthStore, displayName: store.displayName, getAccessToken: token.getAccessToken };
}

describe('restauración de sesión al recargar', () => {
  beforeEach(() => {
    refreshSession.mockReset();
    apiGet.mockReset();
  });

  it('recupera la sesión con la cookie de refresh y completa el perfil desde user-service', async () => {
    refreshSession.mockResolvedValue({ accessToken: 'renovado', user: backendUser });
    apiGet.mockResolvedValue({ data: { fullName: 'Ana Admin' } });

    const { session, auth, getAccessToken } = await loadFresh();
    await session.restoreSession();

    expect(auth.getState().user?.id).toBe(backendUser.id);
    expect(auth.getState().restoring).toBe(false);
    expect(getAccessToken()).toBe('renovado');

    await Promise.resolve();
    expect(apiGet).toHaveBeenCalledWith('/users/me');
    expect(auth.getState().user?.fullName).toBe('Ana Admin');
  });

  it('sin cookie válida deja la sesión vacía y deja de restaurar, sin tratarlo como error', async () => {
    refreshSession.mockRejectedValue(new Error('401'));

    const { session, auth } = await loadFresh();
    await session.restoreSession();

    expect(auth.getState().user).toBeNull();
    expect(auth.getState().restoring).toBe(false);
    expect(auth.getState().error).toBeNull();
  });

  it('no rota el refresh dos veces aunque se invoque dos veces (StrictMode)', async () => {
    refreshSession.mockResolvedValue({ accessToken: 'renovado', user: backendUser });
    apiGet.mockResolvedValue({ data: {} });

    const { session } = await loadFresh();
    await Promise.all([session.restoreSession(), session.restoreSession()]);

    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('si user-service no responde, la sesión sigue en pie y se muestra el correo', async () => {
    refreshSession.mockResolvedValue({ accessToken: 'renovado', user: backendUser });
    apiGet.mockRejectedValue(new Error('503'));

    const { session, auth, displayName } = await loadFresh();
    await session.restoreSession();
    await Promise.resolve();

    expect(auth.getState().user?.id).toBe(backendUser.id);
    expect(displayName(auth.getState().user)).toBe('ana.admin');
  });
});
