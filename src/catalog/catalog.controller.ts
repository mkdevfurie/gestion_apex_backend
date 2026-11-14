import { Body, ConflictException, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  can,
  categoryInputSchema,
  productInputSchema,
  productUpdateSchema,
  stockStatusSchema,
  type AuthUser,
  type Category,
  type ProductInput,
  type ProductUpdate,
} from '../shared/index.js';
import { CurrentUser, RequirePermission } from '../auth/auth.guard.js';
import { redactProductPage, redactProductDetail } from './redact.js';
import { ProductsService, type ProductQuery } from './products.service.js';

const uuid = z.string().uuid();

const productQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  categoryId: uuid.optional(),
  warehouseId: uuid.optional(),
  status: stockStatusSchema.optional(),
  includeInactive: z.stringbool().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

@Controller()
export class CatalogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
  ) {}

  @Get('categories')
  async categories(): Promise<Category[]> {
    const rows = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { products: { where: { active: true } } } } },
    });
    return rows.map((c) => ({ id: c.id, name: c.name, productCount: c._count.products }));
  }

  @Post('categories')
  @RequirePermission('manageCatalog')
  async createCategory(@Body({ schema: categoryInputSchema }) body: { name: string }): Promise<Category> {
    try {
      const c = await this.prisma.category.create({ data: body });
      return { id: c.id, name: c.name, productCount: 0 };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Cette catégorie existe déjà');
      }
      throw e;
    }
  }

  @Get('products')
  async list(@Query({ schema: productQuerySchema }) query: ProductQuery, @CurrentUser() user: AuthUser) {
    const page = await this.products.list(query);
    return can(user.role, 'viewCosts') ? page : redactProductPage(page);
  }

  @Get('products/:id')
  async detail(
    @Param('id', { schema: uuid }) id: string,
    @CurrentUser() user: AuthUser,
    @Query('warehouseId', { schema: uuid.optional() }) warehouseId?: string,
  ) {
    const detail = await this.products.detail(id, warehouseId);
    return can(user.role, 'viewCosts') ? detail : redactProductDetail(detail);
  }

  @Post('products')
  @RequirePermission('manageCatalog')
  create(@Body({ schema: productInputSchema }) body: ProductInput) {
    return this.products.create(body);
  }

  @Patch('products/:id')
  @RequirePermission('manageCatalog')
  update(@Param('id', { schema: uuid }) id: string, @Body({ schema: productUpdateSchema }) body: ProductUpdate) {
    return this.products.update(id, body);
  }
}
