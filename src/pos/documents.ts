import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

/** Incrémente un compteur sans trou ; la ligne reste verrouillée jusqu'à la fin de la transaction. */
export async function nextValue(tx: Tx, key: string): Promise<number> {
  await tx.$executeRaw`INSERT INTO "DocumentSequence" (key, "lastValue") VALUES (${key}, 0) ON CONFLICT (key) DO NOTHING`;
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    UPDATE "DocumentSequence" SET "lastValue" = "lastValue" + 1 WHERE key = ${key} RETURNING "lastValue"`;
  return rows[0].lastValue;
}

/** TKT-2026-000123, FAC-2026-000045, AVR-…, DEV-…, BR-… */
export async function nextNumber(tx: Tx, prefix: string, at: Date): Promise<string> {
  const year = at.getUTCFullYear();
  const n = await nextValue(tx, `${prefix}-${year}`);
  return `${prefix}-${year}-${String(n).padStart(6, '0')}`;
}

/** Codes de fiche : CLI-000001, FRN-000001. */
export async function nextCode(tx: Tx, prefix: string): Promise<string> {
  const n = await nextValue(tx, prefix);
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

export type HashPayload = {
  previousHash: string | null;
  chainIndex: number;
  number: string;
  issuedAt: string;
  total: number;
  lines: (string | number | null)[][];
  payments: (string | number)[][];
};

/** Ordre canonique des règlements dans l'empreinte (indépendant de l'ordre d'insertion). */
export const canonicalPayments = (payments: (string | number)[][]) =>
  [...payments].sort((a, b) => String(a[0]).localeCompare(String(b[0])) || Number(a[1]) - Number(b[1]));

export const hashOf = (p: HashPayload) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        previousHash: p.previousHash,
        chainIndex: p.chainIndex,
        number: p.number,
        issuedAt: p.issuedAt,
        total: p.total,
        lines: p.lines,
        payments: p.payments,
      }),
    )
    .digest('hex');

/**
 * Maillon de la chaîne d'empreintes des pièces fiscales (tickets, factures, avoirs).
 * Verrou global CHAIN pris EN PREMIER, puis le compteur du type de pièce : l'heure
 * d'émission est lue après le verrou et suit donc l'ordre de la chaîne.
 */
export async function openChainLink(tx: Tx, prefix: string) {
  const chainIndex = await nextValue(tx, 'CHAIN');
  const issuedAt = new Date();
  const number = await nextNumber(tx, prefix, issuedAt);
  const previous =
    chainIndex > 1 ? await tx.invoice.findUnique({ where: { chainIndex: chainIndex - 1 }, select: { hash: true } }) : null;
  if (chainIndex > 1 && !previous?.hash) {
    throw new Error(`Chaîne d'empreintes incohérente : maillon ${chainIndex - 1} introuvable`);
  }
  const previousHash = previous?.hash ?? null;
  return {
    chainIndex,
    issuedAt,
    number,
    previousHash,
    seal: (total: number, lines: HashPayload['lines'], payments: HashPayload['payments']) =>
      hashOf({ previousHash, chainIndex, number, issuedAt: issuedAt.toISOString(), total, lines, payments: canonicalPayments(payments) }),
  };
}
