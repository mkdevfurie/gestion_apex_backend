import { Module } from '@nestjs/common';
import { CashSessionsService } from './cash-sessions.service.js';
import { PosController } from './pos.controller.js';
import { SalesService } from './sales.service.js';

@Module({
  controllers: [PosController],
  providers: [CashSessionsService, SalesService],
})
export class PosModule {}
