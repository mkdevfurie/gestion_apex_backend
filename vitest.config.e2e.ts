import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // ConfigModule valide l'env au chargement du module : valeur factice ici,
    // PrismaService est remplacé par un mock dans les tests.
    env: { DATABASE_URL: 'postgresql://test:test@localhost:5432/test' },
  },
});
