import { clearAccessToken, getAccessToken } from './access-token';
import { useAuthStore, type SessionUser } from './auth-store';

const user: SessionUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'admin@toka.local',
  fullName: 'Ana Admin',
  roles: ['admin'],
  permissions: ['users:read', 'audit:read'],
};

describe('auth store', () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
    clearAccessToken();
  });

  it('starts without an authenticated session', () => {
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().status).toBe('idle');
  });

  it('exposes loading and error request states', () => {
    useAuthStore.getState().setError('Fallo');
    useAuthStore.getState().setLoading();
    expect(useAuthStore.getState().status).toBe('loading');
    expect(useAuthStore.getState().error).toBeNull();
    useAuthStore.getState().setError('No autorizado');
    expect(useAuthStore.getState().status).toBe('error');
    expect(useAuthStore.getState().error).toBe('No autorizado');
  });

  it('stores the access token in memory and checks permissions from the session', () => {
    useAuthStore.getState().setSession(user, 'access-token');
    expect(getAccessToken()).toBe('access-token');
    expect(useAuthStore.getState().hasPermission('audit:read')).toBe(true);
    expect(useAuthStore.getState().hasPermission('roles:write')).toBe(false);
  });

  it('clears user and access token on logout', () => {
    useAuthStore.getState().setSession(user, 'access-token');
    useAuthStore.getState().clearSession();
    expect(useAuthStore.getState().user).toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});
