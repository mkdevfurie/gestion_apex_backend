import { randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import type { MovementType } from '../generated/prisma/client.js';
import { isInbound, weightedAverageCost } from '../shared/index.js';

type Tx = Prisma.TransactionClient;
const { Decimal } = Prisma;

export class InsufficientStockError extends Error {
  constructor(
    readonly available: number,
    readonly requested: number,
  ) {
    super(`Stock insuffisant : ${available} disponible(s), ${requested} demandé(s)`);
  }
}

export class ProductNotFoundError extends Error {
  constructor() {
    super('Article introuvable');
  }
}

export type ApplyMovementInput = {
  type: MovementType;
  productId: string;
  warehouseId: string;
  /** Quantité positive : le sens est déduit du type. */
  quantity: number | Prisma.Decimal;
  /** Coût d'achat HT (réception). Sinon le PMP courant est utilisé. */
  unitCost?: number;
  reason?: string | null;
  userId: string;
  transferGroup?: string;
  invoiceId?: string;
  purchaseId?: string;
};

/**
 * Seul point d'écriture du stock. À appeler DANS une transaction :
 * 1. verrouille la ligne Product (FOR UPDATE) → tous les mouvements d'un même
 *    article sont sérialisés, y compris le recalcul du PMP ;
 * 2. refuse un stock négatif ;
 * 3. recalcule le PMP sur une réception fournisseur ;
 * 4. écrit le mouvement immuable puis met à jour le cache StockLevel.
 */
export async function applyMovement(tx: Tx, input: ApplyMovementInput) {
  const locked = await tx.$queryRaw<{ averageCost: number }[]>`
    SELECT "averageCost" FROM "Product" WHERE id = ${input.productId} FOR UPDATE`;
  if (locked.length === 0) throw new ProductNotFoundError();
  const averageCost = locked[0].averageCost;

  const inbound = isInbound(input.type);
  const qty = new Decimal(input.quantity);
  const signed = inbound ? qty : qty.negated();

  const level = await tx.stockLevel.findUnique({
    where: { productId_warehouseId: { productId: input.productId, warehouseId: input.warehouseId } },
  });
  const current = level?.quantity ?? new Decimal(0);
  const balanceAfter = current.plus(signed);

  if (!inbound && balanceAfter.isNegative()) {
    throw new InsufficientStockError(current.toNumber(), qty.toNumber());
  }

  let unitCost = averageCost;
  if (input.type === 'PURCHASE_RECEIPT') {
    if (input.unitCost === undefined) throw new Error("Coût d'achat manquant");
    unitCost = input.unitCost;
    // Le PMP est par article : on pondère avec le stock de tous les dépôts.
    const total = await tx.stockLevel.aggregate({
      where: { productId: input.productId },
      _sum: { quantity: true },
    });
    const newCost = weightedAverageCost(
      (total._sum.quantity ?? new Decimal(0)).toNumber(),
      averageCost,
      qty.toNumber(),
      input.unitCost,
    );
    await tx.product.update({ where: { id: input.productId }, data: { averageCost: newCost } });
  }

  const movement = await tx.stockMovement.create({
    data: {
      type: input.type,
      productId: input.productId,
      warehouseId: input.warehouseId,
      quantity: signed,
      unitCost,
      balanceAfter,
      reason: input.reason ?? null,
      userId: input.userId,
      transferGroup: input.transferGroup,
      invoiceId: input.invoiceId,
      purchaseId: input.purchaseId,
    },
  });

  await tx.stockLevel.upsert({
    where: { productId_warehouseId: { productId: input.productId, warehouseId: input.warehouseId } },
    create: { productId: input.productId, warehouseId: input.warehouseId, quantity: balanceAfter },
    update: { quantity: balanceAfter },
  });

  return movement;
}

/** Transfert entre dépôts : une sortie et une entrée liées, valorisées au PMP. */
export async function applyTransfer(
  tx: Tx,
  input: { productId: string; fromWarehouseId: string; toWarehouseId: string; quantity: number; reason?: string; userId: string },
) {
  const transferGroup = randomUUID();
  const common = { productId: input.productId, quantity: input.quantity, reason: input.reason, userId: input.userId, transferGroup };
  const out = await applyMovement(tx, { ...common, type: 'TRANSFER_OUT', warehouseId: input.fromWarehouseId });
  const into = await applyMovement(tx, { ...common, type: 'TRANSFER_IN', warehouseId: input.toWarehouseId });
  return { transferGroup, movements: [out, into] };
}

/** Inventaire : crée l'ajustement correspondant à l'écart compté (ou rien). */
export async function applyInventoryCount(
  tx: Tx,
  input: { productId: string; warehouseId: string; countedQuantity: number; reason?: string; userId: string },
) {
  // Verrouille l'article avant de lire le stock, comme applyMovement.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Product" WHERE id = ${input.productId} FOR UPDATE`;
  if (locked.length === 0) throw new ProductNotFoundError();

  const level = await tx.stockLevel.findUnique({
    where: { productId_warehouseId: { productId: input.productId, warehouseId: input.warehouseId } },
  });
  const current = level?.quantity ?? new Decimal(0);
  const diff = new Decimal(input.countedQuantity).minus(current);
  if (diff.isZero()) return { difference: 0, movement: null };

  const movement = await applyMovement(tx, {
    type: diff.isPositive() ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
    productId: input.productId,
    warehouseId: input.warehouseId,
    quantity: diff.abs(),
    reason: input.reason ?? 'Inventaire',
    userId: input.userId,
  });
  return { difference: diff.toNumber(), movement };
}
