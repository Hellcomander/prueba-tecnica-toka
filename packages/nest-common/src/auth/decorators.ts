import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission, Scope } from '@toka/contracts';
import type { AuthenticatedUser, ServicePrincipal } from './auth.types';

export const IS_PUBLIC_KEY = 'toka:isPublic';
export const REQUIRED_PERMISSIONS_KEY = 'toka:requiredPermissions';
export const INTERNAL_SCOPE_KEY = 'toka:internalScope';

/** Excepción explícita al "deny by default": la ruta no exige token (login, health, JWKS). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** El usuario debe tener TODOS los permisos indicados (vienen en el claim `permissions`). */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);

/**
 * Ruta interna (servicio → servicio): exige un token de servicio con este scope y rechaza los
 * tokens de usuario. El gateway además responde 404 a /internal/*.
 */
export const InternalRoute = (scope: Scope) => SetMetadata(INTERNAL_SCOPE_KEY, scope);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => ctx.switchToHttp().getRequest().user,
);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ServicePrincipal | undefined => ctx.switchToHttp().getRequest().principal,
);
