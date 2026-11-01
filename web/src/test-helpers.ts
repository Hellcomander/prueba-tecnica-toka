import { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import type { ProblemDetails } from '@toka/contracts/http';

/**
 * Error del backend tal como lo ve la SPA: un AxiosError con un cuerpo RFC 9457. Se construye
 * con la clase real de axios para que `axios.isAxiosError` lo reconozca, que es de lo que
 * dependen `problemMessage` y `problemCode`; un objeto suelto pasaría por error inesperado y
 * los tests no probarían nada.
 */
export function problemError(status: number, body: Partial<ProblemDetails>): AxiosError<ProblemDetails> {
  const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  const data: ProblemDetails = {
    type: 'urn:toka:problem:test',
    title: status >= 500 ? 'Error' : 'Conflicto',
    status,
    code: 'UNKNOWN',
    ...body,
  };
  const response: AxiosResponse<ProblemDetails> = {
    data,
    status,
    statusText: '',
    headers: new AxiosHeaders(),
    config,
  };
  return new AxiosError<ProblemDetails>('request failed', String(status), config, null, response);
}
