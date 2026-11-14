import type { Prisma } from '../generated/prisma/client.js';
import { stockStatus, type MovementRow, type ProductRow } from '../shared/index.js';

const num = (d: Prisma.Decimal | null | undefined) => (d ? d.toNumber() : 0);

export const productInclude = (warehouseId?: string) =>
  ({
    category: { select: { id: true, name: true } },
    stockLevels: {
      where: warehouseId ? { warehouseId } : undefined,
      select: { quantity: true },
    },
  }) satisfies Prisma.ProductInclude;

type ProductWithStock = Prisma.ProductGetPayload<{ include: ReturnType<typeof productInclude> }>;

export function toProductRow(p: ProductWithStock): ProductRow {
  const stock = p.stockLevels.reduce((sum, l) => sum + l.quantity.toNumber(), 0);
  const alertThreshold = num(p.alertThreshold);
  return {
    id: p.id,
    sku: p.sku,
    barcode: p.barcode,
    name: p.name,
    category: p.category,
    unit: p.unit,
    salePrice: p.salePrice,
    vatRate: num(p.vatRate),
    averageCost: p.averageCost,
    alertThreshold,
    location: p.location,
    active: p.active,
    // Arrondi au millième : la somme de Decimal en number peut dériver.
    stock: Math.round(stock * 1000) / 1000,
    status: stockStatus(stock, alertThreshold),
  };
}

export const movementInclude = {
  product: { select: { id: true, sku: true, name: true, unit: true } },
  warehouse: { select: { id: true, code: true, name: true } },
  user: { select: { id: true, name: true } },
} satisfies Prisma.StockMovementInclude;

type MovementWithRefs = Prisma.StockMovementGetPayload<{ include: typeof movementInclude }>;

export function toMovementRow(m: MovementWithRefs): MovementRow {
  return {
    id: m.id,
    type: m.type,
    quantity: num(m.quantity),
    unitCost: m.unitCost,
    balanceAfter: num(m.balanceAfter),
    reason: m.reason,
    createdAt: m.createdAt.toISOString(),
    product: m.product,
    warehouse: m.warehouse,
    user: m.user,
  };
}
