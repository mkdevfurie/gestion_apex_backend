import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  stockStatus,
  type AuditCategory,
  type AuditEntry,
  type CashSessionRow,
  type DailySales,
  type EmployeeStats,
  type Overview,
  type Paged,
  type PaymentMethod,
  type Period,
  type Role,
  type SaleRow,
  type TopProduct,
} from '../shared/index.js';

const DAY = 86_400_000;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Période [début, fin[ en UTC (= heure de Dakar). Par défaut : aujourd'hui. */
export function resolvePeriod(p: Period): { start: Date; end: Date; from: string; to: string } {
  const today = isoDay(new Date());
  const from = p.from ?? p.to ?? today;
  const to = p.to ?? from;
  const [a, b] = from <= to ? [from, to] : [to, from];
  return { start: new Date(`${a}T00:00:00Z`), end: new Date(new Date(`${b}T00:00:00Z`).getTime() + DAY), from: a, to: b };
}

const ticketWhere = (start: Date, end: Date): Prisma.InvoiceWhereInput => ({
  kind: 'TICKET',
  status: 'ISSUED',
  issuedAt: { gte: start, lt: end },
});

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async overview(p: Period): Promise<Overview> {
    const { start, end, from, to } = resolvePeriod(p);
    const { cashDifferenceTolerance } = await this.settings.get();

    const [sales, cost, stock, openSessions, closed, activeUsers, methods] = await Promise.all([
      this.prisma.invoice.aggregate({
        where: ticketWhere(start, end),
        _count: true,
        _sum: { total: true, subtotal: true, discount: true },
      }),
      // Coût des seules sorties liées aux tickets de la période (PMP au moment de la vente).
      this.prisma.$queryRaw<{ cost: unknown }[]>`
        SELECT COALESCE(SUM(-m.quantity * m."unitCost"), 0) AS cost
        FROM "StockMovement" m
        JOIN "Invoice" i ON i.id = m."invoiceId"
        WHERE m.type = 'SALE' AND i.kind = 'TICKET' AND i.status = 'ISSUED'
          AND i."issuedAt" >= ${start} AND i."issuedAt" < ${end}`,
      this.prisma.$queryRaw<{ averageCost: number; alertThreshold: unknown; qty: unknown }[]>`
        SELECT p."averageCost", p."alertThreshold", COALESCE(SUM(sl.quantity), 0) AS qty
        FROM "Product" p LEFT JOIN "StockLevel" sl ON sl."productId" = p.id
        WHERE p.active GROUP BY p.id`,
      this.prisma.cashSession.count({ where: { closedAt: null } }),
      this.prisma.cashSession.findMany({
        where: { closedAt: { gte: start, lt: end }, countedCash: { not: null } },
        select: { countedCash: true, expectedCash: true },
      }),
      this.prisma.auditLog.findMany({
        where: { createdAt: { gte: start, lt: end }, userId: { not: null } },
        distinct: ['userId'],
        select: { userId: true },
      }),
      this.prisma.payment.groupBy({
        by: ['method'],
        where: { direction: 'IN', receivedAt: { gte: start, lt: end } },
        _sum: { amount: true },
      }),
    ]);

    const salesTotal = sales._sum.total ?? 0;
    const salesHt = (sales._sum.subtotal ?? 0) - (sales._sum.discount ?? 0);
    const grossMargin = Math.round(salesHt - num(cost[0]?.cost));
    let stockValuation = 0;
    let low = 0;
    let out = 0;
    for (const s of stock) {
      const qty = num(s.qty);
      stockValuation += Math.max(qty, 0) * s.averageCost;
      const st = stockStatus(qty, num(s.alertThreshold));
      if (st === 'LOW') low++;
      if (st === 'OUT') out++;
    }
    const diffs = closed.map((c) => (c.countedCash ?? 0) - (c.expectedCash ?? 0));

    return {
      period: { from, to },
      salesTotal,
      salesHt,
      ticketCount: sales._count,
      averageBasket: sales._count ? Math.round(salesTotal / sales._count) : 0,
      grossMargin,
      marginRate: salesHt ? Math.round((grossMargin / salesHt) * 1000) / 10 : 0,
      stockValuation: Math.round(stockValuation),
      lowStockCount: low,
      outOfStockCount: out,
      openSessions,
      cashAlerts: diffs.filter((d) => Math.abs(d) > cashDifferenceTolerance).length,
      cashDifferenceTotal: diffs.reduce((a, d) => a + d, 0),
      activeUsers: activeUsers.length,
      byMethod: methods
        .map((m) => ({ method: m.method as PaymentMethod, amount: m._sum.amount ?? 0 }))
        .sort((a, b) => b.amount - a.amount),
    };
  }

  /** CA et nombre de tickets par jour, jours sans vente compris. */
  async daily(days: number): Promise<DailySales> {
    const end = isoDay(new Date());
    const start = isoDay(new Date(Date.now() - (days - 1) * DAY));
    const rows = await this.prisma.$queryRaw<{ day: Date; total: unknown; tickets: unknown }[]>`
      SELECT d::date AS day, COALESCE(SUM(i.total), 0) AS total, COUNT(i.id) AS tickets
      FROM generate_series(${start}::date, ${end}::date, interval '1 day') AS d
      LEFT JOIN "Invoice" i
        ON i."issuedAt" >= d AND i."issuedAt" < d + interval '1 day'
       AND i.kind = 'TICKET' AND i.status = 'ISSUED'
      GROUP BY d ORDER BY d`;
    return rows.map((r) => ({ day: isoDay(new Date(r.day)), total: num(r.total), tickets: num(r.tickets) }));
  }

  /** Activité par employé sur la période. */
  async employees(p: Period): Promise<EmployeeStats[]> {
    const { start, end } = resolvePeriod(p);
    const [users, tickets, discounts, sessions, movements, last] = await Promise.all([
      this.prisma.user.findMany({ select: { id: true, name: true, role: true, active: true } }),
      this.prisma.invoice.groupBy({
        by: ['userId'],
        where: ticketWhere(start, end),
        _count: true,
        _sum: { total: true },
      }),
      this.prisma.$queryRaw<{ userId: string; discount: unknown }[]>`
        SELECT i."userId", COALESCE(SUM(ROUND(l.quantity * l."unitPrice") - l."lineTotal"), 0) AS discount
        FROM "InvoiceLine" l JOIN "Invoice" i ON i.id = l."invoiceId"
        WHERE i.kind = 'TICKET' AND i.status = 'ISSUED' AND i."issuedAt" >= ${start} AND i."issuedAt" < ${end}
        GROUP BY i."userId"`,
      this.prisma.cashSession.findMany({
        where: { openedAt: { gte: start, lt: end } },
        select: { openedById: true, countedCash: true, expectedCash: true },
      }),
      this.prisma.stockMovement.groupBy({
        by: ['userId'],
        where: { createdAt: { gte: start, lt: end }, type: { not: 'SALE' } },
        _count: true,
      }),
      this.prisma.auditLog.groupBy({ by: ['userId'], _max: { createdAt: true } }),
    ]);

    const t = new Map(tickets.map((x) => [x.userId, x]));
    const d = new Map(discounts.map((x) => [x.userId, num(x.discount)]));
    const m = new Map(movements.map((x) => [x.userId, x._count]));
    const l = new Map(last.map((x) => [x.userId, x._max.createdAt]));

    return users
      .map((u) => {
        const tk = t.get(u.id);
        const own = sessions.filter((s) => s.openedById === u.id);
        const count = tk?._count ?? 0;
        const total = tk?._sum.total ?? 0;
        return {
          userId: u.id,
          name: u.name,
          role: u.role as Role,
          active: u.active,
          ticketCount: count,
          salesTotal: total,
          averageBasket: count ? Math.round(total / count) : 0,
          discountGiven: d.get(u.id) ?? 0,
          sessions: own.length,
          cashDifference: own.reduce(
            (a, s) => a + (s.countedCash === null ? 0 : s.countedCash - (s.expectedCash ?? 0)),
            0,
          ),
          stockMovements: m.get(u.id) ?? 0,
          lastActivityAt: l.get(u.id)?.toISOString() ?? null,
        };
      })
      .sort((a, b) => b.salesTotal - a.salesTotal || b.stockMovements - a.stockMovements || a.name.localeCompare(b.name));
  }

  async topProducts(p: Period, limit = 10): Promise<TopProduct[]> {
    const { start, end } = resolvePeriod(p);
    const rows = await this.prisma.$queryRaw<
      { productId: string; sku: string; name: string; unit: string; quantity: unknown; revenue: unknown }[]
    >`
      SELECT l."productId", p.sku, p.name, p.unit, SUM(l.quantity) AS quantity, SUM(l."lineTotal") AS revenue
      FROM "InvoiceLine" l
      JOIN "Invoice" i ON i.id = l."invoiceId"
      JOIN "Product" p ON p.id = l."productId"
      WHERE i.kind = 'TICKET' AND i.status = 'ISSUED' AND i."issuedAt" >= ${start} AND i."issuedAt" < ${end}
      GROUP BY l."productId", p.sku, p.name, p.unit
      ORDER BY revenue DESC
      LIMIT ${limit}`;
    return rows.map((r) => ({ ...r, quantity: num(r.quantity), revenue: num(r.revenue) }));
  }

  async audit(q: {
    userId?: string;
    category?: AuditCategory;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  }): Promise<Paged<AuditEntry>> {
    const where: Prisma.AuditLogWhereInput = { userId: q.userId };
    if (q.category === 'settings') {
      where.OR = ['settings.', 'company.', 'warehouse.'].map((prefix) => ({ action: { startsWith: prefix } }));
    } else if (q.category) {
      where.action = { startsWith: `${q.category}.` };
    }
    if (q.from || q.to) {
      const { start, end } = resolvePeriod(q);
      where.createdAt = { gte: start, lt: end };
    }
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        user: r.user ? { ...r.user, role: r.user.role as Role } : null,
        data: r.data,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async cashSessions(q: {
    userId?: string;
    status?: 'open' | 'closed';
    alertsOnly?: boolean;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  }): Promise<Paged<CashSessionRow>> {
    const { cashDifferenceTolerance } = await this.settings.get();
    const where: Prisma.CashSessionWhereInput = {
      openedById: q.userId,
      closedAt: q.status === 'open' ? null : q.status === 'closed' ? { not: null } : undefined,
    };
    if (q.from || q.to) {
      const { start, end } = resolvePeriod(q);
      where.openedAt = { gte: start, lt: end };
    }
    // Les alertes se calculent en mémoire (écart = compté − attendu).
    const take = q.alertsOnly ? undefined : q.pageSize;
    const skip = q.alertsOnly ? undefined : (q.page - 1) * q.pageSize;
    const [rows, total] = await Promise.all([
      this.prisma.cashSession.findMany({
        where,
        include: {
          warehouse: { select: { code: true } },
          openedBy: { select: { id: true, name: true } },
          invoices: { where: { status: 'ISSUED', kind: 'TICKET' }, select: { total: true } },
        },
        orderBy: { openedAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.cashSession.count({ where }),
    ]);
    let items = rows.map((s) => {
      const difference = s.countedCash === null || s.expectedCash === null ? null : s.countedCash - s.expectedCash;
      return {
        id: s.id,
        warehouse: s.warehouse.code,
        openedBy: s.openedBy,
        openedAt: s.openedAt.toISOString(),
        closedAt: s.closedAt?.toISOString() ?? null,
        openingFloat: s.openingFloat,
        ticketCount: s.invoices.length,
        salesTotal: s.invoices.reduce((a, i) => a + i.total, 0),
        expectedCash: s.expectedCash,
        countedCash: s.countedCash,
        difference,
        alert: difference !== null && Math.abs(difference) > cashDifferenceTolerance,
      };
    });
    if (!q.alertsOnly) return { items, total, page: q.page, pageSize: q.pageSize };
    items = items.filter((i) => i.alert);
    const startAt = (q.page - 1) * q.pageSize;
    return { items: items.slice(startAt, startAt + q.pageSize), total: items.length, page: q.page, pageSize: q.pageSize };
  }

  async sales(q: {
    userId?: string;
    q?: string;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  }): Promise<Paged<SaleRow>> {
    const where: Prisma.InvoiceWhereInput = { kind: 'TICKET', status: 'ISSUED', userId: q.userId };
    if (q.q) where.number = { contains: q.q.trim().toUpperCase() };
    if (q.from || q.to) {
      const { start, end } = resolvePeriod(q);
      where.issuedAt = { gte: start, lt: end };
    }
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: {
          user: { select: { id: true, name: true } },
          warehouse: { select: { code: true } },
          payments: { select: { method: true } },
          lines: { select: { quantity: true } },
        },
        orderBy: { issuedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        number: r.number!,
        issuedAt: r.issuedAt!.toISOString(),
        total: r.total,
        itemCount: Math.round(r.lines.reduce((a, l) => a + l.quantity.toNumber(), 0) * 1000) / 1000,
        discount: r.discount,
        cashier: r.user,
        warehouse: r.warehouse.code,
        methods: [...new Set(r.payments.map((p) => p.method as PaymentMethod))],
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }
}
