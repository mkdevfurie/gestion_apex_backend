import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { assertCreditAllowed } from '../customers/balance.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { InsufficientStockError, applyMovement } from '../stock/apply-movement.js';
import {
  can,
  computeInvoiceTotals,
  formatXof,
  MAX_AMOUNT,
  settlePayments,
  type AuthUser,
  type PaymentMethod,
  type SaleInput,
  type SaleReceipt,
} from '../shared/index.js';
import { openChainLink } from './documents.js';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

const receiptInclude = {
  lines: { orderBy: { position: 'asc' }, include: { product: { select: { sku: true, unit: true } } } },
  payments: { orderBy: { receivedAt: 'asc' } },
  user: { select: { name: true } },
  warehouse: { select: { code: true, name: true } },
  customer: { select: { id: true, code: true, name: true } },
} satisfies Prisma.InvoiceInclude;

/** Lignes d'une vente : prix et TVA lus en base. */
export type PricedLine = {
  productId: string;
  quantity: number;
  discountRate: number;
  unitPrice: number;
  vatRate: number;
  product: { sku: string; name: string; unit: string };
};

/**
 * Écrit une pièce de vente émise (ticket ou facture) dans une transaction déjà
 * ouverte : maillon de chaîne, lignes, sorties de stock, règlements, audit.
 * Partagé par la caisse, la facture directe et la conversion de devis.
 */
