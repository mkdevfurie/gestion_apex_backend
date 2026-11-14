import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  inventoryCountSchema,
  movementInputSchema,
  movementTypeSchema,
  transferInputSchema,
  type InventoryCount,
  type MovementInput,
  type TransferInput,
} from '../shared/index.js';
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
  movements(@Query({ schema: movementQuerySchema }) query: MovementQuery) {
    return this.stock.movements(query);
  }

  /** Réception fournisseur, retour client, perte, retour fournisseur. */
  @Post('movements')
  record(@Body({ schema: movementInputSchema }) body: MovementInput) {
    return this.stock.record(body);
  }

  /** Comptage d'inventaire : crée l'ajustement de l'écart. */
  @Post('inventory')
  inventory(@Body({ schema: inventoryCountSchema }) body: InventoryCount) {
    return this.stock.inventory(body);
  }

  @Post('transfers')
  transfer(@Body({ schema: transferInputSchema }) body: TransferInput) {
    return this.stock.transfer(body);
  }
}
