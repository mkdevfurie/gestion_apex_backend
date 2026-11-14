import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  can,
  formatXof,
  type AuthUser,
  type CashSessionClose,
  type CashSessionOpen,
  type CashSessionSummary,
  type PaymentMethod,
} from '../shared/index.js';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Session de caisse : un caissier ouvre SA caisse avec un fond, encaisse,
 * puis la clôture en comptant les espèces (ticket Z). Une seule session
 * ouverte par utilisateur.
 */
@Injectable()
export class CashSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async current(user: AuthUser): Promise<CashSessionSummary | null> {
    const s = await this.prisma.cashSession.findFirst({
      where: { openedById: user.id, closedAt: null },
      select: { id: true },
    });
    return s ? this.summary(s.id) : null;
  }

  async open(input: CashSessionOpen, user: AuthUser): Promise<CashSessionSummary> {
    const { minOpeningFloat } = await this.settings.get();
    if (input.openingFloat < minOpeningFloat) {
      throw new BadRequestException(`Fond de caisse minimum : ${formatXof(minOpeningFloat)}`);
    }
    const id = await this.prisma.$transaction(async (tx) => {
      // Sérialise les ouvertures d'un même utilisateur (double clic).
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      const already = await tx.cashSession.findFirst({ where: { openedById: user.id, closedAt: null } });
      if (already) throw new ConflictException('Vous avez déjà une caisse ouverte');
      const w = await tx.warehouse.findFirst({ where: { id: input.warehouseId, active: true } });
      if (!w) throw new NotFoundException('Dépôt introuvable ou inactif');

      const s = await tx.cashSession.create({
        data: { warehouseId: input.warehouseId, openingFloat: input.openingFloat, openedById: user.id },
      });
      await tx.auditLog.create({
        data: { userId: user.id, action: 'cash.open', entity: 'CashSession', entityId: s.id, data: { ...input } },
      });
      return s.id;
    });
    return this.summary(id);
  }

  /** Clôture : la sienne, ou celle d'un autre pour un gérant / administrateur. */
  async close(id: string, input: CashSessionClose, user: AuthUser): Promise<CashSessionSummary> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ openedById: string; closedAt: Date | null }[]>`
        SELECT "openedById", "closedAt" FROM "CashSession" WHERE id = ${id} FOR UPDATE`;
      const s = locked[0];
      if (!s) throw new NotFoundException('Session de caisse introuvable');
      if (s.closedAt) throw new ConflictException('Cette caisse est déjà clôturée');
      if (s.openedById !== user.id && !can(user.role, 'manageCatalog')) {
        throw new ForbiddenException('Seul le titulaire ou un gérant peut clôturer cette caisse');
      }
      const { expectedCash } = await this.totals(tx, id);
      await tx.cashSession.update({
        where: { id },
        data: {
          closedAt: new Date(),
          closedById: user.id,
          expectedCash,
          countedCash: input.countedCash,
          closingNotes: input.notes,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: 'cash.close',
          entity: 'CashSession',
          entityId: id,
          data: { expectedCash, countedCash: input.countedCash, difference: input.countedCash - expectedCash },
        },
      });
    });
    return this.summary(id);
  }

  async summary(id: string, db: Db = this.prisma): Promise<CashSessionSummary> {
    const s = await db.cashSession.findUnique({
      where: { id },
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        openedBy: { select: { name: true } },
        closedBy: { select: { name: true } },
      },
    });
    if (!s) throw new NotFoundException('Session de caisse introuvable');
    const t = await this.totals(db, id);
    const expectedCash = s.expectedCash ?? t.expectedCash;
    return {
      id: s.id,
      warehouse: s.warehouse,
      openedBy: s.openedBy.name,
      openedAt: s.openedAt.toISOString(),
      openingFloat: s.openingFloat,
      ticketCount: t.ticketCount,
      salesTotal: t.salesTotal,
      byMethod: t.byMethod,
      expectedCash,
      closedAt: s.closedAt?.toISOString() ?? null,
      closedBy: s.closedBy?.name ?? null,
      countedCash: s.countedCash,
      difference: s.countedCash === null ? null : s.countedCash - expectedCash,
    };
  }

  private async totals(db: Db, id: string) {
    const [session, tickets, payments] = await Promise.all([
      db.cashSession.findUniqueOrThrow({ where: { id }, select: { openingFloat: true } }),
      db.invoice.aggregate({
        where: { cashSessionId: id, status: 'ISSUED', kind: { in: ['TICKET', 'INVOICE'] } },
        _count: true,
        _sum: { total: true },
      }),
      db.payment.groupBy({
        by: ['method', 'direction'],
        where: { cashSessionId: id, method: { not: 'CREDIT_NOTE' } },
        _sum: { amount: true },
      }),
    ]);
    // Net par moyen : encaissements − remboursements (avoirs payés en caisse).
    const net = new Map<PaymentMethod, number>();
    for (const p of payments) {
      const m = p.method as PaymentMethod;
      net.set(m, (net.get(m) ?? 0) + (p.direction === 'IN' ? 1 : -1) * (p._sum.amount ?? 0));
    }
    const byMethod = [...net].map(([method, amount]) => ({ method, amount })).sort((a, b) => b.amount - a.amount);
    const cashIn = byMethod.find((p) => p.method === 'CASH')?.amount ?? 0;
    return {
      ticketCount: tickets._count,
      salesTotal: tickets._sum.total ?? 0,
      byMethod,
      expectedCash: session.openingFloat + cashIn,
    };
  }
}
