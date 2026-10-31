import { BadRequestException, ValidationPipe, type ValidationError } from '@nestjs/common';

/** Convierte los errores anidados de class-validator a { "campo.sub": ["mensaje", …] }. */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const error of errors) {
    const path = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) result[path] = Object.values(error.constraints);
    if (error.children?.length) Object.assign(result, flattenValidationErrors(error.children, path));
  }
  return result;
}

/**
 * Validación de entrada (OWASP A03): whitelist + forbidNonWhitelisted rechazan campos que el
 * DTO no declara (evita mass assignment); transform convierte al tipo del DTO.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) =>
      new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'La solicitud tiene campos inválidos',
        fieldErrors: flattenValidationErrors(errors),
      }),
  });
}
