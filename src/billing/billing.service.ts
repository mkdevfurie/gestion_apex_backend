import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { assertCreditAllowed } from '../customers/balance.js';
import { nextNumber, openChainLink } from '../pos/documents.js';
import { SalesService, writeSale } from '../pos/sales.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { applyMovement } from '../stock/apply-movement.js';
import {
  computeInvoiceTotals,
  debtStatus,
  formatXof,
  MAX_AMOUNT,
  settlePayments,
  type AuthUser,
  type DocumentDetail,
  type DocumentKind,
  type DocumentRow,
  type Paged,
  type PaymentMethod,
  type QuoteConvert,
  type QuoteInput,
  type RefundInput,
} from '../shared/index.js';

const DAY = 86_400_000;

const rowInclude = {
  customer: { select: { id: true, name: true } },
  user: { select: { name: true } },
  source: { select: { number: true } },
  derived: { where: { status: 'ISSUED' }, select: { id: true, kind: true, number: true, total: true } },
} satisfies Prisma.InvoiceInclude;
type RowPayload = Prisma.InvoiceGetPayload<{ include: typeof rowInclude }>;

export type DocumentQuery = {
  kind?: DocumentKind;
  customerId?: string;
  q?: string;
  unpaidOnly?: boolean;
  page: number;
  pageSize: number;
};

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly sales: SalesService,
  ) {}

  private toRow(d: RowPayload, now = new Date()): DocumentRow {
    const kind = d.kind as DocumentKind;
    const balance = kind === 'TICKET' || kind === 'INVOICE' ? Math.max(0, d.total - d.amountPaid) : 0;
    let status: DocumentRow['status'];
    if (kind === 'QUOTE') {
      status = d.derived.some((x) => x.kind === 'INVOICE')
        ? 'CONVERTED'
        : d.validUntil && d.validUntil < now
          ? 'EXPIRED'
          : 'OPEN';
    } else if (kind === 'CREDIT_NOTE') {
      status = 'SETTLED';
    } else {
      status = debtStatus(d.total, d.amountPaid, d.dueDate, now);
    }
    return {
      id: d.id,
      kind,
      number: d.number ?? '',
      issuedAt: (d.issuedAt ?? d.createdAt).toISOString(),
      dueDate: d.dueDate?.toISOString() ?? null,
      validUntil: d.validUntil?.toISOString() ?? null,
      customer: d.customer,
      total: d.total,
      amountPaid: d.amountPaid,
      balance,
      status,
      sourceNumber: d.source?.number ?? null,
      user: d.user.name,
    };
  }

  async list(q: DocumentQuery): Promise<Paged<DocumentRow>> {
    const where: Prisma.InvoiceWhereInput = { status: 'ISSUED', kind: q.kind, customerId: q.customerId };
    if (q.q) where.number = { contains: q.q.trim().toUpperCase() };
    if (q.unpaidOnly) {
      where.kind = q.kind ?? { in: ['TICKET', 'INVOICE'] };
      where.amountPaid = { lt: this.prisma.invoice.fields.total };
    }
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: rowInclude,
        orderBy: { issuedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return { items: rows.map((r) => this.toRow(r)), total, page: q.page, pageSize: q.pageSize };
  }

  async detail(id: string): Promise<DocumentDetail> {
    const [d, company] = await Promise.all([
      this.prisma.invoice.findUnique({
        where: { id },
        include: {
          ...rowInclude,
          customer: { select: { id: true, code: true, name: true, phone: true, address: true, ninea: true } },
          warehouse: { select: { code: true, name: true } },
          lines: { orderBy: { position: 'asc' }, include: { product: { select: { sku: true, unit: true } } } },
          payments: { orderBy: { receivedAt: 'asc' } },
        },
      }),
      this.prisma.company.findUnique({ where: { id: 1 } }),
    ]);
    if (!d || d.status !== 'ISSUED') throw new NotFoundException('Document introuvable');

    const returned = await this.returnedByProduct(id);
    const remaining = new Map(returned);
    const lines = d.lines.map((l) => {
      const q = l.quantity.toNumber();
      // Les quantités rendues sont réparties sur les lignes du même article, dans l'ordre.
      const already = Math.min(q, remaining.get(l.productId ?? '') ?? 0);
      if (l.productId) remaining.set(l.productId, (remaining.get(l.productId) ?? 0) - already);
      return {
        id: l.id,
        productId: l.productId,
        sku: l.product?.sku ?? null,
        description: l.description,
        unit: l.product?.unit ?? null,
        quantity: q,
        unitPrice: l.unitPrice,
        discountRate: l.discountRate.toNumber(),
        vatRate: l.vatRate.toNumber(),
        lineTotal: l.lineTotal,
        returnedQuantity: already,
      };
    });
    const { vat } = computeInvoiceTotals(lines, d.discount);
    return {
      ...this.toRow({ ...d, customer: d.customer ? { id: d.customer.id, name: d.customer.name } : null }),
      warehouse: d.warehouse,
      customerDetail: d.customer,
      company: {
        name: company?.name ?? 'Ma société',
        legalForm: company?.legalForm ?? null,
        address: company?.address ?? null,
        phone: company?.phone ?? null,
        email: company?.email ?? null,
        ninea: company?.ninea ?? null,
        rccm: company?.rccm ?? null,
      },
      lines,
      subtotal: d.subtotal,
      discount: d.discount,
      vat,
      vatTotal: d.vatTotal,
      payments: d.payments.map((p) => ({
        method: p.method as PaymentMethod,
        direction: p.direction,
        amount: p.amount,
        reference: p.reference,
        at: p.receivedAt.toISOString(),
      })),
      notes: d.notes,
      hash: d.hash,
      creditNotes: d.derived.filter((x) => x.kind === 'CREDIT_NOTE').map((x) => ({ id: x.id, number: x.number!, total: x.total })),
    };
  }

  /** Quantités déjà rendues par article (avoirs émis sur ce document). */
  private async returnedByProduct(sourceId: string, tx: Prisma.TransactionClient | PrismaService = this.prisma) {
    const rows = await tx.invoiceLine.groupBy({
      by: ['productId'],
      where: { invoice: { sourceId, kind: 'CREDIT_NOTE', status: 'ISSUED' } },
      _sum: { quantity: true },
    });
    return new Map(rows.map((r) => [r.productId ?? '', r._sum.quantity?.toNumber() ?? 0]));
  }

  // ───────────────────────────── Devis ─────────────────────────────

  async createQuote(input: QuoteInput, user: AuthUser): Promise<DocumentDetail> {
    const settings = await this.settings.get();
    const lines = await this.sales.priceLines(input.lines, user);
    const totals = computeInvoiceTotals(lines);
    if (totals.total > MAX_AMOUNT) throw new BadRequestException('Montant trop élevé pour une seule pièce');
    if (input.customerId) {
      const c = await this.prisma.customer.findFirst({ where: { id: input.customerId, active: true } });
      if (!c) throw new NotFoundException('Client introuvable ou désactivé');
    }
    const warehouse = await this.prisma.warehouse.findFirst({ where: { active: true }, orderBy: { code: 'asc' } });
    if (!warehouse) throw new ConflictException('Aucun dépôt actif');

    const id = await this.prisma.$transaction(async (tx) => {
      const issuedAt = new Date();
      const number = await nextNumber(tx, 'DEV', issuedAt);
      const q = await tx.invoice.create({
        data: {
          kind: 'QUOTE',
          status: 'ISSUED',
          number,
          issuedAt,
          validUntil: new Date(issuedAt.getTime() + settings.quoteValidityDays * DAY),
          customerId: input.customerId,
          warehouseId: warehouse.id,
          userId: user.id,
          notes: input.notes ?? null,
          subtotal: totals.subtotal,
          discount: totals.discount,
          vatTotal: totals.vatTotal,
          total: totals.total,
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
      await tx.auditLog.create({
        data: { userId: user.id, action: 'quote.create', entity: 'Invoice', entityId: q.id, data: { number, total: totals.total } },
      });
      return q.id;
    });
    return this.detail(id);
  }

  /**
   * Devis → facture, aux prix du devis (fixés et enregistrés par le serveur).
   * Le stock sort à ce moment-là. Un devis ne se convertit qu'une fois.
   */
  async convertQuote(id: string, input: QuoteConvert, user: AuthUser): Promise<DocumentDetail> {
    const replay = await this.prisma.invoice.findUnique({ where: { clientRequestId: input.clientRequestId }, select: { id: true } });
    if (replay) return this.detail(replay.id);

    const settings = await this.settings.get();
    const session = await this.prisma.cashSession.findFirst({ where: { openedById: user.id, closedAt: null } });
    if (input.payments.some((p) => p.method === 'CASH') && !session) {
      throw new ConflictException('Ouvrez votre caisse pour encaisser des espèces');
    }

    const invoiceId = await this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Invoice" WHERE id = ${id} AND kind = 'QUOTE' FOR UPDATE`;
        if (!locked.length) throw new NotFoundException('Devis introuvable');
        const quote = await tx.invoice.findUniqueOrThrow({
          where: { id },
          include: { lines: { orderBy: { position: 'asc' }, include: { product: true } }, derived: { where: { kind: 'INVOICE' } } },
        });
        if (quote.derived.length) throw new ConflictException(`Devis déjà converti (${quote.derived[0].number})`);
        if (quote.validUntil && quote.validUntil < new Date()) throw new ConflictException('Devis expiré : créez-en un nouveau');
        if (!quote.customerId) throw new BadRequestException('Associez un client au devis avant de le facturer');

        const lines = quote.lines.map((l) => {
          if (!l.product || !l.product.active) throw new ConflictException(`Article « ${l.description} » désactivé`);
          return {
            productId: l.productId!,
            quantity: l.quantity.toNumber(),
            discountRate: l.discountRate.toNumber(),
            unitPrice: l.unitPrice,
            vatRate: l.vatRate.toNumber(),
            product: { sku: l.product.sku, name: l.description, unit: l.product.unit },
          };
        });
        const settlement = settlePayments(quote.total, input.payments, true);
        if (!settlement.ok) throw new BadRequestException(settlement.error);
        if (settlement.credit > 0) await assertCreditAllowed(tx, quote.customerId, settlement.credit, user, settings);

        const inv = await writeSale(tx, {
          kind: 'INVOICE',
          lines,
          payments: settlement.applied,
          warehouseId: session?.warehouseId ?? quote.warehouseId,
          userId: user.id,
          customerId: quote.customerId,
          cashSessionId: session?.id,
          clientRequestId: input.clientRequestId,
          cashTendered: settlement.cashTendered,
          change: settlement.change,
          credit: settlement.credit,
          paymentTermDays: settings.paymentTermDays,
          sourceId: quote.id,
          notes: quote.notes,
        });
        await tx.auditLog.create({
          data: { userId: user.id, action: 'quote.convert', entity: 'Invoice', entityId: quote.id, data: { invoice: inv.number } },
        });
        return inv.id;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    return this.detail(invoiceId);
  }

  // ───────────────────────────── Avoirs ─────────────────────────────

  /**
   * Retour client : avoir AVR-… chaîné, articles remis en stock, montant
   * d'abord imputé sur le reste dû du document, le solde remboursé.
   */
  async refund(sourceId: string, input: RefundInput, user: AuthUser): Promise<DocumentDetail> {
    const replay = await this.prisma.invoice.findUnique({ where: { clientRequestId: input.clientRequestId }, select: { id: true } });
    if (replay) return this.detail(replay.id);
    const session = await this.prisma.cashSession.findFirst({ where: { openedById: user.id, closedAt: null } });

    const id = await this.prisma.$transaction(
      async (tx) => {
        // Verrou sur le document d'origine : deux retours simultanés ne peuvent pas dépasser le vendu.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Invoice" WHERE id = ${sourceId} AND status = 'ISSUED' AND kind IN ('TICKET', 'INVOICE') FOR UPDATE`;
        if (!locked.length) throw new NotFoundException('Ticket ou facture introuvable');
        const source = await tx.invoice.findUniqueOrThrow({
          where: { id: sourceId },
          include: { lines: { orderBy: { position: 'asc' }, include: { product: true } } },
        });

        const byLine = new Map(source.lines.map((l) => [l.id, l]));
        const returned = await this.returnedByProduct(sourceId, tx);
        const soldByProduct = new Map<string, number>();
        for (const l of source.lines) soldByProduct.set(l.productId ?? '', (soldByProduct.get(l.productId ?? '') ?? 0) + l.quantity.toNumber());
        const wanted = new Map<string, number>();

        const lines = input.lines.map((r) => {
          const l = byLine.get(r.lineId);
          if (!l || !l.productId || !l.product) throw new BadRequestException('Ligne inconnue sur ce document');
          wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + r.quantity);
          return {
            productId: l.productId,
            quantity: r.quantity,
            discountRate: l.discountRate.toNumber(),
            unitPrice: l.unitPrice,
            vatRate: l.vatRate.toNumber(),
            product: { sku: l.product.sku, name: l.description, unit: l.product.unit },
          };
        });
        for (const [productId, q] of wanted) {
          const max = (soldByProduct.get(productId) ?? 0) - (returned.get(productId) ?? 0);
          if (q > max + 1e-9) {
            const name = lines.find((l) => l.productId === productId)!.product.name;
            throw new ConflictException(`Retour impossible : « ${name} », ${max} restant(s) retournable(s)`);
          }
        }

        const totals = computeInvoiceTotals(lines);
        const due = Math.max(0, source.total - source.amountPaid);
        const imputed = Math.min(due, totals.total);
        const refunded = totals.total - imputed;
        if (refunded > 0 && input.refundMethod === 'CASH' && !session) {
          throw new ConflictException('Ouvrez votre caisse pour rembourser en espèces');
        }

        const link = await openChainLink(tx, 'AVR');
        const hash = link.seal(
          totals.total,
          lines.map((l, i) => [l.product.sku, l.quantity, l.unitPrice, l.discountRate, l.vatRate, totals.lineTotals[i]]),
          [],
        );
        const note = await tx.invoice.create({
          data: {
            kind: 'CREDIT_NOTE',
            status: 'ISSUED',
            number: link.number,
            issuedAt: link.issuedAt,
            customerId: source.customerId,
            warehouseId: source.warehouseId,
            userId: user.id,
            sourceId,
            clientRequestId: input.clientRequestId,
            cashSessionId: session?.id,
            notes: input.reason,
            subtotal: totals.subtotal,
            discount: totals.discount,
            vatTotal: totals.vatTotal,
            total: totals.total,
            amountPaid: totals.total,
            hash,
            previousHash: link.previousHash,
            chainIndex: link.chainIndex,
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

        for (const l of [...lines].sort((a, b) => a.productId.localeCompare(b.productId))) {
          await applyMovement(tx, {
            type: 'CUSTOMER_RETURN',
            productId: l.productId,
            warehouseId: source.warehouseId,
            quantity: l.quantity,
            reason: `${link.number} (${source.number})`,
            userId: user.id,
            invoiceId: note.id,
          });
        }

        if (imputed > 0) {
          await tx.payment.create({
            data: { direction: 'IN', method: 'CREDIT_NOTE', amount: imputed, reference: link.number, invoiceId: sourceId, userId: user.id },
          });
          await tx.invoice.update({ where: { id: sourceId }, data: { amountPaid: { increment: imputed } } });
        }
        if (refunded > 0) {
          await tx.payment.create({
            data: {
              direction: 'OUT',
              method: input.refundMethod,
              amount: refunded,
              reference: source.number,
              invoiceId: note.id,
              cashSessionId: input.refundMethod === 'CASH' ? session?.id : undefined,
              userId: user.id,
            },
          });
        }
        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: 'credit_note.issue',
            entity: 'Invoice',
            entityId: note.id,
            data: { number: link.number, source: source.number, total: totals.total, imputed, refunded, reason: input.reason },
          },
        });
        return note.id;
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
    return this.detail(id);
  }

  /** Message d'aide pour la caisse (montant remboursable). */
  static describeRefund(total: number, due: number) {
    const imputed = Math.min(due, total);
    return imputed ? `${formatXof(imputed)} imputés sur le reste dû, ${formatXof(total - imputed)} remboursés` : `${formatXof(total)} remboursés`;
  }
}
