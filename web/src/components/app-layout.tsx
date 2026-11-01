import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import type { Permission } from '@toka/contracts/permissions';
import { API_MODE } from '@/config';
import { problemMessage } from '@/lib/api';
import { authApi } from '@/services/auth-api';
import { displayName, useAuthStore } from '@/state/auth-store';
import { useToast } from './toast-provider';

const navigation: { label: string; href: string; permission: Permission }[] = [
  { label: 'Resumen', href: '/', permission: 'users:read' },
  { label: 'Usuarios', href: '/users', permission: 'users:read' },
  { label: 'Roles y permisos', href: '/roles', permission: 'roles:read' },
  { label: 'Auditoría', href: '/audit', permission: 'audit:read' },
  { label: 'Asistente IA', href: '/assistant', permission: 'agent:use' },
];

export function AppLayout() {
  const user = useAuthStore((state) => state.user);
  const clearSession = useAuthStore((state) => state.clearSession);
  const navigate = useNavigate();
  const { showToast } = useToast();
  const permissions = new Set(user?.permissions ?? []);
  const name = displayName(user);

  async function signOut() {
    let message = 'Sesión cerrada.';
    let kind: 'success' | 'error' = 'success';
    if (API_MODE === 'real') {
      try {
        await authApi.logout();
      } catch (error) {
        message = `Se cerró la sesión local, pero no se pudo confirmar con el servidor: ${problemMessage(error)}`;
        kind = 'error';
      }
    }
    clearSession();
    showToast(message, kind);
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/" aria-label="Toka, inicio">
          <span className="brand-mark">t</span>
          <span>toka<span className="brand-dot">.</span></span>
        </Link>
        <p className="nav-caption">PLATAFORMA</p>
        <nav className="main-nav" aria-label="Navegación principal">
          {navigation.filter((item) => permissions.has(item.permission)).map((item) => (
            <NavLink key={item.href} to={item.href} end={item.href === '/'}>
              <span className="nav-indicator" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="avatar">{name.slice(0, 1).toUpperCase()}</div>
          <div className="user-identity">
            <strong>{name}</strong>
            <span>{user?.roles.join(', ')}</span>
          </div>
          <button type="button" className="icon-button" aria-label="Cerrar sesión" onClick={signOut}>↗</button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">ESPACIO DE TRABAJO</span>
            <strong>Administración</strong>
          </div>
          <span className="environment-badge">
            <span className="status-dot" />
            {API_MODE === 'real' ? 'Conectado' : 'Modo demo'}
          </span>
        </header>
        <div className="page-content"><Outlet /></div>
      </main>
    </div>
  );
}
