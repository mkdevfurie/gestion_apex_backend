import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Les migrations passent par la connexion DIRECTE de Neon (sans pooler).
// L'application, elle, utilise DATABASE_URL (pooler) via l'adaptateur Neon.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'],
  },
});
