import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Permission } from '@toka/contracts/permissions';
import { ToastProvider } from '@/components/toast-provider';
import { rolesApi, type RoleView } from '@/services/roles-api';
import { useAuthStore } from '@/state/auth-store';
import { useRolesStore } from '@/state/roles-store';
import { RolesPage } from './roles-page';
import { problemError } from '@/test-helpers';

jest.mock('@/config', () => ({ API_MODE: 'real' }));
jest.mock('@/services/roles-api', () => ({
  rolesApi: {
    list: jest.fn(),
    permissions: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    userRoles: jest.fn(),
    replaceUserRoles: jest.fn(),
  },
}));

const roles = rolesApi as jest.Mocked<typeof rolesApi>;

const adminRole: RoleView = {
  id: 'role-admin',
  name: 'admin',
  description: 'Administración completa',
  permissions: ['users:read', 'users:write'],
  isSystem: true,
  version: 1,
};

const supportRole: RoleView = {
  id: 'role-soporte',
  name: 'soporte',
  description: 'Mesa de ayuda',
  permissions: ['users:read'],
  isSystem: false,
  version: 4,
};

function renderRoles(permissions: Permission[] = ['roles:read', 'roles:write']) {
  useAuthStore
    .getState()
    .setSession({ id: 'me', email: 'admin@toka.local', fullName: 'Ana Admin', roles: ['admin'], permissions }, 'token');
  return render(
    <ToastProvider>
      <RolesPage />
    </ToastProvider>,
  );
}

describe('página de roles', () => {
  beforeEach(() => {
    useRolesStore.getState().reset();
    useAuthStore.getState().clearSession();
    roles.list.mockResolvedValue([adminRole, supportRole]);
    roles.permissions.mockResolvedValue([
      { code: 'users:read', description: 'Consultar usuarios y estadísticas' },
      { code: 'users:write', description: 'Crear, editar, suspender y reactivar usuarios' },
    ]);
  });

  it('lista los roles con sus permisos y no ofrece tocar los de sistema', async () => {
    renderRoles();
    expect(await screen.findByRole('heading', { name: 'soporte' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'admin' })).toBeInTheDocument();
    expect(screen.getByText('SISTEMA')).toBeInTheDocument();

    // El backend responde 409 SYSTEM_ROLE_IMMUTABLE: no se ofrece lo que va a fallar.
    expect(screen.queryByRole('button', { name: 'Editar el rol admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eliminar el rol admin' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Editar el rol soporte' })).toBeInTheDocument();
  });

  it('valida el nombre del rol y exige al menos un permiso antes de llamar al servicio', async () => {
    const user = userEvent.setup();
    renderRoles();
    await screen.findByRole('heading', { name: 'soporte' });

    await user.click(screen.getByRole('button', { name: /Nuevo rol/ }));
    await user.type(screen.getByLabelText('Nombre'), '1soporte nivel 2');
    await user.click(screen.getByRole('button', { name: 'Crear rol' }));

    expect(
      await screen.findByText('Debe empezar con letra y solo admite letras, números, - y _.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Selecciona al menos un permiso.')).toBeInTheDocument();
    expect(roles.create).not.toHaveBeenCalled();
  });

  it('crea el rol con los permisos marcados del catálogo', async () => {
    const user = userEvent.setup();
    roles.create.mockResolvedValue({ ...supportRole, id: 'role-nuevo', name: 'soporte-n2' });
    renderRoles();
    await screen.findByRole('heading', { name: 'soporte' });

    await user.click(screen.getByRole('button', { name: /Nuevo rol/ }));
    await user.type(screen.getByLabelText('Nombre'), 'soporte-n2');
    await user.type(screen.getByLabelText('Descripción'), 'Segundo nivel');
    await user.click(screen.getByRole('checkbox', { name: /users:read/ }));
    await user.click(screen.getByRole('button', { name: 'Crear rol' }));

    await waitFor(() =>
      expect(roles.create).toHaveBeenCalledWith({
        name: 'soporte-n2',
        description: 'Segundo nivel',
        permissions: ['users:read'],
      }),
    );
  });

  it('envía la versión al editar, que es lo que detecta los cambios concurrentes', async () => {
    const user = userEvent.setup();
    roles.update.mockResolvedValue({ ...supportRole, version: 5 });
    renderRoles();
    await screen.findByRole('heading', { name: 'soporte' });

    await user.click(screen.getByRole('button', { name: 'Editar el rol soporte' }));
    await user.clear(screen.getByLabelText('Descripción'));
    await user.type(screen.getByLabelText('Descripción'), 'Mesa de ayuda nivel 1');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));

    await waitFor(() =>
      expect(roles.update).toHaveBeenCalledWith('role-soporte', expect.objectContaining({ version: 4 })),
    );
  });

  it('explica el 409 ROLE_IN_USE con el mensaje del servidor al intentar borrar', async () => {
    const user = userEvent.setup();
    roles.remove.mockRejectedValue(
      problemError(409, {
        code: 'ROLE_IN_USE',
        detail: 'El rol tiene 3 usuario(s) asignado(s); reasígnalos antes de eliminarlo',
      }),
    );
    renderRoles();
    await screen.findByRole('heading', { name: 'soporte' });

    await user.click(screen.getByRole('button', { name: 'Eliminar el rol soporte' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar rol' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'El rol tiene 3 usuario(s) asignado(s); reasígnalos antes de eliminarlo',
    );
  });

  it('no ofrece acciones de escritura a quien solo tiene roles:read', async () => {
    renderRoles(['roles:read']);
    await screen.findByRole('heading', { name: 'soporte' });

    expect(screen.queryByRole('button', { name: /Nuevo rol/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar el rol soporte' })).not.toBeInTheDocument();
  });
});
