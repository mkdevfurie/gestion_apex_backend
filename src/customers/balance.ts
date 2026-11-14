import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { can, formatXof, type AppSettings, type AuthUser } from '../shared/index.js';

type Tx = Prisma.TransactionClient;

/** Reste dû d'un client : factures et tickets émis non soldés. */
export async function customerBalance(tx: Tx, customerId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ due: unknown }[]>`
    SELECT COALESCE(SUM(total - "amountPaid"), 0) AS due FROM "Invoice"
    WHERE "customerId" = ${customerId} AND status = 'ISSUED' AND kind IN ('TICKET', 'INVOICE')`;
  return Number(rows[0]?.due ?? 0);
}

/**
 * Autorise une vente à crédit : droit de l'utilisateur, client actif,
 * plafond d'encours respecté. Verrouille la fiche client (FOR UPDATE) :
 * deux ventes à crédit simultanées ne peuvent pas dépasser le plafond ensemble.
 */
export async function assertCreditAllowed(tx: Tx, customerId: string, credit: number, user: AuthUser, settings: AppSettings) {
  const allowed = can(user.role, 'issueInvoices') || (user.role === 'CASHIER' && settings.cashierCanSellOnCredit);
  if (!allowed) throw new ForbiddenException('Votre rôle ne permet pas de vendre à crédit');
  const rows = await tx.$queryRaw<{ name: string; creditLimit: number; active: boolean }[]>`
    SELECT name, "creditLimit", active FROM "Customer" WHERE id = ${customerId} FOR UPDATE`;
  const c = rows[0];
  if (!c || !c.active) throw new NotFoundException('Client introuvable ou désactivé');
  if (c.creditLimit <= 0) throw new ConflictException(`${c.name} n’a pas de crédit autorisé (plafond à 0)`);
  const balance = await customerBalance(tx, customerId);
  if (balance + credit > c.creditLimit) {
    throw new ConflictException(
      `Plafond de crédit dépassé pour ${c.name} : encours ${formatXof(balance)} + ${formatXof(credit)} > plafond ${formatXof(c.creditLimit)}`,
    );
  }
}
