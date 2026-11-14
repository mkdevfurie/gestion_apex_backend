import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { movementInclude, toMovementRow } from '../catalog/mappers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  InventoryBatch,
  InventoryCount,
  InventoryReport,
  MovementInput,
  MovementRow,
  MovementType,
  TransferInput,
} from '../shared/index.js';
import {
  InsufficientStockError,
  ProductNotFoundError,
  applyInventoryCount,
  applyMovement,
  applyTransfer,
} from './apply-movement.js';

export type MovementQuery = {
  productId?: string;
  warehouseId?: string;
  type?: MovementType;
  page: number;
  pageSize: number;
};

@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  async movements(query: MovementQuery) {
    const where: Prisma.StockMovementWhereInput = {
      productId: query.productId,
      warehouseId: query.warehouseId,
      type: query.type,
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        include: movementInclude,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return { items: rows.map(toMovementRow), total, page: query.page, pageSize: query.pageSize };
  }

  async record(input: MovementInput, userId: string): Promise<MovementRow> {
    return this.run(async (tx) => {
      await this.assertWarehouse(tx, input.warehouseId);
      const m = await applyMovement(tx, { ...input, userId });
      await this.audit(tx, userId, 'stock.movement', m.id, input);
      return this.load(tx, m.id);
    });
  }

  async inventory(input: InventoryCount, userId: string) {
    return this.run(async (tx) => {
      await this.assertWarehouse(tx, input.warehouseId);
      const { difference, movement } = await applyInventoryCount(tx, { ...input, userId });
      if (movement) {
        await this.audit(tx, userId, 'stock.inventory', movement.id, { ...input, difference });
      }
      return { difference, movement: movement ? await this.load(tx, movement.id) : null };
    });
  }

  /**
   * Inventaire complet d'un dépôt : un ajustement par écart, tout ou rien.
   * Les articles non comptés ne sont pas touchés.
   */
  async inventoryBatch(input: InventoryBatch, userId: string): Promise<InventoryReport> {
    if (new Set(input.counts.map((c) => c.productId)).size !== input.counts.length) {
      throw new BadRequestException('Un article est compté deux fois');
    }
    return this.run(async (tx) => {
      await this.assertWarehouse(tx, input.warehouseId);
      const products = await tx.product.findMany({
        where: { id: { in: input.counts.map((c) => c.productId) } },
        select: { id: true, sku: true, name: true, averageCost: true },
      });
      const byId = new Map(products.map((p) => [p.id, p]));
      if (byId.size !== input.counts.length) throw new NotFoundException('Article introuvable');
      const report: InventoryReport = { adjusted: 0, unchanged: 0, valueDifference: 0, lines: [] };
      for (const c of [...input.counts].sort((a, b) => a.productId.localeCompare(b.productId))) {
        const { difference } = await applyInventoryCount(tx, {
          productId: c.productId,
          warehouseId: input.warehouseId,
          countedQuantity: c.countedQuantity,
          reason: input.reason ?? 'Inventaire complet',
          userId,
        });
        const p = byId.get(c.productId)!;
        if (difference === 0) report.unchanged++;
        else {
          report.adjusted++;
          report.valueDifference += Math.round(difference * p.averageCost);
        }
        report.lines.push({ productId: p.id, sku: p.sku, name: p.name, before: c.countedQuantity - difference, counted: c.countedQuantity, difference });
      }
      await this.audit(tx, userId, 'stock.inventory_batch', input.warehouseId, {
        warehouseId: input.warehouseId,
        adjusted: report.adjusted,
        unchanged: report.unchanged,
        valueDifference: report.valueDifference,
      });
      report.lines.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
      return report;
    }, 120_000);
  }

  async transfer(input: TransferInput, userId: string) {
    return this.run(async (tx) => {
      await this.assertWarehouse(tx, input.fromWarehouseId);
      await this.assertWarehouse(tx, input.toWarehouseId);
      const { transferGroup, movements } = await applyTransfer(tx, { ...input, userId });
      await this.audit(tx, userId, 'stock.transfer', transferGroup, input);
      return {
        transferGroup,
        movements: await Promise.all(movements.map((m) => this.load(tx, m.id))),
      };
    });
  }

  /** Transaction + traduction des erreurs métier en réponses HTTP. */
  private async run<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, timeout = 15_000): Promise<T> {
    try {
      // maxWait : Neon met la base en veille après quelques minutes d'inactivité ;
      // le réveil dépasse souvent les 2 s accordées par défaut pour ouvrir la transaction.
      return await this.prisma.$transaction(fn, { maxWait: 10_000, timeout });
    } catch (e) {
      if (e instanceof InsufficientStockError) throw new ConflictException(e.message);
      if (e instanceof ProductNotFoundError) throw new NotFoundException(e.message);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2028') {
        throw new ServiceUnavailableException(
          'La base de données met trop de temps à répondre. Réessayez dans quelques secondes.',
        );
      }
      throw e;
    }
  }

  private async assertWarehouse(tx: Prisma.TransactionClient, id: string) {
    const w = await tx.warehouse.findFirst({ where: { id, active: true }, select: { id: true } });
    if (!w) throw new NotFoundException('Dépôt introuvable ou inactif');
  }

  private async load(tx: Prisma.TransactionClient, id: string) {
    const m = await tx.stockMovement.findUniqueOrThrow({ where: { id }, include: movementInclude });
    return toMovementRow(m);
  }

  private audit(tx: Prisma.TransactionClient, userId: string, action: string, entityId: string, data: object) {
    return tx.auditLog.create({
      data: { userId, action, entity: 'StockMovement', entityId, data: data as Prisma.InputJsonValue },
    });
  }
}
