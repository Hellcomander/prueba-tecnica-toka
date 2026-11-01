import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Permission } from '@toka/contracts/permissions';
import { ToastProvider } from '@/components/toast-provider';
import { useAuthStore } from '@/state/auth-store';
import { useUsersStore } from '@/state/users-store';
import { usersApi, type UserView } from '@/services/users-api';
import { rolesApi } from '@/services/roles-api';
import { UsersPage } from './users-page';
import { problemError } from '@/test-helpers';

// Estas pantallas solo existen contra el backend: el modo demo enseña un aviso, no datos.
jest.mock('@/config', () => ({ API_MODE: 'real' }));
jest.mock('@/services/users-api', () => ({
  usersApi: {
    list: jest.fn(),
    get: jest.fn(),
    stats: jest.fn(),
    update: jest.fn(),
    suspend: jest.fn(),
    reactivate: jest.fn(),
    create: jest.fn(),
  },
}));
jest.mock('@/services/roles-api', () => ({
  rolesApi: { list: jest.fn(), userRoles: jest.fn(), replaceUserRoles: jest.fn() },
}));

const users = usersApi as jest.Mocked<typeof usersApi>;
const roles = rolesApi as jest.Mocked<typeof rolesApi>;

const ana: UserView = {
  id: 'user-ana',
  email: 'ana@toka.local',
  fullName: 'Ana Admin',
  department: 'Dirección',
  jobTitle: 'CTO',
  status: 'ACTIVE',
  statusReason: null,
  roles: ['admin'],
  version: 3,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
};

const beto: UserView = {
  id: 'user-beto',
  email: 'beto@toka.local',
  fullName: 'Beto Suspendido',
  department: null,
  jobTitle: null,
  status: 'SUSPENDED',
  statusReason: 'Baja temporal',
  roles: [],
  version: 2,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-05T10:00:00.000Z',
};

/** La fila de quien está mirando: renderUsers abre sesión con el id 'me'. */
const yo: UserView = {
  id: 'me',
  email: 'admin@toka.local',
  fullName: 'Ana Admin',
  department: 'Dirección',
  jobTitle: 'CTO',
  status: 'ACTIVE',
  statusReason: null,
  roles: ['admin'],
  version: 1,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
};

const page = (items: UserView[], total = items.length, pageNumber = 1) => ({
  items,
  page: pageNumber,
  pageSize: 10,
  total,
});

function renderUsers(permissions: Permission[] = ['users:read', 'users:write', 'roles:assign']) {
  useAuthStore
    .getState()
    .setSession({ id: 'me', email: 'admin@toka.local', fullName: 'Ana Admin', roles: ['admin'], permissions }, 'token');
  return render(
    <ToastProvider>
      <UsersPage />
    </ToastProvider>,
  );
}

