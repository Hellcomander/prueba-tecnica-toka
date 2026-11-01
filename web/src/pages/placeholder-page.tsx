import { useLocation } from 'react-router-dom';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS } from '@toka/contracts/permissions';
import { PageSkeleton } from '@/components/skeleton';

const pages: Record<string, { eyebrow: string; title: string; description: string; permission: string }> = {
  '/users': { eyebrow: 'DIRECTORIO', title: 'Usuarios', description: 'Cuentas de usuario y perfiles de la plataforma.', permission: 'users:read' },
  '/roles': { eyebrow: 'CONTROL DE ACCESO', title: 'Roles y permisos', description: 'Roles, asignaciones y catálogo de permisos del sistema.', permission: 'roles:read' },
  '/audit': { eyebrow: 'TRAZABILIDAD', title: 'Auditoría', description: 'Registro de eventos de acceso, cambios e IA.', permission: 'audit:read' },
  '/assistant': { eyebrow: 'ASISTENTE', title: 'Asistente IA', description: 'Consulta la base de conocimiento y las herramientas autorizadas.', permission: 'agent:use' },
};

export function PlaceholderPage() {
  const { pathname } = useLocation();
  const page = pages[pathname] ?? pages['/users'];
  return (
    <div className="placeholder-page">
      <p className="eyebrow">{page.eyebrow}</p>
      <div className="placeholder-title-row"><div><h1>{page.title}</h1><p className="muted">{page.description}</p></div><span className="coming-badge">SIGUIENTE FASE</span></div>
      <div className="placeholder-panel">
        <div className="placeholder-message">
          <span className="placeholder-symbol">↗</span>
          <h2>La estructura ya está lista.</h2>
          <p>Esta pantalla se conectará a su servicio cuando la API esté disponible. La navegación y los permisos ya se leen desde <code>@toka/contracts</code>.</p>
        </div>
        <PageSkeleton />
      </div>
      <section className="catalog-panel">
        <div><p className="eyebrow">CONTRATO COMPARTIDO</p><h2>Permisos disponibles</h2></div>
        <div className="catalog-list">
          {PERMISSIONS.map((permission) => (
            <div key={permission}><code>{permission}</code><span>{PERMISSION_DESCRIPTIONS[permission]}</span></div>
          ))}
        </div>
        <p className="current-permission">Permiso requerido por esta sección: <code>{page.permission}</code></p>
      </section>
    </div>
  );
}
