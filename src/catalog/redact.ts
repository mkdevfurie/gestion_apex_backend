import type { MovementRow, ProductDetail, ProductPage, ProductRow } from '../shared/index.js';

// Les coûts d'achat (PMP), la valorisation et les marges ne sortent pas de
// l'API pour les rôles sans la permission « viewCosts » (caissier).

export const redactProduct = <T extends ProductRow>(p: T): T => ({ ...p, averageCost: 0 });

export const redactMovement = (m: MovementRow): MovementRow => ({ ...m, unitCost: 0 });

export function redactProductPage(page: ProductPage): ProductPage {
  return { ...page, items: page.items.map(redactProduct), summary: { ...page.summary, valuation: 0 } };
}

export function redactProductDetail(d: ProductDetail): ProductDetail {
  return { ...redactProduct(d), movements: d.movements.map(redactMovement) };
}
