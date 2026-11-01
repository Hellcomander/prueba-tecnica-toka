import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { type Actor, SCOPES, type UserAuthorization } from '@toka/contracts';
import { type AuthenticatedUser, CurrentUser, InternalRoute, RequirePermissions } from '@toka/nest-common';
import { CreateRoleUseCase } from '../../application/commands/create-role.use-case';
import { DeleteRoleUseCase } from '../../application/commands/delete-role.use-case';
import { ReplaceUserRolesUseCase } from '../../application/commands/replace-user-roles.use-case';
import { UpdateRoleUseCase } from '../../application/commands/update-role.use-case';
import type { RoleView, UserRolesView } from '../../application/mappers/views';
import { GetAuthorizationQuery, GetRoleQuery, GetUserRolesQuery, ListPermissionsQuery, ListRolesQuery } from '../../application/queries/role-queries';
import { CreateRoleDto, ReplaceUserRolesDto, UpdateRoleDto } from './dto/role.dto';

const actorOf = (user: AuthenticatedUser): Actor => ({ id: user.id, type: 'user' });
const uuid = new ParseUUIDPipe({ version: undefined });

/** Controllers delgados: traducen HTTP ↔ caso de uso. Los permisos se declaran por ruta. */
@Controller('api/v1/roles')
export class RolesController {
  constructor(
    private readonly listRoles: ListRolesQuery,
    private readonly getRole: GetRoleQuery,
    private readonly createRole: CreateRoleUseCase,
    private readonly updateRole: UpdateRoleUseCase,
    private readonly deleteRole: DeleteRoleUseCase,
  ) {}

  @Get()
  @RequirePermissions('roles:read')
  list(): Promise<RoleView[]> {
    return this.listRoles.execute();
  }

  @Get(':id')
  @RequirePermissions('roles:read')
  get(@Param('id', uuid) id: string): Promise<RoleView> {
    return this.getRole.execute(id);
  }

  @Post()
  @RequirePermissions('roles:write')
  create(@Body() dto: CreateRoleDto, @CurrentUser() user: AuthenticatedUser): Promise<RoleView> {
    return this.createRole.execute(dto, actorOf(user));
  }

  @Patch(':id')
  @RequirePermissions('roles:write')
  update(@Param('id', uuid) id: string, @Body() dto: UpdateRoleDto, @CurrentUser() user: AuthenticatedUser): Promise<RoleView> {
    return this.updateRole.execute(id, dto, actorOf(user));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('roles:write')
  remove(@Param('id', uuid) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.deleteRole.execute(id, actorOf(user));
  }
}

@Controller('api/v1/permissions')
export class PermissionsController {
  constructor(private readonly listPermissions: ListPermissionsQuery) {}

  @Get()
  @RequirePermissions('roles:read')
  list(): { code: string; description: string }[] {
    return this.listPermissions.execute();
  }
}

@Controller('api/v1/user-roles')
export class UserRolesController {
  constructor(
    private readonly getUserRoles: GetUserRolesQuery,
    private readonly replaceUserRoles: ReplaceUserRolesUseCase,
  ) {}

  @Get(':userId')
  @RequirePermissions('roles:read')
  get(@Param('userId', uuid) userId: string): Promise<UserRolesView> {
    return this.getUserRoles.execute(userId);
  }

  @Put(':userId')
  @RequirePermissions('roles:assign')
  replace(@Param('userId', uuid) userId: string, @Body() dto: ReplaceUserRolesDto, @CurrentUser() user: AuthenticatedUser): Promise<UserRolesView> {
    return this.replaceUserRoles.execute(userId, dto, actorOf(user));
  }
}

/** S1: solo para auth-service, con token de servicio (scope authz:read). El gateway da 404 a /internal/*. */
@Controller('internal/v1/authorizations')
export class InternalAuthorizationsController {
  constructor(private readonly getAuthorization: GetAuthorizationQuery) {}

  @Get(':userId')
  @InternalRoute(SCOPES.AUTHZ_READ)
  get(@Param('userId', uuid) userId: string): Promise<UserAuthorization> {
    return this.getAuthorization.execute(userId);
  }
}
