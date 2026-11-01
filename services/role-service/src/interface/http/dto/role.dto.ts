import { PERMISSIONS } from '@toka/contracts';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** DTOs = contrato de entrada. La validación de forma vive aquí; las reglas de negocio, en el dominio. */
export class CreateRoleDto {
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_-]{2,30}$/, { message: 'name: 3–31 caracteres, letras, números, - o _' })
  name!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 200)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PERMISSIONS.length)
  @IsIn(PERMISSIONS, { each: true, message: 'permiso inexistente' })
  permissions!: string[];
}

export class UpdateRoleDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9_-]{2,30}$/, { message: 'name: 3–31 caracteres, letras, números, - o _' })
  name?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 200)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PERMISSIONS.length)
  @IsIn(PERMISSIONS, { each: true, message: 'permiso inexistente' })
  permissions?: string[];
}

export class ReplaceUserRolesDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  roleIds!: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  assignmentsVersion?: number;
}
