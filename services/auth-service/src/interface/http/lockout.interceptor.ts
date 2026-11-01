import { type CallHandler, type ExecutionContext, HttpException, HttpStatus, Injectable, type NestInterceptor } from '@nestjs/common';
import { catchError, type Observable, throwError } from 'rxjs';
import { TooManyAttemptsError } from '../../domain/shared/domain-error';

/**
 * Traduce el lockout del dominio al 429 + Retry-After de HTTP. Vive en la capa de interfaz a
 * propósito: el caso de uso no sabe de códigos HTTP, solo de "este intento está bloqueado hasta
 * dentro de N segundos". El filtro de nest-common convierte esta HttpException en problem+json,
 * y el header Retry-After sale de `retryAfterSeconds`.
 */
@Injectable()
export class LockoutInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TooManyAttemptsError
            ? new HttpException(
                { code: error.code, message: error.message, retryAfterSeconds: error.retryAfterSeconds },
                HttpStatus.TOO_MANY_REQUESTS,
              )
            : error,
        ),
      ),
    );
  }
}
