import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Permission } from '@toka/contracts/permissions';
import { useAuthStore } from '@/state/auth-store';

export function RequireSession() {
  const user = useAuthStore((state) => state.user);
  const location = useLocation();
  return user ? <Outlet /> : <Navigate to="/login" replace state={{ from: location }} />;
}

export function RequirePermission({ permission }: { permission: Permission }) {
  const allowed = useAuthStore((state) => state.hasPermission(permission));
  return allowed ? <Outlet /> : <Navigate to="/forbidden" replace />;
}
