import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { nextCode } from '../pos/documents.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  agingBucketIndex,
  agingLabels,
  allocateOldestFirst,
  formatXof,
  type AccountPayment,
  type AuthUser,
  type CustomerInput,
  type CustomerRow,
  type CustomerUpdate,
  type Paged,
  type ReceivablesReport,
} from '../shared/index.js';

type Balances = Map<string, { balance: number; overdue: number; oldest: Date | null }>;

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Encours par client (reste dû, dont échu, plus ancienne échéance). */
  private async balances(ids?: string[]): Promise<Balances> {
    const rows = await this.prisma.$queryRaw<{ customerId: string; balance: unknown; overdue: unknown; oldest: Date | null }[]>`
      SELECT "customerId",
             SUM(total - "amountPaid") AS balance,
             SUM(CASE WHEN "dueDate" < now() THEN total - "amountPaid" ELSE 0 END) AS overdue,
             MIN("dueDate") AS oldest
      FROM "Invoice"
      WHERE "customerId" IS NOT NULL AND status = 'ISSUED' AND kind IN ('TICKET', 'INVOICE') AND total > "amountPaid"
        ${ids ? Prisma.sql`AND "customerId" IN (${Prisma.join(ids)})` : Prisma.empty}
      GROUP BY "customerId"`;
    return new Map(rows.map((r) => [r.customerId, { balance: Number(r.balance), overdue: Number(r.overdue), oldest: r.oldest }]));
  }

  private toRow(c: Prisma.CustomerGetPayload<object>, b?: { balance: number; overdue: number }): CustomerRow {
    return {
      id: c.id,
      code: c.code,
      name: c.name,
      phone: c.phone,
      email: c.email,
      address: c.address,
      ninea: c.ninea,
      creditLimit: c.creditLimit,
      notes: c.notes,
      active: c.active,
      balance: b?.balance ?? 0,
      overdue: b?.overdue ?? 0,
    };
  }

  async list(q: { q?: string; withBalance?: boolean; includeInactive?: boolean; page: number; pageSize: number }): Promise<Paged<CustomerRow>> {
    const where: Prisma.CustomerWhereInput = { active: q.includeInactive ? undefined : true };
    if (q.q) {
      const s = q.q.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { code: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s.replace(/\s/g, '') } },
        { phone: { contains: s } },
      ];
    }
    const balances = await this.balances();
    if (q.withBalance) where.id = { in: [...balances.keys()] };
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.customer.count({ where }),
    ]);
    return { items: rows.map((c) => this.toRow(c, balances.get(c.id))), total, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string): Promise<CustomerRow> {
    const c = await this.prisma.customer.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Client introuvable');
    return this.toRow(c, (await this.balances([id])).get(id));
  }

  async create(input: CustomerInput, actor: AuthUser): Promise<CustomerRow> {
    const id = await this.prisma.$transaction(async (tx) => {
      const code = await nextCode(tx, 'CLI');
      const c = await tx.customer.create({ data: { ...input, code } });
      await tx.auditLog.create({
        data: { userId: actor.id, action: 'customer.create', entity: 'Customer', entityId: c.id, data: { code, name: c.name } },
      });
      return c.id;
    });
    return this.get(id);
  }

  async update(id: string, input: CustomerUpdate, actor: AuthUser): Promise<CustomerRow> {
    const before = await this.prisma.customer.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Client introuvable');
    if (input.creditLimit !== undefined && actor.role === 'CASHIER') {
      throw new BadRequestException('Seul un gérant peut modifier un plafond de crédit');
    }
    await this.prisma.$transaction([
      this.prisma.customer.update({ where: { id }, data: input }),
      this.prisma.auditLog.create({
        data: {
          userId: actor.id,
          action: 'customer.update',
          entity: 'Customer',
          entityId: id,
          data: Object.fromEntries(
            Object.entries(input).map(([k, v]) => [k, { from: (before as Record<string, unknown>)[k] ?? null, to: v ?? null }]),
          ) as Prisma.InputJsonValue,
        },
      }),
    ]);
    return this.get(id);
  }

  /**
   * Règlement reçu sur le compte du client, imputé aux factures les plus
   * anciennes. Refusé s'il dépasse le reste dû (pas d'avance non tracée).
   */
  async receivePayment(id: string, input: AccountPayment, actor: AuthUser) {
    const done = await this.prisma.auditLog.findFirst({
      where: { action: 'customer.payment', entityId: id, data: { path: ['clientRequestId'], equals: input.clientRequestId } },
    });
    if (done) return { allocated: (done.data as { allocations: unknown[] }).allocations, replay: true };

    const session = await this.prisma.cashSession.findFirst({ where: { openedById: actor.id, closedAt: null } });
    if (input.method === 'CASH' && !session) throw new ConflictException('Ouvrez votre caisse pour encaisser des espèces');

    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Customer" WHERE id = ${id} FOR UPDATE`;
        if (!locked.length) throw new NotFoundException('Client introuvable');
        const open = await tx.invoice.findMany({
          where: { customerId: id, status: 'ISSUED', kind: { in: ['TICKET', 'INVOICE'] }, amountPaid: { lt: tx.invoice.fields.total } },
          orderBy: [{ dueDate: 'asc' }, { issuedAt: 'asc' }],
          select: { id: true, number: true, total: true, amountPaid: true },
        });
        const debts = open.map((i) => ({ id: i.id, number: i.number, balance: i.total - i.amountPaid }));
        const totalDue = debts.reduce((a, d) => a + d.balance, 0);
        if (input.amount > totalDue) {
          throw new BadRequestException(`Le montant dépasse le reste dû (${formatXof(totalDue)})`);
        }
        const { allocations } = allocateOldestFirst(debts, input.amount);
        for (const a of allocations) {
          await tx.payment.create({
            data: {
              direction: 'IN',
              method: input.method,
              amount: a.amount,
              reference: input.reference,
              invoiceId: a.id,
              cashSessionId: input.method === 'CASH' ? session?.id : undefined,
              userId: actor.id,
            },
          });
          await tx.invoice.update({ where: { id: a.id }, data: { amountPaid: { increment: a.amount } } });
        }
        const detail = allocations.map((a) => ({ ...a, number: debts.find((d) => d.id === a.id)!.number }));
        await tx.auditLog.create({
          data: {
            userId: actor.id,
            action: 'customer.payment',
            entity: 'Customer',
            entityId: id,
            data: { clientRequestId: input.clientRequestId, amount: input.amount, method: input.method, allocations: detail },
          },
        });
        return { allocated: detail, replay: false };
      },
      { maxWait: 10_000, timeout: 20_000 },
    );
  }

  /** Balance âgée : qui doit quoi, depuis combien de temps. */
  async receivables(): Promise<ReceivablesReport> {
    const open = await this.prisma.invoice.findMany({
      where: { customerId: { not: null }, status: 'ISSUED', kind: { in: ['TICKET', 'INVOICE'] }, amountPaid: { lt: this.prisma.invoice.fields.total } },
      select: { customerId: true, total: true, amountPaid: true, dueDate: true },
    });
    const buckets = agingLabels.map((label) => ({ label, amount: 0 }));
    let total = 0;
    let overdue = 0;
    const now = new Date();
    for (const i of open) {
      const due = i.total - i.amountPaid;
      total += due;
      const b = agingBucketIndex(i.dueDate, now);
      if (b >= 0) {
        buckets[b].amount += due;
        overdue += due;
      }
    }
    const balances = await this.balances();
    const customers = await this.prisma.customer.findMany({ where: { id: { in: [...balances.keys()] } } });
    return {
      total,
      overdue,
      buckets: [{ label: 'Non échu', amount: total - overdue }, ...buckets],
      customers: customers
        .map((c) => {
          const b = balances.get(c.id)!;
          return { ...this.toRow(c, b), oldestDueDate: b.oldest?.toISOString() ?? null };
        })
        .sort((a, b) => b.overdue - a.overdue || b.balance - a.balance),
    };
  }
}
