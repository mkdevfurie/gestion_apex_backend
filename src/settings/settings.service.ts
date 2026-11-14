import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  defaultSettings,
  type AppSettings,
  type AuthUser,
  type CompanyInfo,
  type CompanyUpdate,
  type SettingsUpdate,
  type Warehouse,
  type WarehouseCreate,
  type WarehouseUpdate,
} from '../shared/index.js';

/**
 * Réglages de fonctionnement et identité de la société.
 * Lus à chaque vente / ouverture de caisse : gardés en mémoire 60 s.
 */
@Injectable()
export class SettingsService {
  private cache: { value: AppSettings; at: number } | undefined;

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<AppSettings> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.value;
    const row = await this.prisma.settings.findUnique({ where: { id: 1 } });
    const value: AppSettings = row
      ? {
          defaultVatRate: row.defaultVatRate.toNumber(),
          defaultAlertThreshold: row.defaultAlertThreshold.toNumber(),
          maxDiscountRate: row.maxDiscountRate.toNumber(),
          cashDifferenceTolerance: row.cashDifferenceTolerance,
          minOpeningFloat: row.minOpeningFloat,
          receiptFooter: row.receiptFooter,
          paymentTermDays: row.paymentTermDays,
          quoteValidityDays: row.quoteValidityDays,
          cashierCanSellOnCredit: row.cashierCanSellOnCredit,
        }
      : defaultSettings;
    this.cache = { value, at: Date.now() };
    return value;
  }

  async update(input: SettingsUpdate, actor: AuthUser): Promise<AppSettings> {
    const before = await this.get();
    await this.prisma.$transaction([
      this.prisma.settings.upsert({ where: { id: 1 }, create: { id: 1, ...input }, update: input }),
      this.prisma.auditLog.create({
        data: {
          userId: actor.id,
          action: 'settings.update',
          entity: 'Settings',
          entityId: '1',
          data: diff(before, input),
        },
      }),
    ]);
    this.cache = undefined;
    return this.get();
  }

  async company(): Promise<CompanyInfo> {
    const c = await this.prisma.company.findUnique({ where: { id: 1 } });
    return {
      name: c?.name ?? 'Ma société',
      legalForm: c?.legalForm ?? null,
      ninea: c?.ninea ?? null,
      rccm: c?.rccm ?? null,
      address: c?.address ?? null,
      phone: c?.phone ?? null,
      email: c?.email ?? null,
    };
  }

  async updateCompany(input: CompanyUpdate, actor: AuthUser): Promise<CompanyInfo> {
    const before = await this.company();
    await this.prisma.$transaction([
      this.prisma.company.upsert({ where: { id: 1 }, create: { id: 1, ...input }, update: input }),
      this.prisma.auditLog.create({
        data: { userId: actor.id, action: 'company.update', entity: 'Company', entityId: '1', data: diff(before, input) },
      }),
    ]);
    return this.company();
  }

  warehouses(includeInactive: boolean): Promise<Warehouse[]> {
    return this.prisma.warehouse.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
      select: { id: true, code: true, name: true, address: true, active: true },
    });
  }

  async createWarehouse(input: WarehouseCreate, actor: AuthUser): Promise<Warehouse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const w = await tx.warehouse.create({
          data: input,
          select: { id: true, code: true, name: true, address: true, active: true },
        });
        await tx.auditLog.create({
          data: { userId: actor.id, action: 'warehouse.create', entity: 'Warehouse', entityId: w.id, data: { ...input } },
        });
        return w;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Ce code de dépôt existe déjà');
      }
      throw e;
    }
  }

  async updateWarehouse(id: string, input: WarehouseUpdate, actor: AuthUser): Promise<Warehouse> {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.warehouse.findUnique({ where: { id } });
      if (!before) throw new NotFoundException('Dépôt introuvable');
      if (input.active === false && before.active) {
        // Pas de dépôt fermé avec une caisse ouverte ou du stock dedans.
        const [open, stock] = await Promise.all([
          tx.cashSession.count({ where: { warehouseId: id, closedAt: null } }),
          tx.stockLevel.count({ where: { warehouseId: id, quantity: { not: 0 } } }),
        ]);
        if (open) throw new ConflictException('Une caisse est ouverte dans ce dépôt');
        if (stock) throw new ConflictException('Ce dépôt contient encore du stock : transférez-le avant de le désactiver');
        const others = await tx.warehouse.count({ where: { active: true, id: { not: id } } });
        if (!others) throw new ConflictException('Il doit rester au moins un dépôt actif');
      }
      const w = await tx.warehouse.update({
        where: { id },
        data: input,
        select: { id: true, code: true, name: true, address: true, active: true },
      });
      await tx.auditLog.create({
        data: {
          userId: actor.id,
          action: 'warehouse.update',
          entity: 'Warehouse',
          entityId: id,
          data: diff({ name: before.name, address: before.address, active: before.active }, input),
        },
      });
      return w;
    });
  }
}

/** { champ: { from, to } } pour le journal d'activité. */
function diff(before: object, input: object): Prisma.InputJsonValue {
  const b = before as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(input)
      .filter(([k, v]) => v !== undefined && b[k] !== v)
      .map(([k, v]) => [k, { from: b[k] ?? null, to: v ?? null }]),
  ) as Prisma.InputJsonValue;
}
