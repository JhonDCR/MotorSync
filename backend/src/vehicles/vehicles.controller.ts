import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import { CreateVehicleDto } from './dto/create-vehicle.dto.js';
import { VehiclesService, type VehicleDetail } from './vehicles.service.js';

@Controller('vehicles')
export class VehiclesController {
  constructor(@Inject(VehiclesService) private readonly vehicles: VehiclesService) {}

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

  /** GET /api/v1/vehicles/{vehicleId}: 404 NOT_FOUND for missing, foreign or malformed ids. */
  @Get(':vehicleId')
  getById(@Param('vehicleId') vehicleId: string): Promise<VehicleDetail> {
    return this.vehicles.getById(vehicleId);
  }
}
