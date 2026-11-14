import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { nextCode, nextNumber } from '../pos/documents.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { applyMovement } from '../stock/apply-movement.js';
import {
  allocateOldestFirst,
  debtStatus,
  formatXof,
  MAX_AMOUNT,
  type AccountPayment,
  type AuthUser,
  type Paged,
  type PaymentMethod,
  type PurchaseDetail,
  type PurchaseInput,
  type PurchaseRow,
  type SupplierInput,
  type SupplierRow,
  type SupplierUpdate,
} from '../shared/index.js';

const DAY = 86_400_000;
const purchaseInclude = {
  supplier: { select: { id: true, name: true } },
  warehouse: { select: { code: true } },
  user: { select: { name: true } },
} satisfies Prisma.PurchaseInclude;

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  // ───────────────────────────── Fournisseurs ─────────────────────────────

  private async balances(): Promise<Map<string, number>> {
    const rows = await this.prisma.purchase.groupBy({
      by: ['supplierId'],
      where: { status: 'ISSUED' },
      _sum: { total: true, amountPaid: true },
    });
    return new Map(rows.map((r) => [r.supplierId, (r._sum.total ?? 0) - (r._sum.amountPaid ?? 0)]));
  }

  async suppliers(q: { q?: string; includeInactive?: boolean; page: number; pageSize: number }): Promise<Paged<SupplierRow>> {
    const where: Prisma.SupplierWhereInput = { active: q.includeInactive ? undefined : true };
    if (q.q) where.OR = [{ name: { contains: q.q, mode: 'insensitive' } }, { code: { contains: q.q, mode: 'insensitive' } }];
    const [rows, total, balances] = await Promise.all([
      this.prisma.supplier.findMany({ where, orderBy: { name: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.supplier.count({ where }),
      this.balances(),
    ]);
    return {
      items: rows.map((s) => ({
        id: s.id, code: s.code, name: s.name, phone: s.phone, email: s.email, address: s.address, ninea: s.ninea, active: s.active,
        balance: balances.get(s.id) ?? 0,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async createSupplier(input: SupplierInput, actor: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      const code = await nextCode(tx, 'FRN');
      const s = await tx.supplier.create({ data: { ...input, code } });
      await tx.auditLog.create({ data: { userId: actor.id, action: 'supplier.create', entity: 'Supplier', entityId: s.id, data: { code, name: s.name } } });
      return { ...s, balance: 0 };
    });
  }

  async updateSupplier(id: string, input: SupplierUpdate, actor: AuthUser) {
    const exists = await this.prisma.supplier.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Fournisseur introuvable');
    const [s] = await this.prisma.$transaction([
      this.prisma.supplier.update({ where: { id }, data: input }),
      this.prisma.auditLog.create({ data: { userId: actor.id, action: 'supplier.update', entity: 'Supplier', entityId: id, data: { ...input } } }),
    ]);
    return { ...s, balance: (await this.balances()).get(id) ?? 0 };
  }

  // ───────────────────────────── Réceptions ─────────────────────────────

  private toRow(p: Prisma.PurchaseGetPayload<{ include: typeof purchaseInclude }>): PurchaseRow {
    return {
      id: p.id,
      number: p.number ?? '',
      receivedAt: (p.receivedAt ?? p.createdAt).toISOString(),
      supplier: p.supplier,
      supplierRef: p.supplierRef,
      warehouse: p.warehouse.code,
      total: p.total,
      amountPaid: p.amountPaid,
      balance: Math.max(0, p.total - p.amountPaid),
      dueDate: p.dueDate?.toISOString() ?? null,
      status: debtStatus(p.total, p.amountPaid, p.dueDate),
      user: p.user.name,
    };
  }

  async list(q: { supplierId?: string; unpaidOnly?: boolean; page: number; pageSize: number }): Promise<Paged<PurchaseRow>> {
    const where: Prisma.PurchaseWhereInput = { status: 'ISSUED', supplierId: q.supplierId };
    if (q.unpaidOnly) where.amountPaid = { lt: this.prisma.purchase.fields.total };
    const [rows, total] = await Promise.all([
      this.prisma.purchase.findMany({ where, include: purchaseInclude, orderBy: { receivedAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.purchase.count({ where }),
    ]);
    return { items: rows.map((r) => this.toRow(r)), total, page: q.page, pageSize: q.pageSize };
  }

  async detail(id: string): Promise<PurchaseDetail> {
    const p = await this.prisma.purchase.findUnique({
      where: { id },
      include: {
        ...purchaseInclude,
        lines: { orderBy: { position: 'asc' }, include: { product: { select: { sku: true, name: true, unit: true } } } },
        payments: { orderBy: { receivedAt: 'asc' } },
      },
    });
    if (!p) throw new NotFoundException('Réception introuvable');
    return {
      ...this.toRow(p),
      lines: p.lines.map((l) => ({ productId: l.productId, ...l.product, quantity: l.quantity.toNumber(), unitCost: l.unitCost, lineTotal: l.lineTotal })),
      payments: p.payments.map((x) => ({ method: x.method as PaymentMethod, amount: x.amount, reference: x.reference, at: x.receivedAt.toISOString() })),
      notes: p.notes,
    };
  }

  /**
   * Bon de réception : entrée en stock de toutes les lignes (PMP recalculé),
   * dette fournisseur = total − règlements versés à la réception.
   */
  async receive(input: PurchaseInput, actor: AuthUser): Promise<PurchaseDetail> {
    const done = await this.prisma.auditLog.findFirst({
      where: { action: 'purchase.receive', data: { path: ['clientRequestId'], equals: input.clientRequestId } },
    });
    if (done?.entityId) return this.detail(done.entityId);

    const settings = await this.settings.get();
    const total = input.lines.reduce((a, l) => a + Math.round(l.quantity * l.unitCost), 0);
    const paid = input.payments.reduce((a, p) => a + p.amount, 0);
    if (total > MAX_AMOUNT) throw new BadRequestException('Montant trop élevé pour une seule réception');
    if (paid > total) throw new BadRequestException(`Les règlements dépassent le total (${formatXof(total)})`);

    const id = await this.prisma.$transaction(
      async (tx) => {
        const [supplier, warehouse] = await Promise.all([
          tx.supplier.findFirst({ where: { id: input.supplierId, active: true } }),
          tx.warehouse.findFirst({ where: { id: input.warehouseId, active: true } }),
        ]);
        if (!supplier) throw new NotFoundException('Fournisseur introuvable ou désactivé');
        if (!warehouse) throw new NotFoundException('Dépôt introuvable ou inactif');
        const products = await tx.product.findMany({ where: { id: { in: input.lines.map((l) => l.productId) }, active: true } });
        if (new Set(input.lines.map((l) => l.productId)).size !== products.length) {
          throw new NotFoundException('Article introuvable ou désactivé');
        }

        const receivedAt = new Date();
        const number = await nextNumber(tx, 'BR', receivedAt);
        const p = await tx.purchase.create({
          data: {
            status: 'ISSUED',
            number,
            supplierId: input.supplierId,
            supplierRef: input.supplierRef,
            warehouseId: input.warehouseId,
            userId: actor.id,
            receivedAt,
            dueDate: input.dueDate ? new Date(`${input.dueDate}T00:00:00Z`) : new Date(receivedAt.getTime() + settings.paymentTermDays * DAY),
            total,
            amountPaid: paid,
            notes: input.notes ?? null,
            lines: {
              create: input.lines.map((l, i) => ({
                productId: l.productId,
                quantity: l.quantity,
                unitCost: l.unitCost,
                lineTotal: Math.round(l.quantity * l.unitCost),
                position: i + 1,
              })),
            },
          },
        });
        for (const l of [...input.lines].sort((a, b) => a.productId.localeCompare(b.productId))) {
          await applyMovement(tx, {
            type: 'PURCHASE_RECEIPT',
            productId: l.productId,
            warehouseId: input.warehouseId,
            quantity: l.quantity,
            unitCost: l.unitCost,
            reason: `${number}${input.supplierRef ? ` · BL ${input.supplierRef}` : ''}`,
            userId: actor.id,
            purchaseId: p.id,
          });
        }
        if (input.payments.length) {
          await tx.payment.createMany({
            data: input.payments.map((x) => ({
              direction: 'OUT' as const, method: x.method, amount: x.amount, reference: x.reference, purchaseId: p.id, userId: actor.id,
            })),
          });
        }
        await tx.auditLog.create({
          data: {
            userId: actor.id,
            action: 'purchase.receive',
            entity: 'Purchase',
            entityId: p.id,
            data: { clientRequestId: input.clientRequestId, number, supplier: supplier.name, total, paid },
          },
        });
        return p.id;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    return this.detail(id);
  }

  /** Règlement à un fournisseur, imputé aux réceptions les plus anciennes. */
  async paySupplier(supplierId: string, input: AccountPayment, actor: AuthUser) {
    const done = await this.prisma.auditLog.findFirst({
      where: { action: 'supplier.payment', entityId: supplierId, data: { path: ['clientRequestId'], equals: input.clientRequestId } },
    });
    if (done) return { allocated: (done.data as { allocations: unknown[] }).allocations, replay: true };

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Supplier" WHERE id = ${supplierId} FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Fournisseur introuvable');
      const open = await tx.purchase.findMany({
        where: { supplierId, status: 'ISSUED', amountPaid: { lt: tx.purchase.fields.total } },
        orderBy: [{ dueDate: 'asc' }, { receivedAt: 'asc' }],
        select: { id: true, number: true, total: true, amountPaid: true },
      });
      const debts = open.map((p) => ({ id: p.id, number: p.number, balance: p.total - p.amountPaid }));
      const due = debts.reduce((a, d) => a + d.balance, 0);
      if (input.amount > due) throw new BadRequestException(`Le montant dépasse la dette (${formatXof(due)})`);
      const { allocations } = allocateOldestFirst(debts, input.amount);
      for (const a of allocations) {
        await tx.payment.create({
          data: { direction: 'OUT', method: input.method, amount: a.amount, reference: input.reference, purchaseId: a.id, userId: actor.id },
        });
        await tx.purchase.update({ where: { id: a.id }, data: { amountPaid: { increment: a.amount } } });
      }
      const detail = allocations.map((a) => ({ ...a, number: debts.find((d) => d.id === a.id)!.number }));
      await tx.auditLog.create({
        data: {
          userId: actor.id,
          action: 'supplier.payment',
          entity: 'Supplier',
          entityId: supplierId,
          data: { clientRequestId: input.clientRequestId, amount: input.amount, method: input.method, allocations: detail },
        },
      });
      return { allocated: detail, replay: false };
    });
  }
}
