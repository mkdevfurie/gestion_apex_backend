import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Pilote Postgres classique (TCP) : adapté à un serveur permanent (Render).
 *
 * Neon met la base en veille après quelques minutes d'inactivité et coupe alors
 * les connexions. On les libère nous-mêmes avant (idleTimeoutMillis), pour ne
 * jamais réutiliser une connexion morte au réveil.
 */
export function createAdapter(connectionString: string) {
  return new PrismaPg({
    connectionString,
    max: 10,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 15_000, // réveil de Neon
    keepAlive: true,
  });
}
