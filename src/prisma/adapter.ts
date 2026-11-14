import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Pilote Postgres classique (TCP) : adapté à un serveur permanent (Render).
 *
 * Neon met la base en veille après quelques minutes d'inactivité et coupe alors
 * les connexions. On les libère nous-mêmes avant (idleTimeoutMillis), pour ne
 * jamais réutiliser une connexion morte au réveil.
 */
/**
 * Options communes du client Prisma : l'ouverture d'une transaction peut
 * attendre le réveil de Neon (2 s par défaut, trop court).
 */
export function prismaOptions(connectionString: string) {
  return {
    adapter: createAdapter(connectionString),
    transactionOptions: { maxWait: 10_000, timeout: 15_000 },
  };
}

export function createAdapter(connectionString: string) {
  return new PrismaPg({
    connectionString,
    max: 10,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 15_000, // réveil de Neon
    keepAlive: true,
  });
}
