import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import {
  accountPaymentSchema,
  purchaseInputSchema,
  supplierInputSchema,
  supplierUpdateSchema,
  type AccountPayment,
  type AuthUser,
  type PurchaseInput,
  type SupplierInput,
  type SupplierUpdate,
} from '../shared/index.js';
import { PurchasesService } from './purchases.service.js';

const uuid = z.string().uuid();
const page = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };
const supplierQuery = z.object({ q: z.string().trim().max(80).optional(), includeInactive: z.stringbool().optional(), ...page });
const purchaseQuery = z.object({ supplierId: uuid.optional(), unpaidOnly: z.stringbool().optional(), ...page });

@Controller()
@RequirePermission('managePurchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get('suppliers')
  suppliers(@Query({ schema: supplierQuery }) q: z.infer<typeof supplierQuery>) {
    return this.purchases.suppliers(q);
  }

  @Post('suppliers')
  createSupplier(@Body({ schema: supplierInputSchema }) body: SupplierInput, @CurrentUser() user: AuthUser) {
    return this.purchases.createSupplier(body, user);
  }

  @Patch('suppliers/:id')
  updateSupplier(@Param('id', { schema: uuid }) id: string, @Body({ schema: supplierUpdateSchema }) body: SupplierUpdate, @CurrentUser() user: AuthUser) {
    return this.purchases.updateSupplier(id, body, user);
  }

  /** Règlement fournisseur : sortie d'argent, gérant ou administrateur. */
  @Post('suppliers/:id/payments')
  @RequirePermission('paySuppliers')
  pay(@Param('id', { schema: uuid }) id: string, @Body({ schema: accountPaymentSchema }) body: AccountPayment, @CurrentUser() user: AuthUser) {
    return this.purchases.paySupplier(id, body, user);
  }

  @Get('purchases')
  list(@Query({ schema: purchaseQuery }) q: z.infer<typeof purchaseQuery>) {
    return this.purchases.list(q);
  }

  @Get('purchases/:id')
  detail(@Param('id', { schema: uuid }) id: string) {
    return this.purchases.detail(id);
  }

  /** Bon de réception : entrée en stock + dette fournisseur. Les règlements à la réception exigent le droit de payer. */
  @Post('purchases')
  receive(@Body({ schema: purchaseInputSchema }) body: PurchaseInput, @CurrentUser() user: AuthUser) {
    if (body.payments.length && !['ADMIN', 'MANAGER'].includes(user.role)) body = { ...body, payments: [] };
    return this.purchases.receive(body, user);
  }
}
