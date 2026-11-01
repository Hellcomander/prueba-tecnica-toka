import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RequirePermission, RequireSession } from './route-guard';
import { Skeleton } from './skeleton';
import { ToastProvider, useToast } from './toast-provider';
import { useAuthStore } from '@/state/auth-store';

function ToastButton() {
  const { showToast } = useToast();
  return <button onClick={() => showToast('Guardado', 'success')}>Mostrar toast</button>;
}

describe('componentes compartidos', () => {
  beforeEach(() => useAuthStore.getState().clearSession());

  it('muestra y permite cerrar una notificación accesible', () => {
    render(<ToastProvider><ToastButton /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar toast' }));
    expect(screen.getByRole('status')).toHaveTextContent('Guardado');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar notificación' }));
    expect(screen.queryByText('Guardado')).not.toBeInTheDocument();
  });

  it('expone el skeleton como estado de carga accesible', () => {
    render(<Skeleton label="Cargando usuarios" />);
    expect(screen.getByRole('status', { name: 'Cargando usuarios' })).toBeInTheDocument();
  });

  it('redirige a login cuando la sesión no existe', () => {
    render(
      <MemoryRouter initialEntries={['/privado']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<RequireSession />}>
            <Route path="/privado" element={<p>Privado</p>} />
          </Route>
          <Route path="/login" element={<p>Login</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Login')).toBeInTheDocument();
  });

  it('redirige a 403 si la sesión no contiene el permiso del contrato', () => {
    useAuthStore.getState().setSession({
      id: 'viewer',
      email: 'viewer@toka.local',
      fullName: 'Vera Viewer',
      roles: ['viewer'],
      permissions: ['users:read'],
    }, 'viewer-token');
    render(
      <MemoryRouter initialEntries={['/audit']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<RequirePermission permission="audit:read" />}>
            <Route path="/audit" element={<p>Auditoría</p>} />
          </Route>
          <Route path="/forbidden" element={<p>Sin acceso</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Sin acceso')).toBeInTheDocument();
  });
});
