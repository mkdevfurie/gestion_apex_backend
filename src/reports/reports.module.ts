import { Module } from '@nestjs/common';
import { ExportsController } from './exports.controller.js';
import { MyActivityController, ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

@Module({
  controllers: [ReportsController, MyActivityController, ExportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
