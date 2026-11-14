import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  can,
  cashSessionCloseSchema,
  cashSessionOpenSchema,
  saleInputSchema,
  type AuthUser,
  type CashSessionClose,
  type CashSessionOpen,
  type SaleInput,
} from '../shared/index.js';
import { CashSessionsService } from './cash-sessions.service.js';
import { SalesService } from './sales.service.js';

const uuid = z.string().uuid();

@Controller()
export class PosController {
  constructor(
    private readonly sessions: CashSessionsService,
    private readonly sales: SalesService,
    private readonly prisma: PrismaService,
  ) {}

  /** Ma caisse ouverte (ou null). */
  @Get('cash-sessions/current')
  @RequirePermission('sell')
  async current(@CurrentUser() user: AuthUser) {
    return { session: await this.sessions.current(user) };
  }

  @Post('cash-sessions')
  @RequirePermission('sell')
  open(@Body({ schema: cashSessionOpenSchema }) body: CashSessionOpen, @CurrentUser() user: AuthUser) {
    return this.sessions.open(body, user);
  }

  /** Clôture + ticket Z. */
  @Post('cash-sessions/:id/close')
  @RequirePermission('sell')
  close(
    @Param('id', { schema: uuid }) id: string,
    @Body({ schema: cashSessionCloseSchema }) body: CashSessionClose,
    @CurrentUser() user: AuthUser,
  ) {
    return this.sessions.close(id, body, user);
  }

  @Get('cash-sessions/:id/sales')
  @RequirePermission('sell')
  async sessionSales(@Param('id', { schema: uuid }) id: string, @CurrentUser() user: AuthUser) {
    await this.assertCanSee(id, user);
    return this.sales.listForSession(id);
  }

  @Post('sales')
  @RequirePermission('sell')
  create(@Body({ schema: saleInputSchema }) body: SaleInput, @CurrentUser() user: AuthUser) {
    return this.sales.create(body, user);
  }

  /** Réimpression (duplicata). */
  @Get('sales/:id/receipt')
  @RequirePermission('sell')
  async receipt(@Param('id', { schema: uuid }) id: string, @CurrentUser() user: AuthUser) {
    const inv = await this.prisma.invoice.findUnique({ where: { id }, select: { userId: true } });
    if (!inv) throw new NotFoundException('Ticket introuvable');
    if (inv.userId !== user.id && !can(user.role, 'manageCatalog')) {
      throw new ForbiddenException('Ce ticket a été émis par un autre caissier');
    }
    return this.sales.receipt(id);
  }

  /** Un caissier ne voit que ses sessions ; gérant et administrateur toutes. */
  private async assertCanSee(sessionId: string, user: AuthUser) {
    const s = await this.prisma.cashSession.findUnique({ where: { id: sessionId }, select: { openedById: true } });
    if (!s) throw new NotFoundException('Session de caisse introuvable');
    if (s.openedById !== user.id && !can(user.role, 'manageCatalog')) {
      throw new ForbiddenException('Cette caisse appartient à un autre utilisateur');
    }
  }
}
