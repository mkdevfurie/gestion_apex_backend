import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import {
  accountPaymentSchema,
  customerInputSchema,
  customerUpdateSchema,
  type AccountPayment,
  type AuthUser,
  type CustomerInput,
  type CustomerUpdate,
} from '../shared/index.js';
import { CustomersService } from './customers.service.js';

const uuid = z.string().uuid();
const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  withBalance: z.stringbool().optional(),
  includeInactive: z.stringbool().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

@Controller('customers')
@RequirePermission('manageCustomers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Query({ schema: listQuery }) q: z.infer<typeof listQuery>) {
    return this.customers.list(q);
  }

  @Get('receivables')
  @RequirePermission('viewReports')
  receivables() {
    return this.customers.receivables();
  }

  @Get(':id')
  get(@Param('id', { schema: uuid }) id: string) {
    return this.customers.get(id);
  }

  @Post()
  create(@Body({ schema: customerInputSchema }) body: CustomerInput, @CurrentUser() user: AuthUser) {
    return this.customers.create(body, user);
  }

  @Patch(':id')
  update(@Param('id', { schema: uuid }) id: string, @Body({ schema: customerUpdateSchema }) body: CustomerUpdate, @CurrentUser() user: AuthUser) {
    return this.customers.update(id, body, user);
  }

  /** Encaissement d'une créance (imputé aux factures les plus anciennes). */
  @Post(':id/payments')
  pay(@Param('id', { schema: uuid }) id: string, @Body({ schema: accountPaymentSchema }) body: AccountPayment, @CurrentUser() user: AuthUser) {
    return this.customers.receivePayment(id, body, user);
  }
}
