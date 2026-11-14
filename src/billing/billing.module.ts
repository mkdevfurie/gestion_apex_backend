import { Module } from '@nestjs/common';
import { PosModule } from '../pos/pos.module.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';

@Module({ imports: [PosModule], controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}
