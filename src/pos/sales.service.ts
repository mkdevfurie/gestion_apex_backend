import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { InsufficientStockError, applyMovement } from '../stock/apply-movement.js';
import {
  can,
  computeInvoiceTotals,
  formatXof,
  settlePayments,
  type AuthUser,
  type PaymentMethod,
  type SaleInput,
  type SaleReceipt,
} from '../shared/index.js';

type Tx = Prisma.TransactionClient;

/** Incrémente un compteur sans trou ; la ligne reste verrouillée jusqu'à la fin de la transaction. */
async function nextValue(tx: Tx, key: string): Promise<number> {
  await tx.$executeRaw`INSERT INTO "DocumentSequence" (key, "lastValue") VALUES (${key}, 0) ON CONFLICT (key) DO NOTHING`;
  const rows = await tx.$queryRaw<{ lastValue: number }[]>`
    UPDATE "DocumentSequence" SET "lastValue" = "lastValue" + 1 WHERE key = ${key} RETURNING "lastValue"`;
  return rows[0].lastValue;
}

const receiptInclude = {
  lines: { orderBy: { position: 'asc' }, include: { product: { select: { sku: true, unit: true } } } },
  payments: { orderBy: { receivedAt: 'asc' } },
  user: { select: { name: true } },
  warehouse: { select: { code: true, name: true } },
} satisfies Prisma.InvoiceInclude;

