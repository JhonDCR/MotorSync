import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { WorkOrdersController } from './work-orders.controller.js';
import { WorkOrdersService } from './work-orders.service.js';

@Module({
  imports: [AuditModule],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService],
})
export class WorkOrdersModule {}
