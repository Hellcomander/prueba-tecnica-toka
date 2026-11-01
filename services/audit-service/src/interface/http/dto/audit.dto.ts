import { Transform, Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { AUDIT_CATEGORIES, MAX_PAGE_SIZE } from '../../../application/audit-queries';

// La validación corre después del Transform: una cadena que no es fecha queda como Invalid Date y IsDate la rechaza.
const toDate = ({ value }: { value: unknown }) => (typeof value === 'string' ? new Date(value) : value);

/** Parámetros de consulta de `GET /audit/events`. `from` y `to` se convierten a `Date`. */
export class ListAuditEventsDto {
  @IsOptional()
  @Matches(/^[a-z]+(\.[a-z_]+)+$/, { message: 'type debe ser <contexto>.<evento>' })
  type?: string;

  @IsOptional()
  @IsIn(AUDIT_CATEGORIES, { message: `category debe ser una de: ${AUDIT_CATEGORIES.join(', ')}` })
  category?: (typeof AUDIT_CATEGORIES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  actorId?: string;

  @IsOptional()
  @Transform(toDate)
  @IsDate({ message: 'debe ser una fecha ISO 8601' })
  from?: Date;

  @IsOptional()
  @Transform(toDate)
  @IsDate({ message: 'debe ser una fecha ISO 8601' })
  to?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}
