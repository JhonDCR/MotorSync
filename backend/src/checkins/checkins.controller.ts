import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import { Roles } from '../auth/roles.decorator.js';
import { CheckinsService, type CheckinDetail, type CheckinSummary } from './checkins.service.js';
import { CreateCheckinDto } from './dto/create-checkin.dto.js';

/** Check-ins are immutable (US2-AC3): no PUT, PATCH or DELETE routes exist. */
@Controller()
@Roles('asesor', 'admin')
export class CheckinsController {
  constructor(@Inject(CheckinsService) private readonly checkins: CheckinsService) {}

  /** POST /api/v1/vehicles/{vehicleId}/checkins (US1); 25 MB body limit set in app.setup. */
  @Post('vehicles/:vehicleId/checkins')
  @HttpCode(201)
  async create(
    @Param('vehicleId') vehicleId: string,
    @Body() dto: CreateCheckinDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CheckinDetail> {
    const checkin = await this.checkins.create(vehicleId, dto);
    res.setHeader('Location', `/${API_PREFIX}/checkins/${checkin.id}`);
    return checkin;
  }

  /** GET /api/v1/vehicles/{vehicleId}/checkins (US2-AC1): newest first. */
  @Get('vehicles/:vehicleId/checkins')
  list(@Param('vehicleId') vehicleId: string): Promise<CheckinSummary[]> {
    return this.checkins.listByVehicle(vehicleId);
  }

  /** GET /api/v1/checkins/{checkinId} (US2-AC1). */
  @Get('checkins/:checkinId')
  getById(@Param('checkinId') checkinId: string): Promise<CheckinDetail> {
    return this.checkins.getById(checkinId);
  }

  /** GET /api/v1/checkins/{checkinId}/images/{imageId}: raw bytes with their mime. */
  @Get('checkins/:checkinId/images/:imageId')
  async image(
    @Param('checkinId') checkinId: string,
    @Param('imageId') imageId: string,
    @Res() res: Response,
  ): Promise<void> {
    const image = await this.checkins.getImage(checkinId, imageId);
    res.setHeader('Content-Type', image.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(image.data);
  }
}
