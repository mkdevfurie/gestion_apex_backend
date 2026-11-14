import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CatalogSummary,
  ProductDetail,
  ProductInput,
  ProductPage,
  ProductRow,
  ProductUpdate,
  StockStatus,
} from '../shared/index.js';
import { movementInclude, productInclude, toMovementRow, toProductRow } from './mappers.js';

export type ProductQuery = {
  q?: string;
  categoryId?: string;
  warehouseId?: string;
  status?: StockStatus;
  includeInactive?: boolean;
  page: number;
  pageSize: number;
};

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liste paginée. L'état (rupture / stock bas) dépend du stock agrégé : le
   * filtre est appliqué en mémoire après lecture. Suffisant pour quelques
   * milliers d'articles ; à passer en SQL (vue matérialisée) au-delà.
   */
  async list(query: ProductQuery): Promise<ProductPage> {
    const where: Prisma.ProductWhereInput = {
      active: query.includeInactive ? undefined : true,
      categoryId: query.categoryId,
    };
    if (query.q) {
      const q = query.q.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
        { barcode: { startsWith: q } },
      ];
    }

    const [products, summary] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: productInclude(query.warehouseId),
        orderBy: { name: 'asc' },
      }),
      this.summary(query.warehouseId),
    ]);

    let rows = products.map(toProductRow);
    if (query.status) rows = rows.filter((r) => r.status === query.status);

    const start = (query.page - 1) * query.pageSize;
    return {
      items: rows.slice(start, start + query.pageSize),
      total: rows.length,
      page: query.page,
      pageSize: query.pageSize,
      summary,
    };
  }

  /** Indicateurs du catalogue (articles actifs), indépendants de la recherche. */
  async summary(warehouseId?: string): Promise<CatalogSummary> {
    const [products, movementCount] = await Promise.all([
      this.prisma.product.findMany({ where: { active: true }, include: productInclude(warehouseId) }),
      this.prisma.stockMovement.count({ where: { warehouseId } }),
    ]);
    const rows = products.map(toProductRow);
    return {
      valuation: rows.reduce((s, r) => s + Math.max(r.stock, 0) * r.averageCost, 0),
      activeCount: rows.length,
      lowCount: rows.filter((r) => r.status === 'LOW').length,
      outCount: rows.filter((r) => r.status === 'OUT').length,
      movementCount,
    };
  }

  async detail(id: string, warehouseId?: string): Promise<ProductDetail> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: productInclude(warehouseId),
    });
    if (!product) throw new NotFoundException('Article introuvable');

    const [levels, movements] = await Promise.all([
      this.prisma.stockLevel.findMany({
        where: { productId: id },
        include: { warehouse: { select: { code: true, name: true } } },
        orderBy: { warehouse: { code: 'asc' } },
      }),
      this.prisma.stockMovement.findMany({
        where: { productId: id, warehouseId },
        include: movementInclude,
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    return {
      ...toProductRow(product),
      stockByWarehouse: levels.map((l) => ({
        warehouseId: l.warehouseId,
        code: l.warehouse.code,
        name: l.warehouse.name,
        quantity: l.quantity.toNumber(),
      })),
      movements: movements.map(toMovementRow),
    };
  }

  async create(input: ProductInput): Promise<ProductRow> {
    try {
      const product = await this.prisma.product.create({
        data: input,
        include: productInclude(),
      });
      return toProductRow(product);
    } catch (e) {
      throw this.mapUniqueError(e);
    }
  }

  /** Ne modifie jamais le stock ni le PMP : ils ne bougent que par mouvement. */
  async update(id: string, input: ProductUpdate): Promise<ProductRow> {
    try {
      const product = await this.prisma.product.update({
        where: { id },
        data: input,
        include: productInclude(),
      });
      return toProductRow(product);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Article introuvable');
      }
      throw this.mapUniqueError(e);
    }
  }

  private mapUniqueError(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = JSON.stringify(e.meta ?? {});
      return new ConflictException(
        target.includes('barcode') ? 'Ce code-barres est déjà utilisé' : 'Cette référence (SKU) existe déjà',
      );
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
      return new ConflictException('Catégorie inconnue');
    }
    return e;
  }
}
