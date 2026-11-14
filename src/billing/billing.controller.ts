import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import {
  can,
  quoteConvertSchema,
  quoteInputSchema,
  refundInputSchema,
  type AuthUser,
  type QuoteConvert,
  type QuoteInput,
  type RefundInput,
} from '../shared/index.js';
import { BillingService, type DocumentQuery } from './billing.service.js';

const uuid = z.string().uuid();
const listQuery = z.object({
  kind: z.enum(['QUOTE', 'TICKET', 'INVOICE', 'CREDIT_NOTE']).optional(),
  customerId: uuid.optional(),
  q: z.string().trim().max(30).optional(),
  unpaidOnly: z.stringbool().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

@Controller('documents')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Factures, devis, avoirs (et tickets) : gérant, administrateur ; le caissier voit les comptes clients. */
  @Get()
  @RequirePermission('manageCustomers')
  list(@Query({ schema: listQuery }) q: DocumentQuery) {
    return this.billing.list(q);
  }

  @Get(':id')
  @RequirePermission('manageCustomers')
  detail(@Param('id', { schema: uuid }) id: string) {
    return this.billing.detail(id);
  }

  @Post('quotes')
  @RequirePermission('issueInvoices')
  createQuote(@Body({ schema: quoteInputSchema }) body: QuoteInput, @CurrentUser() user: AuthUser) {
    return this.billing.createQuote(body, user);
  }

  @Post(':id/convert')
  @RequirePermission('issueInvoices')
  convert(@Param('id', { schema: uuid }) id: string, @Body({ schema: quoteConvertSchema }) body: QuoteConvert, @CurrentUser() user: AuthUser) {
    return this.billing.convertQuote(id, body, user);
  }

  /** Retour client → avoir. Gérant et administrateur uniquement. */
  @Post(':id/refund')
  @RequirePermission('issueInvoices')
  refund(@Param('id', { schema: uuid }) id: string, @Body({ schema: refundInputSchema }) body: RefundInput, @CurrentUser() user: AuthUser) {
    return this.billing.refund(id, body, user);
  }
}

export const canSeeDocuments = (u: AuthUser) => can(u.role, 'manageCustomers');
