import { defineConfig } from 'prisma/config';

// DATABASE_URL solo hace falta para migrate/introspección; `prisma generate` no se conecta.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
