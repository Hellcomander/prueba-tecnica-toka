import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { PERMISSIONS, type Permission } from '@toka/contracts/permissions';
import { API_MODE } from '@/config';
import { DemoModeNotice, EmptyState } from '@/components/empty-state';
import { Modal } from '@/components/modal';
import { Skeleton } from '@/components/skeleton';
import { useToast } from '@/components/toast-provider';
import { applyServerErrors } from '@/lib/form-errors';
import { describeProblem, isVersionConflict } from '@/lib/problem';
import { rolesApi, type RoleView } from '@/services/roles-api';
import { useAuthStore } from '@/state/auth-store';
import { useRolesStore } from '@/state/roles-store';

type Dialog = { kind: 'create' } | { kind: 'edit'; role: RoleView } | { kind: 'delete'; role: RoleView } | null;

export function RolesPage() {
  const isReal = API_MODE === 'real';
  const canWrite = useAuthStore((state) => state.hasPermission('roles:write'));

  const status = useRolesStore((state) => state.status);
  const error = useRolesStore((state) => state.error);
  const roles = useRolesStore((state) => state.roles);
  const catalog = useRolesStore((state) => state.catalog);
  const load = useRolesStore((state) => state.load);

  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    if (isReal) void load();
  }, [isReal, load]);

  return (
    <div className="listing-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">CONTROL DE ACCESO</p>
          <h1>Roles y permisos</h1>
          <p className="muted">
            Cada rol agrupa permisos del catálogo compartido. Los roles de sistema son fijos: los servicios
            dependen de ellos.
          </p>
        </div>
        {canWrite && isReal && (
          <button type="button" className="button button-primary" onClick={() => setDialog({ kind: 'create' })}>
            Nuevo rol <span aria-hidden="true">+</span>
          </button>
        )}
      </header>

      {!isReal ? (
        <div className="panel panel-padded">
          <DemoModeNotice section="La administración de roles" />
        </div>
      ) : (
        <>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}

          {status === 'loading' && roles.length === 0 ? (
            <div className="role-grid">
              <Skeleton className="skeleton-card" label="Cargando roles" />
              <Skeleton className="skeleton-card" label="Cargando roles" />
              <Skeleton className="skeleton-card" label="Cargando roles" />
            </div>
          ) : roles.length === 0 && status === 'success' ? (
            <div className="panel panel-padded">
              <EmptyState title="No hay roles." description="Crea el primer rol para empezar a asignar permisos." />
            </div>
          ) : (
            <section className="role-grid" aria-label="Roles definidos">
              {roles.map((role) => (
                <article className="panel role-card" key={role.id}>
                  <div className="role-card-head">
                    <div>
                      <h2>{role.name}</h2>
                      <p className="muted">{role.description || 'Sin descripción.'}</p>
                    </div>
                    {role.isSystem && <span className="badge badge-system">SISTEMA</span>}
                  </div>
                  <div className="chip-row">
                    {role.permissions.map((permission) => (
                      <span className="chip" key={permission}>
                        {permission}
                      </span>
                    ))}
                  </div>
                  <div className="role-card-foot">
                    <span className="subtle-count">
                      {role.permissions.length} permiso(s) · v{role.version}
                    </span>
                    {/* Los roles de sistema no se editan ni se borran en el backend: no se ofrece
                        una acción que sabemos que terminará en 409 SYSTEM_ROLE_IMMUTABLE. */}
                    {canWrite && !role.isSystem && (
                      <div className="row-actions">
                        <button
                          type="button"
                          className="button button-ghost"
                          aria-label={`Editar el rol ${role.name}`}
                          onClick={() => setDialog({ kind: 'edit', role })}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="button button-ghost"
                          aria-label={`Eliminar el rol ${role.name}`}
                          onClick={() => setDialog({ kind: 'delete', role })}
                        >
                          Eliminar
                        </button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )}

          <section className="panel panel-padded catalog-section">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">CONTRATO COMPARTIDO</p>
                <h2>Catálogo de permisos</h2>
              </div>
              <span className="subtle-count">{catalog.length || PERMISSIONS.length}</span>
            </div>
            <div className="catalog-list">
              {catalog.map((permission) => (
                <div key={permission.code}>
                  <code>{permission.code}</code>
                  <span>{permission.description}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {dialog?.kind === 'create' && <RoleFormDialog onClose={() => setDialog(null)} onDone={load} />}
      {dialog?.kind === 'edit' && (
        <RoleFormDialog role={dialog.role} onClose={() => setDialog(null)} onDone={load} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteRoleDialog role={dialog.role} onClose={() => setDialog(null)} onDone={load} />
      )}
    </div>
  );
}

/* --------------------------------------------------------- alta y edición */

/**
 * Las mismas reglas que valida role-service: 3 a 31 caracteres, empieza por letra y solo
 * letras, números, `-` o `_`. El nombre del rol viaja en tokens y en políticas de otros
 * servicios, por eso no admite espacios ni acentos.
 */
const roleSchema = z.object({
  name: z
    .string()
    .min(3, 'El nombre debe tener entre 3 y 31 caracteres.')
    .max(31, 'El nombre debe tener entre 3 y 31 caracteres.')
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'Debe empezar con letra y solo admite letras, números, - y _.'),
  description: z.string().max(200, 'La descripción no puede pasar de 200 caracteres.'),
  permissions: z.array(z.enum(PERMISSIONS)).min(1, 'Selecciona al menos un permiso.'),
});

type RoleValues = z.infer<typeof roleSchema>;

function RoleFormDialog({
  role,
  onClose,
  onDone,
}: {
  role?: RoleView;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const catalog = useRolesStore((state) => state.catalog);
  const [current, setCurrent] = useState(role);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RoleValues>({
    resolver: zodResolver(roleSchema),
    defaultValues: {
      name: role?.name ?? '',
      description: role?.description ?? '',
      permissions: role?.permissions ?? [],
    },
  });

  const editing = Boolean(current);
  const options: { code: Permission; description: string }[] =
    catalog.length > 0 ? catalog : PERMISSIONS.map((code) => ({ code, description: code }));

  async function submit(values: RoleValues) {
    setFormError(null);
    try {
      if (current) {
        await rolesApi.update(current.id, {
          name: values.name,
          description: values.description,
          permissions: values.permissions,
          version: current.version,
        });
        showToast(`Rol ${values.name} actualizado.`, 'success');
      } else {
        await rolesApi.create({
          name: values.name,
          description: values.description || undefined,
          permissions: values.permissions,
        });
        showToast(`Rol ${values.name} creado.`, 'success');
      }
      onClose();
      await onDone();
    } catch (error) {
      if (isVersionConflict(error) && current) {
        // Mismo bloqueo optimista que en usuarios: se recarga el rol y se rehace el formulario
        // con lo que hay hoy en el servidor, para no sobrescribir el cambio de alguien más.
        setFormError(describeProblem(error));
        showToast(describeProblem(error), 'error');
        const fresh = (await rolesApi.list().catch(() => [])).find((item) => item.id === current.id);
        if (fresh) {
          setCurrent(fresh);
          reset({ name: fresh.name, description: fresh.description, permissions: fresh.permissions });
        }
        await onDone();
        return;
      }
      applyServerErrors(error, setError, ['name', 'description', 'permissions'], setFormError);
    }
  }

  return (
    <Modal
      title={editing ? `Editar el rol ${current?.name}` : 'Nuevo rol'}
      description="El nombre admite letras, números, - y _, empieza por letra y mide entre 3 y 31 caracteres."
      onClose={onClose}
    >
      <form className="dialog-form" onSubmit={handleSubmit(submit)} noValidate>
        <div className="field">
          <label htmlFor="role-name">Nombre</label>
          <input id="role-name" type="text" autoComplete="off" {...register('name')} />
          {errors.name && <span className="field-error">{errors.name.message}</span>}
        </div>
        <div className="field">
          <label htmlFor="role-description">Descripción</label>
          <input id="role-description" type="text" {...register('description')} />
          {errors.description && <span className="field-error">{errors.description.message}</span>}
        </div>
        <fieldset className="checkbox-grid">
          <legend>Permisos</legend>
          {options.map((permission) => (
            <label className="checkbox-item" key={permission.code}>
              <input type="checkbox" value={permission.code} {...register('permissions')} />
              <span>
                <strong>{permission.code}</strong>
                <small>{permission.description}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {errors.permissions && <span className="field-error">{errors.permissions.message}</span>}
        {editing && <p className="field-hint">Versión {current?.version} · se envía para detectar cambios concurrentes.</p>}
        {formError && (
          <div className="form-error" role="alert">
            {formError}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="button button-primary" disabled={isSubmitting}>
            {isSubmitting ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear rol'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ----------------------------------------------------------------- borrado */

function DeleteRoleDialog({
  role,
  onClose,
  onDone,
}: {
  role: RoleView;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    setFormError(null);
    try {
      await rolesApi.remove(role.id);
      showToast(`Rol ${role.name} eliminado.`, 'success');
      onClose();
      await onDone();
    } catch (error) {
      // ROLE_IN_USE: el rol todavía tiene usuarios asignados y la base de datos lo impide. El
      // detalle del servidor dice cuántos son, que es justo lo que hace falta para resolverlo.
      setFormError(describeProblem(error));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Eliminar el rol ${role.name}`}
      description="Esta acción no se puede deshacer. Un rol con usuarios asignados no se puede eliminar: primero hay que reasignarlos."
      onClose={onClose}
    >
      <div className="dialog-form">
        {formError && (
          <div className="form-error" role="alert">
            {formError}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="button button-danger" onClick={() => void remove()} disabled={busy}>
            {busy ? 'Eliminando…' : 'Eliminar rol'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
