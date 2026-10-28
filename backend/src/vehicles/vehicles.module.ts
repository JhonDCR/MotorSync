import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { OwnershipService } from './ownership.service.js';
import { VehicleHistoryService } from './vehicle-history.service.js';
import { VehiclesController } from './vehicles.controller.js';
import { VehiclesService } from './vehicles.service.js';

@Module({
  imports: [AuditModule],
  controllers: [VehiclesController],
  providers: [VehiclesService, OwnershipService, VehicleHistoryService],
  exports: [VehiclesService, VehicleHistoryService],
})
export class VehiclesModule {}