describe('página de usuarios', () => {
  beforeEach(() => {
    useUsersStore.getState().reset();
    useAuthStore.getState().clearSession();
    users.list.mockResolvedValue(page([ana, beto]));
    users.stats.mockResolvedValue({
      total: 2,
      active: 1,
      suspended: 1,
      activeAdmins: 1,
      byRole: [{ role: 'admin', count: 1 }],
      newLast7Days: 2,
    });
  });

  it('muestra el directorio con nombre, correo, estado y roles', async () => {
    renderUsers();
    expect(await screen.findByText('Ana Admin')).toBeInTheDocument();
    // Dentro de la tabla: "Suspendido" también es una opción del filtro de estado.
    const table = within(screen.getByRole('table'));
    expect(table.getByText('ana@toka.local')).toBeInTheDocument();
    expect(table.getByText('Suspendido')).toBeInTheDocument();
    expect(table.getByText('Baja temporal')).toBeInTheDocument();
    expect(table.getByText('admin')).toBeInTheDocument();
    expect(table.getByText('Sin roles')).toBeInTheDocument();
  });

  it('manda el filtro de estado al servicio y vuelve a la primera página', async () => {
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText('Ana Admin');

    await user.selectOptions(screen.getByLabelText('Estado'), 'SUSPENDED');

    await waitFor(() =>
      expect(users.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'SUSPENDED', page: 1 })),
    );
  });

  it('busca con rebote y manda el texto como parámetro search', async () => {
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText('Ana Admin');

    await user.type(screen.getByLabelText('Buscar'), 'ana');

    await waitFor(() => expect(users.list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'ana' })));
    // El rebote agrupa las tres teclas en una sola consulta, además de la inicial.
    expect(users.list.mock.calls.filter(([params]) => params.search === 'ana')).toHaveLength(1);
  });

  it('pagina por número de página sobre el total que devuelve el servicio', async () => {
    const user = userEvent.setup();
    users.list.mockResolvedValue(page([ana], 25));
    renderUsers();
    await screen.findByText('Ana Admin');
    expect(screen.getByText('Página 1 de 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Siguiente/ }));

    await waitFor(() => expect(users.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });

  it('valida en el cliente la contraseña de 10 caracteres antes de llamar al alta', async () => {
    const user = userEvent.setup();
    renderUsers();
    await screen.findByText('Ana Admin');

    await user.click(screen.getByRole('button', { name: /Nuevo usuario/ }));
    await user.type(screen.getByLabelText('Correo electrónico'), 'nueva@toka.local');
    await user.type(screen.getByLabelText('Contraseña'), 'corta');
    await user.type(screen.getByLabelText('Nombre completo'), 'Nueva Persona');
    await user.click(screen.getByRole('button', { name: 'Crear usuario' }));

    expect(await screen.findByText('La contraseña debe tener entre 10 y 128 caracteres.')).toBeInTheDocument();
    expect(users.create).not.toHaveBeenCalled();
  });

  it('coloca los fieldErrors del 400 del servidor sobre los campos del formulario', async () => {
    const user = userEvent.setup();
    users.create.mockRejectedValue(
      problemError(400, {
        code: 'VALIDATION_ERROR',
        detail: 'La solicitud tiene campos inválidos',
        fieldErrors: { email: ['email: ya está registrado'] },
      }),
    );
    renderUsers();
    await screen.findByText('Ana Admin');

    await user.click(screen.getByRole('button', { name: /Nuevo usuario/ }));
    await user.type(screen.getByLabelText('Correo electrónico'), 'ana@toka.local');
    await user.type(screen.getByLabelText('Contraseña'), 'contraseña-larga');
    await user.type(screen.getByLabelText('Nombre completo'), 'Ana Dos');
    await user.click(screen.getByRole('button', { name: 'Crear usuario' }));

    expect(await screen.findByText('email: ya está registrado')).toBeInTheDocument();
  });

  it('explica el 409 VERSION_CONFLICT y recarga la fila con la versión del servidor', async () => {
    const user = userEvent.setup();
    users.update.mockRejectedValue(
      problemError(409, { code: 'VERSION_CONFLICT', detail: 'El perfil cambió desde que lo leíste' }),
    );
    users.get.mockResolvedValue({ ...ana, jobTitle: 'CEO', version: 9 });
    renderUsers();
    await screen.findByText('Ana Admin');

    await user.click(screen.getByRole('button', { name: 'Editar a Ana Admin' }));
    await user.clear(screen.getByLabelText('Puesto'));
    await user.type(screen.getByLabelText('Puesto'), 'Directora');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/modificó este registro/i);
    // La versión que viajará en el siguiente intento es la del servidor, no la que se leyó.
    expect(await within(dialog).findByText(/Versión 9/)).toBeInTheDocument();
    expect(users.get).toHaveBeenCalledWith('user-ana');
    expect(screen.getByLabelText('Puesto')).toHaveValue('CEO');
  });

  it('muestra la regla del servidor cuando alguien intenta suspenderse a sí mismo', async () => {
    const user = userEvent.setup();
    users.suspend.mockRejectedValue(
      problemError(409, { code: 'SELF_SUSPENSION', detail: 'No puedes suspenderte a ti mismo' }),
    );
    renderUsers();
    await screen.findByText('Ana Admin');

    await user.click(screen.getByRole('button', { name: 'Suspender a Ana Admin' }));
    await user.click(screen.getByRole('button', { name: 'Suspender' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No puedes suspenderte a ti mismo');
  });

  it('no ofrece acciones de escritura a quien solo tiene users:read', async () => {
    renderUsers(['users:read']);
    await screen.findByText('Ana Admin');

    expect(screen.queryByRole('button', { name: /Nuevo usuario/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Editar a/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Suspender a/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Administrar roles de/ })).not.toBeInTheDocument();
  });

  it('reemplaza el conjunto completo de roles y vuelve a consultar el listado', async () => {
    const user = userEvent.setup();
    roles.list.mockResolvedValue([
      { id: 'role-admin', name: 'admin', description: 'Acceso total', permissions: ['users:read'], isSystem: true, version: 1 },
      { id: 'role-soporte', name: 'soporte', description: 'Mesa de ayuda', permissions: ['users:read'], isSystem: false, version: 1 },
    ]);
    roles.userRoles.mockResolvedValue({
      userId: 'user-ana',
      roles: [{ id: 'role-admin', name: 'admin' }],
      assignmentsVersion: 1,
    });
    roles.replaceUserRoles.mockResolvedValue({
      userId: 'user-ana',
      roles: [{ id: 'role-soporte', name: 'soporte' }],
      assignmentsVersion: 2,
    });
    renderUsers();
    await screen.findByText('Ana Admin');

    await user.click(screen.getByRole('button', { name: 'Administrar roles de Ana Admin' }));
    const adminBox = await screen.findByRole('checkbox', { name: /Acceso total/ });
    expect(adminBox).toBeChecked();

    await user.click(adminBox);
    await user.click(screen.getByRole('checkbox', { name: /Mesa de ayuda/ }));
    const callsBefore = users.list.mock.calls.length;
    await user.click(screen.getByRole('button', { name: 'Reemplazar roles' }));

    // PUT con el conjunto completo: el rol desmarcado se va, no se queda por omisión.
    await waitFor(() => expect(roles.replaceUserRoles).toHaveBeenCalledWith('user-ana', ['role-soporte']));
    // La columna de roles es una proyección: se vuelve a consultar en vez de darla por hecha.
    await waitFor(() => expect(users.list.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('no ofrece suspenderse a uno mismo: el botón no existe en la propia fila', async () => {
    // El dominio lo rechaza con SELF_SUSPENSION, así que la interfaz no debe invitar al error.
    users.list.mockResolvedValue(page([yo, beto]));
    renderUsers();
    await screen.findByText('Beto Suspendido');

    expect(screen.queryByRole('button', { name: 'Suspender a Ana Admin' })).not.toBeInTheDocument();
    // Editar el propio perfil sí es legítimo y sigue disponible.
    expect(screen.getByRole('button', { name: 'Editar a Ana Admin' })).toBeInTheDocument();
    // Y sobre otra persona el botón sigue estando.
    expect(screen.getByRole('button', { name: 'Reactivar a Beto Suspendido' })).toBeInTheDocument();
  });

  it('sin permisos de escritura ni de asignación, la columna Acciones no se dibuja', async () => {
    renderUsers(['users:read']);
    await screen.findByText('Ana Admin');

    const table = within(screen.getByRole('table'));
    expect(table.queryByRole('columnheader', { name: 'Acciones' })).not.toBeInTheDocument();
    expect(table.getByRole('columnheader', { name: 'Usuario' })).toBeInTheDocument();
    // Cuatro columnas, no cinco con la última vacía.
    expect(table.getAllByRole('columnheader')).toHaveLength(4);
    expect(table.queryByRole('button', { name: /Editar a/ })).not.toBeInTheDocument();
  });
});
