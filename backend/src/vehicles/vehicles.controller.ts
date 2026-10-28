import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import { Roles } from '../auth/roles.decorator.js';
import { CreateVehicleDto } from './dto/create-vehicle.dto.js';
import { OwnershipTransferDto } from './dto/ownership-transfer.dto.js';
import { UpdateVehicleDto } from './dto/update-vehicle.dto.js';
import type { VehicleClinicalHistoryDto } from './dto/vehicle-history.dto.js';
import { OwnershipService, type OwnershipHistoryResponse } from './ownership.service.js';
import { VehicleHistoryService } from './vehicle-history.service.js';
import {
  VehiclesService,
  type VehicleDetail,
  type VehicleSearchResponse,
} from './vehicles.service.js';

@Controller('vehicles')
export class VehiclesController {
  constructor(
    @Inject(VehiclesService) private readonly vehicles: VehiclesService,
    @Inject(OwnershipService) private readonly ownership: OwnershipService,
    @Inject(VehicleHistoryService) private readonly historyService: VehicleHistoryService,
  ) {}

  /** POST /api/v1/vehicles (US3): 201 with Location /api/v1/vehicles/{id}. */
  @Post()
  @HttpCode(201)
  async create(
    @Body() dto: CreateVehicleDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VehicleDetail> {
    const vehicle = await this.vehicles.create(dto);
    res.setHeader('Location', `/${API_PREFIX}/vehicles/${vehicle.id}`);
    return vehicle;
  }

  /**
   * GET /api/v1/vehicles/search?q= (US1). Declared before :vehicleId so that "search" is never
   * taken as a vehicle id. 400 SEARCH_TERM_TOO_SHORT under 2 characters after normalizing.
   */
  @Get('search')
  search(@Query('q') q?: string | string[]): Promise<VehicleSearchResponse> {
    return this.vehicles.searchVehicles(q);
  }

  /**
   * POST /api/v1/vehicles/{vehicleId}/ownership-transfers (US4-AC7 to AC9): 200 VehicleDetail
   * with the new owner. Declared before the bare :vehicleId routes.
   */
  @Post(':vehicleId/ownership-transfers')
  @HttpCode(200)
  transfer(
    @Param('vehicleId') vehicleId: string,
    @Body() dto: OwnershipTransferDto,
  ): Promise<VehicleDetail> {
    return this.ownership.transfer(vehicleId, dto);
  }

  /** GET /api/v1/vehicles/{vehicleId}/ownership-history (US4-AC10): newest first, read-only. */
  @Get(':vehicleId/ownership-history')
  history(@Param('vehicleId') vehicleId: string): Promise<OwnershipHistoryResponse> {
    return this.ownership.history(vehicleId);
  }

  /** GET /api/v1/vehicles/{vehicleId}/history (007, US1, US2). Consolidated clinical history and metrics. */
  @Get(':vehicleId/history')
  @Roles('asesor', 'admin')
  clinicalHistory(
    @Param('vehicleId') vehicleId: string,
  ): Promise<VehicleClinicalHistoryDto> {
    return this.historyService.getClinicalHistory(vehicleId);
  }

  /** GET /api/v1/vehicles/{vehicleId}: 404 NOT_FOUND for missing, foreign or malformed ids. */
  @Get(':vehicleId')
  getById(@Param('vehicleId') vehicleId: string): Promise<VehicleDetail> {
    return this.vehicles.getById(vehicleId);
  }

  /**
   * PATCH /api/v1/vehicles/{vehicleId} (US4-AC5, AC6, AC11, AC12; US3-AC14): 200 VehicleDetail
   * with version + 1; the owner only changes through ownership-transfers.
   */
  @Patch(':vehicleId')
  update(
    @Param('vehicleId') vehicleId: string,
    @Body() dto: UpdateVehicleDto,
  ): Promise<VehicleDetail> {
    return this.vehicles.update(vehicleId, dto);
  }
}
