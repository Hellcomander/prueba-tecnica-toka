import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Actor, Page } from '@toka/contracts';
import { type AuthenticatedUser, CurrentUser, RequirePermissions } from '@toka/nest-common';
import { ReactivateUserUseCase, SuspendUserUseCase } from '../../application/commands/change-status.use-case';
import { UpdateProfileUseCase } from '../../application/commands/update-profile.use-case';
import type { UserStats, UserView } from '../../application/queries/read-model';
import { GetUserQuery, GetUserStatsQuery, ListUsersQuery } from '../../application/queries/user-queries';
import { ChangeStatusDto, ListUsersQueryDto, UpdateMyProfileDto, UpdateUserDto } from './dto/user.dto';

const actorOf = (user: AuthenticatedUser): Actor => ({ id: user.id, type: 'user' });
const uuid = new ParseUUIDPipe({ version: undefined });
const DEFAULT_PAGE_SIZE = 20;

/**
 * Controller delgado: traduce HTTP ↔ caso de uso. Los permisos se declaran por ruta.
 * ORDEN IMPORTA: las rutas fijas (`me`, `stats`) van antes de `:id`; si no, Express 5 las
 * interpretaría como un id y ParseUUIDPipe respondería 400.
 */
@Controller('api/v1/users')
export class UsersController {
  constructor(
    private readonly listUsers: ListUsersQuery,
    private readonly getUser: GetUserQuery,
    private readonly getStats: GetUserStatsQuery,
    private readonly updateProfile: UpdateProfileUseCase,
    private readonly suspendUser: SuspendUserUseCase,
    private readonly reactivateUser: ReactivateUserUseCase,
  ) {}

  @Get()
  @RequirePermissions('users:read')
  list(@Query() query: ListUsersQueryDto): Promise<Page<UserView>> {
    return this.listUsers.execute({
      search: query.search || undefined,
      status: query.status,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? DEFAULT_PAGE_SIZE,
    });
  }

  /** Cualquier usuario autenticado puede ver y editar SU perfil: sin permiso extra (lista vacía a propósito). */
  @Get('me')
  @RequirePermissions()
  me(@CurrentUser() user: AuthenticatedUser): Promise<UserView> {
    return this.getUser.execute(user.id);
  }

  @Patch('me')
  @RequirePermissions()
  updateMe(@Body() dto: UpdateMyProfileDto, @CurrentUser() user: AuthenticatedUser): Promise<UserView> {
    return this.updateProfile.execute(user.id, dto, actorOf(user));
  }

  @Get('stats')
  @RequirePermissions('users:read')
  stats(): Promise<UserStats> {
    return this.getStats.execute();
  }

  @Get(':id')
  @RequirePermissions('users:read')
  get(@Param('id', uuid) id: string): Promise<UserView> {
    return this.getUser.execute(id);
  }

  @Patch(':id')
  @RequirePermissions('users:write')
  update(@Param('id', uuid) id: string, @Body() dto: UpdateUserDto, @CurrentUser() user: AuthenticatedUser): Promise<UserView> {
    return this.updateProfile.execute(id, dto, actorOf(user));
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermissions('users:write')
  suspend(@Param('id', uuid) id: string, @Body() dto: ChangeStatusDto, @CurrentUser() user: AuthenticatedUser): Promise<UserView> {
    return this.suspendUser.execute(id, dto, actorOf(user));
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions('users:write')
  reactivate(@Param('id', uuid) id: string, @Body() dto: ChangeStatusDto, @CurrentUser() user: AuthenticatedUser): Promise<UserView> {
    return this.reactivateUser.execute(id, dto, actorOf(user));
  }
}
