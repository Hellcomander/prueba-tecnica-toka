import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { API_MODE } from '@/config';
import { DemoModeNotice, EmptyState } from '@/components/empty-state';
import { Modal } from '@/components/modal';
import { Skeleton } from '@/components/skeleton';
import { useToast } from '@/components/toast-provider';
import { applyServerErrors } from '@/lib/form-errors';
import { formatDateTime } from '@/lib/format';
import { describeProblem, isVersionConflict } from '@/lib/problem';
import { rolesApi, type RoleView } from '@/services/roles-api';
import { usersApi, type UserStatus, type UserView } from '@/services/users-api';
import { useAuthStore } from '@/state/auth-store';
import { useUsersStore } from '@/state/users-store';

const STATUS_LABELS: Record<UserStatus, string> = { ACTIVE: 'Activo', SUSPENDED: 'Suspendido' };

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; user: UserView }
  | { kind: 'status'; user: UserView }
  | { kind: 'roles'; user: UserView }
  | null;

export function UsersPage() {
  const isReal = API_MODE === 'real';
  const hasPermission = useAuthStore((state) => state.hasPermission);
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const canWrite = hasPermission('users:write');
  const canAssignRoles = hasPermission('roles:assign');
  // Sin ninguna acción posible, la columna entera sobra: una cabecera "Acciones" sobre celdas
  // vacías ocupa espacio y sugiere que falta algo. Quien solo lee, ve una tabla de solo lectura.
  const canActOnRows = canWrite || canAssignRoles;

  const status = useUsersStore((state) => state.status);
  const error = useUsersStore((state) => state.error);
  const items = useUsersStore((state) => state.items);
  const page = useUsersStore((state) => state.page);
  const pageSize = useUsersStore((state) => state.pageSize);
  const total = useUsersStore((state) => state.total);
  const search = useUsersStore((state) => state.search);
  const statusFilter = useUsersStore((state) => state.statusFilter);
  const stats = useUsersStore((state) => state.stats);
  const setSearch = useUsersStore((state) => state.setSearch);
  const setStatusFilter = useUsersStore((state) => state.setStatusFilter);
  const setPage = useUsersStore((state) => state.setPage);
  const load = useUsersStore((state) => state.load);
  const loadStats = useUsersStore((state) => state.loadStats);

  const [searchInput, setSearchInput] = useState(search);
  const [dialog, setDialog] = useState<Dialog>(null);

  // Rebote del buscador: una consulta por tecleo satura al gateway y produce respuestas fuera
  // de orden. 300 ms es suficiente para agrupar lo que se escribe de corrido.
  useEffect(() => {
    if (searchInput === search) return;
    const timer = window.setTimeout(() => setSearch(searchInput), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, search, setSearch]);

  useEffect(() => {
    if (isReal) void load();
  }, [isReal, load, search, statusFilter, page]);

  useEffect(() => {
    if (isReal) void loadStats();
  }, [isReal, loadStats]);

  // Tras cualquier escritura se vuelve a consultar: las proyecciones de user-service se
  // alimentan de eventos y el resultado real puede no ser el que la pantalla supone.
  async function refresh() {
    await Promise.all([load(), loadStats()]);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const loading = status === 'loading';

  return (
    <div className="listing-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">DIRECTORIO</p>
          <h1>Usuarios</h1>
          <p className="muted">Cuentas de la plataforma, su estado y los roles que tienen asignados.</p>
        </div>
        {canWrite && isReal && (
          <button type="button" className="button button-primary" onClick={() => setDialog({ kind: 'create' })}>
            Nuevo usuario <span aria-hidden="true">+</span>
          </button>
        )}
      </header>

      {!isReal ? (
        <div className="panel panel-padded">
          <DemoModeNotice section="El directorio de usuarios" />
        </div>
      ) : (
        <>
          {stats && (
            <section className="stat-strip" aria-label="Resumen del directorio">
              <article className="stat-card">
                <span>TOTAL</span>
                <strong>{stats.total}</strong>
              </article>
              <article className="stat-card">
                <span>ACTIVOS</span>
                <strong>{stats.active}</strong>
              </article>
              <article className="stat-card">
                <span>SUSPENDIDOS</span>
                <strong>{stats.suspended}</strong>
              </article>
              <article className="stat-card">
                <span>ADMINS ACTIVOS</span>
                <strong>{stats.activeAdmins}</strong>
              </article>
            </section>
          )}

          <section className="panel panel-padded">
            <div className="toolbar">
              <div className="field">
                <label htmlFor="users-search">Buscar</label>
                <input
                  id="users-search"
                  type="search"
                  placeholder="Nombre o correo"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="users-status">Estado</label>
                <select
                  id="users-status"
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as UserStatus | 'ALL')}
                >
                  <option value="ALL">Todos</option>
                  <option value="ACTIVE">Activo</option>
                  <option value="SUSPENDED">Suspendido</option>
                </select>
              </div>
              <div className="toolbar-end">
                <span className="result-count">{total} resultado(s)</span>
                <button type="button" className="button button-ghost" aria-label="Actualizar listado" onClick={() => void refresh()}>
                  Actualizar
                </button>
              </div>
            </div>

            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}

            {loading && items.length === 0 ? (
              <div className="table-loading">
                <Skeleton className="skeleton-row" label="Cargando usuarios" />
                <Skeleton className="skeleton-row" label="Cargando usuarios" />
                <Skeleton className="skeleton-row" label="Cargando usuarios" />
              </div>
            ) : items.length === 0 && status === 'success' ? (
              <EmptyState
                title="Ningún usuario coincide."
                description="Ajusta la búsqueda o el filtro de estado para ver más resultados."
              />
            ) : (
              <div className="table-wrap" aria-busy={loading}>
                <table className="data-table">
                  <caption className="sr-only">Usuarios de la plataforma</caption>
                  <thead>
                    <tr>
                      <th scope="col">Usuario</th>
                      <th scope="col">Puesto</th>
                      <th scope="col">Estado</th>
                      <th scope="col">Roles</th>
                      {canActOnRows && <th scope="col">Acciones</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <div className="cell-stack">
                            <strong>{user.fullName}</strong>
                            <small>{user.email}</small>
                          </div>
                        </td>
                        <td>
                          <div className="cell-stack">
                            <span>{user.jobTitle ?? '—'}</span>
                            <small>{user.department ?? 'Sin departamento'}</small>
                          </div>
                        </td>
                        <td>
                          <span className={`badge badge-${user.status === 'ACTIVE' ? 'active' : 'suspended'}`}>
                            {STATUS_LABELS[user.status]}
                          </span>
                          {user.statusReason && <small className="cell-note">{user.statusReason}</small>}
                        </td>
                        <td>
                          <div className="chip-row">
                            {user.roles.length === 0 ? (
                              <span className="chip chip-empty">Sin roles</span>
                            ) : (
                              user.roles.map((role) => (
                                <span className="chip" key={role}>
                                  {role}
                                </span>
                              ))
                            )}
                          </div>
                        </td>
                        {canActOnRows && (
                        <td>
                          <div className="row-actions">
                            {canWrite && (
                              <button
                                type="button"
                                className="button button-ghost"
                                aria-label={`Editar a ${user.fullName}`}
                                onClick={() => setDialog({ kind: 'edit', user })}
                              >
                                Editar
                              </button>
                            )}
                            {/*
                              Sobre la propia fila no se ofrece suspender: el dominio lo rechaza
                              con SELF_SUSPENSION, así que enseñar el botón sería invitar a un
                              error seguro. Editar sí queda: el propio perfil sí se puede cambiar.
                            */}
                            {canWrite && user.id !== currentUserId && (
                              <button
                                type="button"
                                className="button button-ghost"
                                aria-label={`${user.status === 'ACTIVE' ? 'Suspender' : 'Reactivar'} a ${user.fullName}`}
                                onClick={() => setDialog({ kind: 'status', user })}
                              >
                                {user.status === 'ACTIVE' ? 'Suspender' : 'Reactivar'}
                              </button>
                            )}
                            {canAssignRoles && (
                              <button
                                type="button"
                                className="button button-ghost"
                                aria-label={`Administrar roles de ${user.fullName}`}
                                onClick={() => setDialog({ kind: 'roles', user })}
                              >
                                Roles
                              </button>
                            )}
                          </div>
                        </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <nav className="pagination" aria-label="Paginación de usuarios">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setPage(page - 1)}
                disabled={page <= 1 || loading}
              >
                ← Anterior
              </button>
              <span>
                Página {page} de {totalPages}
              </span>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setPage(page + 1)}
                disabled={page >= totalPages || loading}
              >
                Siguiente →
              </button>
            </nav>
          </section>
        </>
      )}

      {dialog?.kind === 'create' && <CreateUserDialog onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.kind === 'edit' && (
        <EditUserDialog user={dialog.user} onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {dialog?.kind === 'status' && (
        <StatusDialog user={dialog.user} onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {dialog?.kind === 'roles' && (
        <UserRolesDialog user={dialog.user} onClose={() => setDialog(null)} onDone={refresh} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ alta */

// El backend exige entre 10 y 128 caracteres. Se repite aquí para responder sin ida y vuelta,
// sabiendo que la regla que manda es la del servidor: su 400 también se muestra.
const createSchema = z.object({
  email: z.string().email('Ingresa un correo válido.'),
  password: z
    .string()
    .min(10, 'La contraseña debe tener entre 10 y 128 caracteres.')
    .max(128, 'La contraseña debe tener entre 10 y 128 caracteres.'),
  fullName: z.string().trim().min(1, 'El nombre es obligatorio.'),
  department: z.string().optional(),
  jobTitle: z.string().optional(),
});

type CreateValues = z.infer<typeof createSchema>;

function CreateUserDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { showToast } = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { email: '', password: '', fullName: '', department: '', jobTitle: '' },
  });

  async function submit(values: CreateValues) {
    setFormError(null);
    try {
      // El alta la atiende auth-service, dueño de las credenciales; el perfil viaja a
      // user-service en el evento account.registered.
      await usersApi.create({
        email: values.email,
        password: values.password,
        fullName: values.fullName,
        department: values.department?.trim() || undefined,
        jobTitle: values.jobTitle?.trim() || undefined,
      });
      showToast(`Cuenta creada para ${values.email}.`, 'success');
      onClose();
      await onDone();
    } catch (error) {
      applyServerErrors(error, setError, ['email', 'password', 'fullName'], setFormError);
    }
  }

  return (
    <Modal
      title="Nuevo usuario"
      description="Crea la cuenta y su perfil. El rol inicial es viewer; se cambia desde el panel de roles."
      onClose={onClose}
    >
      <form className="dialog-form" onSubmit={handleSubmit(submit)} noValidate>
        <div className="field">
          <label htmlFor="create-email">Correo electrónico</label>
          <input id="create-email" type="email" autoComplete="off" {...register('email')} />
          {errors.email && <span className="field-error">{errors.email.message}</span>}
        </div>
        <div className="field">
          <label htmlFor="create-password">Contraseña</label>
          <input id="create-password" type="password" autoComplete="new-password" {...register('password')} />
          <small className="field-hint">Entre 10 y 128 caracteres.</small>
          {errors.password && <span className="field-error">{errors.password.message}</span>}
        </div>
        <div className="field">
          <label htmlFor="create-fullname">Nombre completo</label>
          <input id="create-fullname" type="text" {...register('fullName')} />
          {errors.fullName && <span className="field-error">{errors.fullName.message}</span>}
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="create-department">Departamento</label>
            <input id="create-department" type="text" {...register('department')} />
          </div>
          <div className="field">
            <label htmlFor="create-jobtitle">Puesto</label>
            <input id="create-jobtitle" type="text" {...register('jobTitle')} />
          </div>
        </div>
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
            {isSubmitting ? 'Creando…' : 'Crear usuario'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- edición */

const editSchema = z.object({
  fullName: z.string().trim().min(1, 'El nombre es obligatorio.'),
  department: z.string(),
  jobTitle: z.string(),
});

type EditValues = z.infer<typeof editSchema>;

function EditUserDialog({
  user,
  onClose,
  onDone,
}: {
  user: UserView;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { showToast } = useToast();
  // La versión viva del registro: si el servidor responde 409 se sustituye por la del servidor
  // para que el siguiente intento salga con la versión correcta y no vuelva a chocar.
  const [current, setCurrent] = useState(user);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      fullName: user.fullName,
      department: user.department ?? '',
      jobTitle: user.jobTitle ?? '',
    },
  });

  async function submit(values: EditValues) {
    setFormError(null);
    try {
      await usersApi.update(current.id, {
        fullName: values.fullName,
        department: values.department.trim() || null,
        jobTitle: values.jobTitle.trim() || null,
        version: current.version,
      });
      showToast('Perfil actualizado.', 'success');
      onClose();
      await onDone();
    } catch (error) {
      if (isVersionConflict(error)) {
        showToast(describeProblem(error), 'error');
        setFormError(describeProblem(error));
        const fresh = await usersApi.get(current.id).catch(() => null);
        if (fresh) {
          setCurrent(fresh);
          reset({
            fullName: fresh.fullName,
            department: fresh.department ?? '',
            jobTitle: fresh.jobTitle ?? '',
          });
        }
        await onDone();
        return;
      }
      applyServerErrors(error, setError, ['fullName'], setFormError);
    }
  }

  return (
    <Modal title={`Editar a ${current.fullName}`} description={current.email} onClose={onClose}>
      <form className="dialog-form" onSubmit={handleSubmit(submit)} noValidate>
        <div className="field">
          <label htmlFor="edit-fullname">Nombre completo</label>
          <input id="edit-fullname" type="text" {...register('fullName')} />
          {errors.fullName && <span className="field-error">{errors.fullName.message}</span>}
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="edit-department">Departamento</label>
            <input id="edit-department" type="text" {...register('department')} />
          </div>
          <div className="field">
            <label htmlFor="edit-jobtitle">Puesto</label>
            <input id="edit-jobtitle" type="text" {...register('jobTitle')} />
          </div>
        </div>
        <p className="field-hint">
          Versión {current.version} · actualizado el {formatDateTime(current.updatedAt)}
        </p>
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
            {isSubmitting ? 'Guardando…' : 'Guardar cambios'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------ suspensión / reactivación */

function StatusDialog({
  user,
  onClose,
  onDone,
}: {
  user: UserView;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const suspending = user.status === 'ACTIVE';

  async function submit() {
    setBusy(true);
    setFormError(null);
    try {
      const trimmed = reason.trim() || undefined;
      await (suspending ? usersApi.suspend(user.id, trimmed) : usersApi.reactivate(user.id, trimmed));
      showToast(suspending ? 'Usuario suspendido.' : 'Usuario reactivado.', 'success');
      onClose();
      await onDone();
    } catch (error) {
      // SELF_SUSPENSION y LAST_ADMIN son reglas de negocio, no fallos: el detalle del servidor
      // ya dice exactamente qué regla se tocó, así que se muestra tal cual dentro del diálogo.
      setFormError(describeProblem(error));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={suspending ? `Suspender a ${user.fullName}` : `Reactivar a ${user.fullName}`}
      description={
        suspending
          ? 'La cuenta deja de poder iniciar sesión. El motivo es opcional y queda en la auditoría.'
          : 'La cuenta vuelve a poder iniciar sesión.'
      }
      onClose={onClose}
    >
      <div className="dialog-form">
        <div className="field">
          <label htmlFor="status-reason">Motivo (opcional)</label>
          <textarea
            id="status-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        {formError && (
          <div className="form-error" role="alert">
            {formError}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className={suspending ? 'button button-danger' : 'button button-primary'}
            onClick={() => void submit()}
            disabled={busy}
          >
            {suspending ? 'Suspender' : 'Reactivar'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------- roles del usuario */

function UserRolesDialog({
  user,
  onClose,
  onDone,
}: {
  user: UserView;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [catalog, setCatalog] = useState<RoleView[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [roles, assigned] = await Promise.all([rolesApi.list(), rolesApi.userRoles(user.id)]);
        if (!active) return;
        setCatalog(roles);
        setSelected(assigned.roles.map((role) => role.id));
      } catch (error) {
        if (active) setFormError(describeProblem(error));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [user.id]);

  function toggle(roleId: string) {
    setSelected((current) =>
      current.includes(roleId) ? current.filter((id) => id !== roleId) : [...current, roleId],
    );
  }

  async function submit() {
    setBusy(true);
    setFormError(null);
    try {
      // PUT: reemplaza el conjunto completo. Lo que no esté marcado se quita.
      await rolesApi.replaceUserRoles(user.id, selected);
      showToast(
        'Roles actualizados. La columna de roles del directorio la mantiene user-service por proyección de eventos y puede tardar un instante en reflejarlo.',
        'success',
      );
      onClose();
      await onDone();
    } catch (error) {
      setFormError(describeProblem(error));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Roles de ${user.fullName}`}
      description="Marca los roles que debe tener. Al guardar se reemplaza el conjunto completo: lo que quede sin marcar se le quita."
      onClose={onClose}
    >
      <div className="dialog-form">
        {loading ? (
          <Skeleton className="skeleton-row" label="Cargando roles" />
        ) : (
          <fieldset className="checkbox-grid">
            <legend className="sr-only">Catálogo de roles</legend>
            {catalog.map((role) => (
              <label className="checkbox-item" key={role.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(role.id)}
                  onChange={() => toggle(role.id)}
                />
                <span>
                  <strong>{role.name}</strong>
                  <small>{role.description}</small>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {selected.length === 0 && !loading && (
          <p className="field-hint">Sin roles marcados: el usuario se quedará sin ningún permiso.</p>
        )}
        {formError && (
          <div className="form-error" role="alert">
            {formError}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="button button-primary" onClick={() => void submit()} disabled={busy || loading}>
            {busy ? 'Guardando…' : 'Reemplazar roles'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
