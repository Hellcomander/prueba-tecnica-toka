import { DEMO_USERS } from '@toka/contracts/seed';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS, SYSTEM_ROLES, type Permission } from '@toka/contracts/permissions';
import { Link } from 'react-router-dom';
import { useAuthStore } from '@/state/auth-store';
import { Skeleton } from '@/components/skeleton';

const quickLinks: { title: string; description: string; permission: Permission; icon: string }[] = [
  { title: 'Directorio de usuarios', description: 'Consulta y administra las cuentas de la plataforma.', permission: 'users:read', icon: '01' },
  { title: 'Roles y permisos', description: 'Define el acceso de cada perfil a los recursos.', permission: 'roles:read', icon: '02' },
  { title: 'Registro de auditoría', description: 'Revisa eventos de acceso y cambios del sistema.', permission: 'audit:read', icon: '03' },
  { title: 'Asistente IA', description: 'Consulta políticas internas con ayuda contextual.', permission: 'agent:use', icon: '04' },
];

export function DashboardPage() {
  const user = useAuthStore((state) => state.user);
  const hasPermission = useAuthStore((state) => state.hasPermission);
  const people = Object.values(DEMO_USERS);
  const roleCount = Object.keys(SYSTEM_ROLES).length;
  const permissionCount = PERMISSIONS.length;

  return (
    <div className="dashboard-page">
      <section className="welcome-row">
        <div>
          <p className="eyebrow">VISTA GENERAL</p>
          <h1>Hola, {user?.fullName.split(' ')[0]} <span className="wave">✳</span></h1>
          <p className="muted">Este es el estado de tu espacio de trabajo.</p>
        </div>
        <span className="date-chip">{new Intl.DateTimeFormat('es-MX', { dateStyle: 'long' }).format(new Date())}</span>
      </section>

      <section className="metrics-grid" aria-label="Resumen de la plataforma">
        <article className="metric-card metric-card-dark">
          <div className="metric-top"><span>CUENTAS DEMO</span><span className="metric-icon">↗</span></div>
          <strong>{people.length.toString().padStart(2, '0')}</strong>
          <span className="metric-note">perfiles de prueba</span>
          <div className="metric-decoration">U</div>
        </article>
        <article className="metric-card">
          <div className="metric-top"><span>ROLES DE SISTEMA</span><span className="metric-icon">◇</span></div>
          <strong>{roleCount.toString().padStart(2, '0')}</strong>
          <span className="metric-note">perfiles de acceso</span>
          <div className="metric-bar"><span style={{ width: '72%' }} /></div>
        </article>
        <article className="metric-card">
          <div className="metric-top"><span>PERMISOS</span><span className="metric-icon">⌘</span></div>
          <strong>{permissionCount.toString().padStart(2, '0')}</strong>
          <span className="metric-note">en el catálogo compartido</span>
          <div className="metric-bar metric-bar-violet"><span style={{ width: '56%' }} /></div>
        </article>
        <article className="metric-card metric-card-status">
          <div className="metric-top"><span>ESTADO</span><span className="status-dot" /></div>
          <strong className="status-label">En preparación</strong>
          <span className="metric-note">APIs pendientes de integración</span>
          <Skeleton className="metric-skeleton" label="Métricas reales pendientes" />
        </article>
      </section>

      <section className="dashboard-lower">
        <div className="panel quick-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">ACCESOS RÁPIDOS</p><h2>Tu espacio</h2></div>
            <span className="subtle-count">0{quickLinks.filter((link) => hasPermission(link.permission)).length}</span>
          </div>
          <div className="quick-links">
            {quickLinks.filter((link) => hasPermission(link.permission)).map((link) => (
              <Link className="quick-link" to={link.title === 'Directorio de usuarios' ? '/users' : link.title === 'Roles y permisos' ? '/roles' : link.title === 'Registro de auditoría' ? '/audit' : '/assistant'} key={link.title}>
                <span className="quick-number">{link.icon}</span>
                <span className="quick-link-copy"><strong>{link.title}</strong><small>{link.description}</small></span>
                <span className="quick-arrow">↗</span>
              </Link>
            ))}
          </div>
        </div>
        <div className="panel permissions-panel">
          <div className="panel-heading">
            <div><p className="eyebrow">TU PERFIL</p><h2>Permisos activos</h2></div>
            <span className="role-pill">{user?.roles[0]}</span>
          </div>
          <p className="permission-intro">Tu acceso se calcula desde el catálogo compartido de contratos.</p>
          <div className="permission-list">
            {(user?.permissions ?? []).slice(0, 5).map((permission) => (
              <div className="permission-row" key={permission}>
                <span className="permission-check">✓</span>
                <span><strong>{permission}</strong><small>{PERMISSION_DESCRIPTIONS[permission]}</small></span>
              </div>
            ))}
            {(user?.permissions.length ?? 0) > 5 && (
              <span className="more-permissions">+ {(user?.permissions.length ?? 0) - 5} permisos más</span>
            )}
          </div>
          <div className="permission-total"><span>CATÁLOGO DE SISTEMA</span><strong>{PERMISSIONS.length} permisos</strong></div>
        </div>
      </section>
    </div>
  );
}
