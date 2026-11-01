import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from '@/components/app-layout';
import { RequirePermission, RequireSession } from '@/components/route-guard';
import { ToastProvider } from '@/components/toast-provider';
import { DashboardPage } from '@/pages/dashboard-page';
import { LoginPage } from '@/pages/login-page';
import { PlaceholderPage } from '@/pages/placeholder-page';
import { useAuthStore } from '@/state/auth-store';
import { restoreSession } from '@/state/session';

export function App() {
  const restoring = useAuthStore((state) => state.restoring);

  // Al abrir o recargar se intenta recuperar la sesión con la cookie de refresh, antes de
  // decidir si mandar al login: si no, un reload echaría fuera a alguien que sigue autenticado.
  useEffect(() => {
    void restoreSession();
  }, []);

  if (restoring) {
    return (
      <main className="session-splash" aria-busy="true">
        <p role="status">Restaurando sesión…</p>
      </main>
    );
  }

  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forbidden" element={<main className="forbidden-page"><p className="eyebrow">403 · ACCESO DENEGADO</p><h1>No tienes permiso para ver esta sección.</h1><a href="/">Volver al resumen</a></main>} />
          <Route element={<RequireSession />}>
            <Route element={<AppLayout />}>
              <Route element={<RequirePermission permission="users:read" />}>
                <Route index element={<DashboardPage />} />
              </Route>
              <Route path="users" element={<RequirePermission permission="users:read" />}><Route index element={<PlaceholderPage />} /></Route>
              <Route path="roles" element={<RequirePermission permission="roles:read" />}><Route index element={<PlaceholderPage />} /></Route>
              <Route path="audit" element={<RequirePermission permission="audit:read" />}><Route index element={<PlaceholderPage />} /></Route>
              <Route path="assistant" element={<RequirePermission permission="agent:use" />}><Route index element={<PlaceholderPage />} /></Route>
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
