import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * DTOs = contrato de entrada. Aquí vive la validación de forma; la política de contraseña (fuerza
 * mínima) es una regla de negocio y vive en el dominio (value object Password).
 */
export class LoginDto {
  @Transform(trim)
  @IsEmail({}, { message: 'email: debe ser un correo válido' })
  @Length(3, 254)
  email!: string;

  /** No se exige fuerza al iniciar sesión (la contraseña puede ser vieja), pero sí un tope: argon2 sobre una entrada enorme es un DoS barato. */
  @IsString()
  @Length(1, 128)
  password!: string;
}

export class CreateAccountDto {
  @Transform(trim)
  @IsEmail({}, { message: 'email: debe ser un correo válido' })
  @Length(3, 254)
  email!: string;

  @IsString()
  @Length(10, 128, { message: 'password: entre 10 y 128 caracteres' })
  password!: string;

  /** auth no guarda el perfil: lo publica en `account.registered` para user-service. */
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  fullName!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 80)
  department?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 80)
  jobTitle?: string;
}
