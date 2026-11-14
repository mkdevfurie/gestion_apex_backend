import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import { auditCategories, periodSchema, type AuditCategory, type AuthUser, type Period } from '../shared/index.js';
import { ReportsService } from './reports.service.js';

const uuid = z.string().uuid();
const page = { page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };

const auditQuery = periodSchema.extend({
  userId: uuid.optional(),
  category: z.enum(Object.keys(auditCategories) as [AuditCategory, ...AuditCategory[]]).optional(),
  ...page,
});
const sessionsQuery = periodSchema.extend({
  userId: uuid.optional(),
  status: z.enum(['open', 'closed']).optional(),
  alertsOnly: z.stringbool().optional(),
  ...page,
});
const salesQuery = periodSchema.extend({ userId: uuid.optional(), q: z.string().trim().max(30).optional(), ...page });

/** Suivi de l'activité : administrateur et gérant. */
@Controller('reports')
@RequirePermission('viewReports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  overview(@Query({ schema: periodSchema }) q: Period) {
    return this.reports.overview(q);
  }

  @Get('daily')
  daily(@Query('days', { schema: z.coerce.number().int().min(1).max(90).default(14) }) days: number) {
    return this.reports.daily(days);
  }

  @Get('employees')
  employees(@Query({ schema: periodSchema }) q: Period) {
    return this.reports.employees(q);
  }

  @Get('top-products')
  topProducts(@Query({ schema: periodSchema }) q: Period) {
    return this.reports.topProducts(q);
  }

  @Get('audit')
  audit(@Query({ schema: auditQuery }) q: z.infer<typeof auditQuery>) {
    return this.reports.audit(q);
  }

  @Get('cash-sessions')
  cashSessions(@Query({ schema: sessionsQuery }) q: z.infer<typeof sessionsQuery>) {
    return this.reports.cashSessions(q);
  }

  @Get('sales')
  sales(@Query({ schema: salesQuery }) q: z.infer<typeof salesQuery>) {
    return this.reports.sales(q);
  }
}

/** Le caissier consulte ses propres ventes (toutes sessions) : « Mes ventes ». */
@Controller('me')
export class MyActivityController {
  constructor(private readonly reports: ReportsService) {}

  @Get('sales')
  @RequirePermission('sell')
  mySales(@Query({ schema: salesQuery.omit({ userId: true }) }) q: Omit<z.infer<typeof salesQuery>, 'userId'>, @CurrentUser() user: AuthUser) {
    return this.reports.sales({ ...q, userId: user.id });
  }

  @Get('overview')
  @RequirePermission('sell')
  async myDay(@Query({ schema: periodSchema }) q: Period, @CurrentUser() user: AuthUser) {
    const all = await this.reports.employees(q);
    return all.find((e) => e.userId === user.id) ?? null;
  }
}
