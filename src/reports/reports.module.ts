import { Module } from '@nestjs/common';
import { MyActivityController, ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  controllers: [ReportsController, MyActivityController],
  providers: [ReportsService],
})
export class ReportsModule {}
