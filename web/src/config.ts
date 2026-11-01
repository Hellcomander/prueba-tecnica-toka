/**
 * `real` habla con el backend a través del gateway; `mock` resuelve el login en el navegador
 * con los usuarios semilla, para poder ver la interfaz sin levantar el stack.
 *
 * El default es `real`: con `docker compose up` los cinco servicios están ahí, y una UI que no
 * hablara con ellos sería engañosa. El modo demo se pide explícitamente con VITE_API_MODE=mock.
 */
export const API_MODE: 'mock' | 'real' =
  typeof __API_MODE__ === 'undefined' ? 'real' : __API_MODE__;