@Injectable()
export class SalesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Vente comptoir (ticket). Tout ou rien, dans une seule transaction :
   * numéro sans trou, empreinte chaînée, lignes, sorties de stock, règlements.
   */
  async create(input: SaleInput, user: AuthUser): Promise<SaleReceipt> {
    // Rejeu (double clic, réseau) : on renvoie le ticket déjà émis.
    const replay = await this.prisma.invoice.findUnique({
      where: { clientRequestId: input.clientRequestId },
      select: { id: true, userId: true },
    });
    if (replay) {
      if (replay.userId !== user.id) throw new ConflictException('Identifiant de requête déjà utilisé');
      return this.receipt(replay.id);
    }

    if (input.lines.some((l) => l.discountRate > 0) && !can(user.role, 'grantDiscount')) {
      throw new ForbiddenException('Seul un gérant peut accorder une remise');
    }

    const session = await this.prisma.cashSession.findFirst({
      where: { openedById: user.id, closedAt: null },
      select: { id: true, warehouseId: true },
    });
    if (!session) throw new ConflictException('Ouvrez votre caisse avant d’encaisser');

    // Prix et TVA de la base : le client n'envoie que les quantités.
    const ids = [...new Set(input.lines.map((l) => l.productId))];
    const products = await this.prisma.product.findMany({ where: { id: { in: ids }, active: true } });
    const byId = new Map(products.map((p) => [p.id, p]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new NotFoundException('Article introuvable ou désactivé');

    const lines = input.lines.map((l) => {
      const p = byId.get(l.productId)!;
      return { ...l, product: p, unitPrice: p.salePrice, vatRate: p.vatRate.toNumber() };
    });
    const totals = computeInvoiceTotals(lines);
    if (totals.total <= 0) throw new BadRequestException('Le total du ticket doit être positif');

    const settlement = settlePayments(totals.total, input.payments);
    if (!settlement.ok) {
      throw new BadRequestException(
        settlement.remaining > 0 ? `${settlement.error} : il manque ${formatXof(settlement.remaining)}` : settlement.error,
      );
    }

    try {
      const id = await this.prisma.$transaction(
        async (tx) => {
          // 1. Chaîne d'empreintes globale, puis numéro annuel : verrous dans cet ordre, toujours.
          //    L'heure est prise APRÈS le verrou : elle suit l'ordre de la chaîne.
          const chainIndex = await nextValue(tx, 'CHAIN');
          const issuedAt = new Date();
          const seq = await nextValue(tx, `TKT-${issuedAt.getFullYear()}`);
          const number = `TKT-${issuedAt.getFullYear()}-${String(seq).padStart(6, '0')}`;
          const previous =
            chainIndex > 1
              ? await tx.invoice.findUnique({ where: { chainIndex: chainIndex - 1 }, select: { hash: true } })
              : null;
          if (chainIndex > 1 && !previous?.hash) {
            throw new Error(`Chaîne d'empreintes incohérente : maillon ${chainIndex - 1} introuvable`);
          }
          const previousHash = previous?.hash ?? null;
          const hash = createHash('sha256')
            .update(
              JSON.stringify({
                previousHash,
                chainIndex,
                number,
                issuedAt: issuedAt.toISOString(),
                total: totals.total,
                lines: lines.map((l, i) => [l.product.sku, l.quantity, l.unitPrice, l.discountRate, l.vatRate, totals.lineTotals[i]]),
                payments: settlement.applied.map((p) => [p.method, p.amount]),
              }),
            )
            .digest('hex');

          // 2. Le ticket et ses lignes (désignation figée).
          const invoice = await tx.invoice.create({
            data: {
              kind: 'TICKET',
              status: 'ISSUED',
              number,
              issuedAt,
              warehouseId: session.warehouseId,
              userId: user.id,
              cashSessionId: session.id,
              clientRequestId: input.clientRequestId,
              subtotal: totals.subtotal,
              discount: totals.discount,
              vatTotal: totals.vatTotal,
              total: totals.total,
              hash,
              previousHash,
              chainIndex,
              cashTendered: settlement.cashTendered || null,
              changeGiven: settlement.cashTendered ? settlement.change : null,
              lines: {
                create: lines.map((l, i) => ({
                  productId: l.productId,
                  description: l.product.name,
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                  discountRate: l.discountRate,
                  vatRate: l.vatRate,
                  lineTotal: totals.lineTotals[i],
                  position: i + 1,
                })),
              },
            },
          });

          // 3. Sorties de stock, articles triés (ordre de verrouillage stable).
          const ordered = [...lines].sort((a, b) => a.productId.localeCompare(b.productId));
          for (const l of ordered) {
            try {
              await applyMovement(tx, {
                type: 'SALE',
                productId: l.productId,
                warehouseId: session.warehouseId,
                quantity: l.quantity,
                reason: number,
                userId: user.id,
                invoiceId: invoice.id,
              });
            } catch (e) {
              if (e instanceof InsufficientStockError) {
                throw new ConflictException(
                  `Stock insuffisant pour « ${l.product.name} » : ${e.available} ${l.product.unit} disponible(s)`,
                );
              }
              throw e;
            }
          }

          // 4. Règlements imputés.
          await tx.payment.createMany({
            data: settlement.applied.map((p) => ({
              direction: 'IN' as const,
              method: p.method,
              amount: p.amount,
              reference: p.reference,
              invoiceId: invoice.id,
              cashSessionId: session.id,
              userId: user.id,
            })),
          });

          await tx.auditLog.create({
            data: {
              userId: user.id,
              action: 'sale.issue',
              entity: 'Invoice',
              entityId: invoice.id,
              data: { number, total: totals.total },
            },
          });
          return invoice.id;
        },
        { maxWait: 10_000, timeout: 20_000 },
      );
      return this.receipt(id);
    } catch (e) {
      // Deux envois simultanés du même panier : le second renvoie le ticket du premier.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.invoice.findUnique({
          where: { clientRequestId: input.clientRequestId },
          select: { id: true },
        });
        if (existing) return this.receipt(existing.id);
      }
      throw e;
    }
  }

  async receipt(id: string): Promise<SaleReceipt> {
    const [inv, company] = await Promise.all([
      this.prisma.invoice.findUnique({ where: { id }, include: receiptInclude }),
      this.prisma.company.findUnique({ where: { id: 1 } }),
    ]);
    if (!inv || !inv.number || !inv.issuedAt) throw new NotFoundException('Ticket introuvable');

    const lines = inv.lines.map((l) => ({
      sku: l.product?.sku ?? null,
      description: l.description,
      unit: l.product?.unit ?? null,
      quantity: l.quantity.toNumber(),
      unitPrice: l.unitPrice,
      discountRate: l.discountRate.toNumber(),
      vatRate: l.vatRate.toNumber(),
      lineTotal: l.lineTotal,
    }));
    // Ventilation TVA recalculée par la même fonction que lors de l'émission.
    const { vat } = computeInvoiceTotals(lines, inv.discount);

    return {
      id: inv.id,
      number: inv.number,
      issuedAt: inv.issuedAt.toISOString(),
      cashier: inv.user.name,
      warehouse: inv.warehouse,
      company: {
        name: company?.name ?? 'Apex Ledger',
        legalForm: company?.legalForm ?? null,
        address: company?.address ?? null,
        phone: company?.phone ?? null,
        ninea: company?.ninea ?? null,
        rccm: company?.rccm ?? null,
      },
      lines,
      itemCount: Math.round(lines.reduce((a, l) => a + l.quantity, 0) * 1000) / 1000,
      subtotal: inv.subtotal,
      discount: inv.discount,
      vat,
      vatTotal: inv.vatTotal,
      total: inv.total,
      payments: inv.payments.map((p) => ({ method: p.method as PaymentMethod, amount: p.amount, reference: p.reference })),
      cashTendered: inv.cashTendered,
      change: inv.changeGiven,
      hash: inv.hash ?? '',
    };
  }

  /** Tickets d'une session (les plus récents d'abord). */
  async listForSession(sessionId: string) {
    const rows = await this.prisma.invoice.findMany({
      where: { cashSessionId: sessionId, kind: 'TICKET', status: 'ISSUED' },
      orderBy: { issuedAt: 'desc' },
      take: 50,
      select: { id: true, number: true, issuedAt: true, total: true, payments: { select: { method: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      number: r.number!,
      issuedAt: r.issuedAt!.toISOString(),
      total: r.total,
      methods: [...new Set(r.payments.map((p) => p.method as PaymentMethod))],
    }));
  }
}
