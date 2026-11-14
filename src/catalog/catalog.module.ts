import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  controllers: [CatalogController],
  providers: [ProductsService],
})
export class CatalogModule {}
