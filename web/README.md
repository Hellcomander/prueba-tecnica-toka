# Frontend

## Desarrollo local

Desde la raíz del monorepo:

```bash
npm run web:dev
```

Vite muestra la URL local al arrancar (por defecto `http://localhost:5173`). La aplicación usa
perfiles de demostración en modo mock: `admin@toka.local`, `auditor@toka.local` y
`viewer@toka.local`; acepta cualquier contraseña de al menos 8 caracteres.

## Con Docker

```bash
npm run up:web
```

Abre `http://localhost:8080`. Esto arranca el gateway y el contenedor estático de la SPA; no
levanta los servicios de backend que todavía no están implementados. La variable
`VITE_API_MODE=mock` se fija durante el build para que el demo funcione sin APIs. Para compilar la
SPA contra los servicios reales, configura `VITE_API_MODE=real` en `.env` y reconstruye las
imágenes.

Las pantallas de usuarios, roles, auditoría y asistente son placeholders por ahora. El login real
usa `POST /api/v1/auth/login`, y el cliente común intenta `POST /api/v1/auth/refresh` al recibir
un 401; los servicios correspondientes aún deben implementar esos endpoints y acordar el shape
de `LoginResult`.

## Contratos compartidos

Los permisos, descripciones, roles de sistema y perfiles demo se importan directamente desde
`packages/contracts/src/permissions.ts` y `packages/contracts/src/seed.ts`. Se usa la ruta de
fuente para evitar importar desde el barrel de contratos, que también exporta utilidades de
eventos con dependencias de Node. No se mantiene una copia local del catálogo de permisos.