export async function writeSale(
  tx: Tx,
  args: {
    kind: 'TICKET' | 'INVOICE';
    lines: PricedLine[];
    payments: { method: PaymentMethod; amount: number; reference?: string }[];
    warehouseId: string;
    userId: string;
    customerId?: string;
    cashSessionId?: string;
    clientRequestId?: string;
    cashTendered?: number;
    change?: number;
    credit: number;
    paymentTermDays: number;
    sourceId?: string;
    notes?: string | null;
  },
) {
  const totals = computeInvoiceTotals(args.lines);
  const link = await openChainLink(tx, args.kind === 'TICKET' ? 'TKT' : 'FAC');
  const paid = args.payments.reduce((a, p) => a + p.amount, 0);
  const hash = link.seal(
    totals.total,
    args.lines.map((l, i) => [l.product.sku, l.quantity, l.unitPrice, l.discountRate, l.vatRate, totals.lineTotals[i]]),
    args.payments.map((p) => [p.method, p.amount]),
  );

  const invoice = await tx.invoice.create({
    data: {
      kind: args.kind,
      status: 'ISSUED',
      number: link.number,
      issuedAt: link.issuedAt,
      dueDate: args.credit > 0 ? new Date(link.issuedAt.getTime() + args.paymentTermDays * DAY) : null,
      warehouseId: args.warehouseId,
      userId: args.userId,
      customerId: args.customerId,
      cashSessionId: args.cashSessionId,
      clientRequestId: args.clientRequestId,
      sourceId: args.sourceId,
      notes: args.notes ?? null,
      subtotal: totals.subtotal,
      discount: totals.discount,
      vatTotal: totals.vatTotal,
      total: totals.total,
      amountPaid: paid,
      hash,
      previousHash: link.previousHash,
      chainIndex: link.chainIndex,
      cashTendered: args.cashTendered || null,
      changeGiven: args.cashTendered ? (args.change ?? 0) : null,
      lines: {
        create: args.lines.map((l, i) => ({
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

  // Sorties de stock, articles triés (ordre de verrouillage stable entre transactions).
  for (const l of [...args.lines].sort((a, b) => a.productId.localeCompare(b.productId))) {
    try {
      await applyMovement(tx, {
        type: 'SALE',
        productId: l.productId,
        warehouseId: args.warehouseId,
        quantity: l.quantity,
        reason: link.number,
        userId: args.userId,
        invoiceId: invoice.id,
      });
    } catch (e) {
      if (e instanceof InsufficientStockError) {
        throw new ConflictException(`Stock insuffisant pour « ${l.product.name} » : ${e.available} ${l.product.unit} disponible(s)`);
      }
      throw e;
    }
  }

  if (args.payments.length) {
    await tx.payment.createMany({
      data: args.payments.map((p) => ({
        direction: 'IN' as const,
        method: p.method,
        amount: p.amount,
        reference: p.reference,
        invoiceId: invoice.id,
        // Seules les espèces passent par le tiroir-caisse.
        cashSessionId: p.method === 'CASH' ? args.cashSessionId : undefined,
        userId: args.userId,
        atIssue: true,
      })),
    });
  }

  await tx.auditLog.create({
    data: {
      userId: args.userId,
      action: args.credit > 0 ? 'sale.credit' : args.kind === 'INVOICE' ? 'invoice.issue' : 'sale.issue',
      entity: 'Invoice',
      entityId: invoice.id,
      data: { number: link.number, total: totals.total, credit: args.credit, customerId: args.customerId ?? null },
    },
  });
  return invoice;
}

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Lit les articles et fixe prix / TVA depuis la base. */
  async priceLines(lines: { productId: string; quantity: number; discountRate: number }[], user: AuthUser): Promise<PricedLine[]> {
    if (lines.some((l) => l.discountRate > 0) && !can(user.role, 'grantDiscount')) {
      throw new ForbiddenException('Seul un gérant peut accorder une remise');
    }
    const { maxDiscountRate } = await this.settings.get();
    if (lines.some((l) => l.discountRate > maxDiscountRate)) {
      throw new BadRequestException(`Remise maximale autorisée : ${maxDiscountRate} %`);
    }
    const ids = [...new Set(lines.map((l) => l.productId))];
    const products = await this.prisma.product.findMany({ where: { id: { in: ids }, active: true } });
    const byId = new Map(products.map((p) => [p.id, p]));
    if (ids.some((id) => !byId.has(id))) throw new NotFoundException('Article introuvable ou désactivé');
    return lines.map((l) => {
      const p = byId.get(l.productId)!;
      return { ...l, unitPrice: p.salePrice, vatRate: p.vatRate.toNumber(), product: { sku: p.sku, name: p.name, unit: p.unit } };
    });
  }

  /**
   * Vente comptoir (ticket) ou facture directe. Tout ou rien, dans une seule
   * transaction : numéro sans trou, empreinte chaînée, lignes, stock, règlements.
   */
  async create(input: SaleInput, user: AuthUser): Promise<SaleReceipt> {
    // Rejeu (double clic, réseau, file hors ligne) : on renvoie la pièce déjà émise.
    const replay = await this.prisma.invoice.findUnique({
      where: { clientRequestId: input.clientRequestId },
      select: { id: true, userId: true },
    });
    if (replay) {
      if (replay.userId !== user.id) throw new ConflictException('Identifiant de requête déjà utilisé');
      return this.receipt(replay.id);
    }

    if ((input.credit || input.kind === 'INVOICE') && !input.customerId) {
      throw new BadRequestException(input.credit ? 'Choisissez le client pour une vente à crédit' : 'Une facture exige un client');
    }
    if (input.kind === 'INVOICE' && !can(user.role, 'issueInvoices')) {
      throw new ForbiddenException('Seul un gérant peut émettre une facture');
    }

    const session = await this.prisma.cashSession.findFirst({
      where: { openedById: user.id, closedAt: null },
      select: { id: true, warehouseId: true },
    });
    const hasCash = input.payments.some((p) => p.method === 'CASH');
    if (input.kind === 'TICKET' && !session) throw new ConflictException('Ouvrez votre caisse avant d’encaisser');
    if (hasCash && !session) throw new ConflictException('Ouvrez votre caisse pour encaisser des espèces');
    const warehouseId = session?.warehouseId ?? input.warehouseId;
    if (!warehouseId) throw new BadRequestException('Précisez le dépôt de sortie');

    const settings = await this.settings.get();
    const lines = await this.priceLines(input.lines, user);
    const totals = computeInvoiceTotals(lines);
    if (totals.total <= 0) throw new BadRequestException('Le total doit être positif');
    if (totals.total > MAX_AMOUNT || totals.lineTotals.some((t) => t > MAX_AMOUNT)) {
      throw new BadRequestException('Montant trop élevé pour une seule pièce');
    }

    const settlement = settlePayments(totals.total, input.payments, input.credit);
    if (!settlement.ok) {
      throw new BadRequestException(
        settlement.remaining > 0 ? `${settlement.error} : il manque ${formatXof(settlement.remaining)}` : settlement.error,
      );
    }

    try {
      const id = await this.prisma.$transaction(
        async (tx) => {
          if (input.customerId) {
            const c = await tx.customer.findFirst({ where: { id: input.customerId, active: true }, select: { id: true } });
            if (!c) throw new NotFoundException('Client introuvable ou désactivé');
          }
          if (settlement.credit > 0) {
            await assertCreditAllowed(tx, input.customerId!, settlement.credit, user, settings);
          }
          const w = await tx.warehouse.findFirst({ where: { id: warehouseId, active: true }, select: { id: true } });
          if (!w) throw new NotFoundException('Dépôt introuvable ou inactif');
          const inv = await writeSale(tx, {
            kind: input.kind,
            lines,
            payments: settlement.applied,
            warehouseId,
            userId: user.id,
            customerId: input.customerId,
            cashSessionId: session?.id,
            clientRequestId: input.clientRequestId,
            cashTendered: settlement.cashTendered,
            change: settlement.change,
            credit: settlement.credit,
            paymentTermDays: settings.paymentTermDays,
          });
          return inv.id;
        },
        { maxWait: 10_000, timeout: 20_000 },
      );
      return this.receipt(id);
    } catch (e) {
      // Deux envois simultanés du même panier : le second renvoie la pièce du premier.
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
    const [inv, company, settings] = await Promise.all([
      this.prisma.invoice.findUnique({ where: { id }, include: receiptInclude }),
      this.prisma.company.findUnique({ where: { id: 1 } }),
      this.settings.get(),
    ]);
    if (!inv || !inv.number || !inv.issuedAt || (inv.kind !== 'TICKET' && inv.kind !== 'INVOICE')) {
      throw new NotFoundException('Ticket introuvable');
    }

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
    const { vat } = computeInvoiceTotals(lines, inv.discount);

    return {
      id: inv.id,
      kind: inv.kind,
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
      payments: inv.payments
        .filter((p) => p.direction === 'IN' && p.method !== 'CREDIT_NOTE')
        .map((p) => ({ method: p.method as PaymentMethod, amount: p.amount, reference: p.reference })),
      cashTendered: inv.cashTendered,
      change: inv.changeGiven,
      hash: inv.hash ?? '',
      footer: settings.receiptFooter,
      customer: inv.customer,
      balanceDue: Math.max(0, inv.total - inv.amountPaid),
      dueDate: inv.dueDate?.toISOString() ?? null,
    };
  }

  /** Tickets d'une session (les plus récents d'abord). */
  async listForSession(sessionId: string) {
    const rows = await this.prisma.invoice.findMany({
      where: { cashSessionId: sessionId, kind: { in: ['TICKET', 'INVOICE'] }, status: 'ISSUED' },
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
