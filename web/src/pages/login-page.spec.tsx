import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LoginPage } from './login-page';
import { useAuthStore } from '@/state/auth-store';
import { DashboardPage } from './dashboard-page';
import { AppLayout } from '@/components/app-layout';
import { ToastProvider } from '@/components/toast-provider';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AppLayout />}>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/audit" element={<h1>Auditoría</h1>} />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('login y navegación por permisos', () => {
  beforeEach(() => {
    useAuthStore.getState().clearSession();
  });

  it('valida correo y contraseña con los mensajes del formulario', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('Correo electrónico'), 'no-es-correo');
    await user.type(screen.getByLabelText('Contraseña'), 'corta');
    await user.click(screen.getByRole('button', { name: /Iniciar sesión/ }));
    expect(await screen.findByText('Ingresa un correo válido.')).toBeInTheDocument();
    expect(screen.getByText('La contraseña debe tener al menos 8 caracteres.')).toBeInTheDocument();
  });

  it('autentica el perfil demo seleccionado usando permisos de contracts', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(screen.getByRole('button', { name: /Admin/ }));
    await user.click(screen.getByRole('button', { name: /Iniciar sesión/ }));
    expect(await screen.findByRole('heading', { name: /Hola, Ana/ })).toBeInTheDocument();
    expect(useAuthStore.getState().hasPermission('roles:write')).toBe(true);
  });

  it('muestra el estado de error al autenticar credenciales inválidas en modo demo', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('Correo electrónico'), 'desconocido@toka.local');
    await user.type(screen.getByLabelText('Contraseña'), 'contraseña-larga');
    await user.click(screen.getByRole('button', { name: /Iniciar sesión/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Correo o contraseña incorrectos.');
    expect(useAuthStore.getState().status).toBe('error');
  });

  it('esconde Auditoría del perfil viewer porque no tiene audit:read', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(screen.getByRole('button', { name: /Solo lectura/ }));
    await user.click(screen.getByRole('button', { name: /Iniciar sesión/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /Hola, Vera/ })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Auditoría' })).not.toBeInTheDocument();
  });
});
