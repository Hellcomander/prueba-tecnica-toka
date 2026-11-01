import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * El tope de 1000 caracteres está también en el value object `Question`. No es duplicación por
 * descuido: el DTO rechaza la forma antes de construir nada (y antes de pagar un token), y el
 * dominio garantiza la invariante aunque mañana lo llame otro adaptador que no sea HTTP.
 */
export class AskQuestionDto {
  @Transform(trim)
  @IsString()
  @Length(3, 1_000)
  question!: string;

  @IsOptional()
  @IsBoolean()
  useCache?: boolean;
}
