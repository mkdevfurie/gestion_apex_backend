import { Module } from '@nestjs/common';
import { CurrentUserService } from '../common/current-user.service.js';
import { StockController } from './stock.controller.js';
import { StockService } from './stock.service.js';

@Module({
  controllers: [StockController],
  providers: [StockService, CurrentUserService],
})
export class StockModule {}
