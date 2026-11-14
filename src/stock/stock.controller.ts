import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  can,
  inventoryCountSchema,
  movementInputSchema,
  movementTypeSchema,
  transferInputSchema,
  type InventoryCount,
  type MovementInput,
  type AuthUser,
  type TransferInput,
} from '../shared/index.js';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import { redactMovement } from '../catalog/redact.js';
import { StockService, type MovementQuery } from './stock.service.js';

const movementQuerySchema = z.object({
  productId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  type: movementTypeSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

@Controller('stock')
export class StockController {
  constructor(private readonly stock: StockService) {}

  /** Journal immuable des mouvements, du plus récent au plus ancien. */
  @Get('movements')
  async movements(@Query({ schema: movementQuerySchema }) query: MovementQuery, @CurrentUser() user: AuthUser) {
    const page = await this.stock.movements(query);
    return can(user.role, 'viewCosts') ? page : { ...page, items: page.items.map(redactMovement) };
  }

  /** Réception fournisseur, retour client, perte, retour fournisseur. */
  @Post('movements')
  @RequirePermission('moveStock')
  record(@Body({ schema: movementInputSchema }) body: MovementInput, @CurrentUser() user: AuthUser) {
    return this.stock.record(body, user.id);
  }

  /** Comptage d'inventaire : crée l'ajustement de l'écart. */
  @Post('inventory')
  @RequirePermission('moveStock')
  inventory(@Body({ schema: inventoryCountSchema }) body: InventoryCount, @CurrentUser() user: AuthUser) {
    return this.stock.inventory(body, user.id);
  }

  @Post('transfers')
  @RequirePermission('moveStock')
  transfer(@Body({ schema: transferInputSchema }) body: TransferInput, @CurrentUser() user: AuthUser) {
    return this.stock.transfer(body, user.id);
  }
}
