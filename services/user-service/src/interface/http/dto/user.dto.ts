import { USER_STATUSES, type UserStatus } from '@toka/contracts';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** DTOs = contrato de entrada. La validación de forma vive aquí; las reglas de negocio, en el dominio. */
export class ListUsersQueryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(upper)
  @IsIn(USER_STATUSES, { message: 'status debe ser ACTIVE o SUSPENDED' })
  status?: UserStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

/** Campos editables del perfil. `department` y `jobTitle` aceptan null o "" para borrar el valor. */
class ProfileFieldsDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  fullName?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  department?: string | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(80)
  jobTitle?: string | null;
}

/** Edición del propio perfil: la versión es opcional (nadie compite con uno mismo, salvo dos pestañas). */
export class UpdateMyProfileDto extends ProfileFieldsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

/** Edición de otro usuario por un admin: la versión es obligatoria (bloqueo optimista). */
export class UpdateUserDto extends ProfileFieldsDto {
  @IsInt()
  @Min(1)
  version!: number;
}

export class ChangeStatusDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  reason?: string;
}
