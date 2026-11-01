import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Actor, Permission } from '@toka/contracts';
import { type AuthenticatedUser, CurrentUser, Public, RequirePermissions } from '@toka/nest-common';
import { CreateAccountUseCase } from '../../application/commands/create-account.use-case';
import { LoginUseCase } from '../../application/commands/login.use-case';
import { LogoutUseCase } from '../../application/commands/logout.use-case';
import { RefreshUseCase } from '../../application/commands/refresh.use-case';
import type { AccountView, LoginResult, UserInfoView } from '../../application/mappers/views';
import { DiscoveryQuery, JwksQuery, UserInfoQuery } from '../../application/queries/auth-queries';
import {
  attemptContext,
  clearRefreshCookie,
  COOKIE_SECURE,
  type HttpRequestLike,
  type HttpResponseLike,
  readRefreshCookie,
  setRefreshCookie,
} from './cookies';
import { CreateAccountDto, LoginDto } from './dto/auth.dto';
import { LockoutInterceptor } from './lockout.interceptor';

export interface TokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: UserInfoView;
}

/** Controllers delgados: traducen HTTP ↔ caso de uso. La cookie se arma aquí, no en el dominio. */
@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly loginUseCase: LoginUseCase,
    private readonly refreshUseCase: RefreshUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly userInfo: UserInfoQuery,
    @Inject(COOKIE_SECURE) private readonly cookieSecure: boolean,
  ) {}

  /** Público por definición: es la puerta de entrada. El abuso lo contiene el lockout (429). */
  @Post('login')
  @Public()
  @HttpCode(200)
  @UseInterceptors(LockoutInterceptor)
  async login(@Body() dto: LoginDto, @Req() req: HttpRequestLike, @Res({ passthrough: true }) res: HttpResponseLike): Promise<TokenResponse> {
    return this.respondWithSession(await this.loginUseCase.execute(dto, attemptContext(req)), res);
  }

  /**
   * Público porque la credencial es la propia cookie: el access token puede (y suele) estar
   * vencido justo cuando se llama. SameSite=Strict es lo que impide que otro sitio la dispare.
   */
  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(@Req() req: HttpRequestLike, @Res({ passthrough: true }) res: HttpResponseLike): Promise<TokenResponse> {
    return this.respondWithSession(await this.refreshUseCase.execute(readRefreshCookie(req)), res);
  }

  /** Idempotente: 204 aunque la cookie ya no sirva. Siempre se limpia la cookie del navegador. */
  @Post('logout')
  @Public()
  @HttpCode(204)
  async logout(@Req() req: HttpRequestLike, @Res({ passthrough: true }) res: HttpResponseLike): Promise<void> {
    await this.logoutUseCase.execute(readRefreshCookie(req));
    clearRefreshCookie(res, this.cookieSecure);
  }

  /**
   * Sin @RequirePermissions a propósito: no necesita ningún permiso, solo un access token válido.
   * El JwtAuthGuard global ya niega por defecto a quien no lo traiga.
   */
  @Get('userinfo')
  userinfo(@CurrentUser() user: AuthenticatedUser): Promise<UserInfoView> {
    return this.userInfo.execute({
      id: user.id,
      email: user.email,
      roles: user.roles,
      permissions: user.permissions as Permission[],
      sessionId: user.sessionId,
    });
  }

  private respondWithSession(result: LoginResult, res: HttpResponseLike): TokenResponse {
    setRefreshCookie(res, result.refreshToken, result.refreshExpiresAt, this.cookieSecure);
    return { accessToken: result.accessToken, tokenType: 'Bearer', expiresIn: result.expiresIn, user: result.user };
  }
}

/** Alta de cuentas: solo un administrador (users:write). El gateway rutea /api/v1/accounts aquí. */
@Controller('api/v1/accounts')
export class AccountsController {
  constructor(private readonly createAccount: CreateAccountUseCase) {}

  @Post()
  @RequirePermissions('users:write')
  create(@Body() dto: CreateAccountDto, @CurrentUser() user: AuthenticatedUser): Promise<AccountView> {
    const actor: Actor = { id: user.id, type: 'user' };
    return this.createAccount.execute(dto, actor);
  }
}

/**
 * Metadatos públicos del emisor. Son públicos a propósito: los otros servicios (y el gateway)
 * descargan el JWKS para validar tokens sin preguntarle nada a auth en cada request.
 */
@Controller('.well-known')
export class DiscoveryController {
  constructor(
    private readonly discovery: DiscoveryQuery,
    private readonly jwksQuery: JwksQuery,
  ) {}

  @Get('openid-configuration')
  @Public()
  configuration(): Record<string, unknown> {
    return this.discovery.execute();
  }

  @Get('jwks.json')
  @Public()
  jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    return this.jwksQuery.execute();
  }
}
