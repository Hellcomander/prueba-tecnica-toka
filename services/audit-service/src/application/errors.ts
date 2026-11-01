/**
 * Error de entrada inválida con la forma que reconoce el filtro HTTP de nest-common
 * (`code` + `kind`), sin importar el paquete: la capa application solo depende de contratos.
 */
export class InvalidQueryError extends Error {
  readonly kind = 'validation' as const;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidQueryError';
  }
}
