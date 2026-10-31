import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission, Scope } from '@toka/contracts';
import { ClsService } from 'nestjs-cls';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLS_USER_ID } from '../context/request-context';
import { type AuthenticatedUser, SECURITY_EVENT_SINK, type SecurityEventSink, type ServicePrincipal } from './auth.types';
import { INTERNAL_SCOPE_KEY, IS_PUBLIC_KEY, REQUIRED_PERMISSIONS_KEY } from './decorators';
import { JwtVerifier, TokenVerificationError } from './jwt-verifier';

interface AuthRequest {
  method: string;
  path?: string;
  route?: { path?: string };
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
  principal?: ServicePrincipal;
}

function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+)$/.exec(value ?? '');
  return match ? match[1] : null;
}

/**
 * Autenticación, global y "deny by default": toda ruta exige un token válido salvo @Public().
 * Rutas @InternalRoute(scope) solo aceptan tokens de servicio con ese scope; el resto solo
 * access tokens de usuario. Cada tipo de token se rechaza en las rutas del otro.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtVerifier,
    private readonly cls: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Falta el token de acceso', wwwAuthenticate: 'Bearer' });
    }

    const scope = this.reflector.getAllAndOverride<Scope | undefined>(INTERNAL_SCOPE_KEY, targets);
    try {
      if (scope) {
        req.principal = await this.verifier.verifyServiceToken(token, scope);
        if (this.cls.isActive()) this.cls.set(CLS_USER_ID, req.principal.id);
      } else {
        req.user = await this.verifier.verifyAccessToken(token);
        if (this.cls.isActive()) this.cls.set(CLS_USER_ID, req.user.id);
      }
      return true;
    } catch (error) {
      if (error instanceof TokenVerificationError && error.reason === 'insufficient_scope') {
        throw new ForbiddenException({ code: 'INSUFFICIENT_SCOPE', message: error.message, wwwAuthenticate: 'Bearer error="insufficient_scope"' });
      }
      const expired = error instanceof TokenVerificationError && error.reason === 'expired';
      throw new UnauthorizedException({
        code: expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
        message: expired ? 'El token expiró' : 'Token inválido',
        wwwAuthenticate: 'Bearer error="invalid_token"',
      });
    }
  }
}

/** Evita inundar la auditoría si un cliente reintenta en bucle la misma ruta prohibida. */
export class DedupWindow {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  shouldEmit(key: string): boolean {
    const t = this.now();
    const last = this.seen.get(key);
    if (last !== undefined && t - last < this.windowMs) return false;
    this.seen.set(key, t);
    if (this.seen.size > 10_000) {
      for (const [k, v] of this.seen) if (t - v >= this.windowMs) this.seen.delete(k);
    }
    return true;
  }
}

/** Autorización: verifica @RequirePermissions contra los permisos del token y reporta cada 403. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly dedup = new DedupWindow(60_000);

  constructor(
    private readonly reflector: Reflector,
    @InjectPinoLogger(PermissionsGuard.name) private readonly logger: PinoLogger,
    @Optional() @Inject(SECURITY_EVENT_SINK) private readonly sink?: SecurityEventSink,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const req = context.switchToHttp().getRequest<AuthRequest>();
    const granted = new Set<string>(req.user?.permissions ?? []);
    const missing = required.filter((p) => !granted.has(p));
    if (missing.length === 0) return true;

    const event = {
      userId: req.user?.id ?? req.principal?.id ?? null,
      method: req.method,
      route: req.route?.path ?? req.path ?? 'unknown',
      required,
      reason: req.user ? ('missing_permission' as const) : ('wrong_token_use' as const),
    };
    this.logger.warn({ event: 'auth.permission.denied', ...event, missing }, 'auth.permission.denied');
    if (this.sink && this.dedup.shouldEmit(`${event.userId}:${event.method}:${event.route}`)) {
      void Promise.resolve()
        .then(() => this.sink?.accessDenied(event))
        .catch((err: unknown) => this.logger.error({ err }, 'security event sink failed'));
    }
    throw new ForbiddenException({
      code: 'FORBIDDEN',
      message: 'No tienes permiso para esta operación',
      wwwAuthenticate: 'Bearer error="insufficient_scope"',
    });
  }
}
