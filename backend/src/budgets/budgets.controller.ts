import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import { Roles } from '../auth/roles.decorator.js';
import {
  BudgetsService,
  type BudgetDetail,
  type BudgetSummary,
} from './budgets.service.js';
import { BudgetInputDto } from './dto/budget-input.dto.js';

@Controller()
@Roles('asesor', 'admin')
export class BudgetsController {
  constructor(
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
  ) {}

  /** POST /api/v1/checkins/{checkinId}/budgets (US1-AC1). */
  @Post('checkins/:checkinId/budgets')
  @HttpCode(201)
  async create(
    @Param('checkinId') checkinId: string,
    @Body() dto: BudgetInputDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BudgetDetail> {
    const budget = await this.budgets.create(checkinId, dto);
    res.setHeader('Location', `/${API_PREFIX}/budgets/${budget.id}`);
    return budget;
  }

  /** GET /api/v1/checkins/{checkinId}/budgets (US3-AC1). */
  @Get('checkins/:checkinId/budgets')
  listByCheckin(
    @Param('checkinId') checkinId: string,
  ): Promise<BudgetSummary[]> {
    return this.budgets.listByCheckin(checkinId);
  }

  /** GET /api/v1/vehicles/{vehicleId}/budgets (US3-AC1). */
  @Get('vehicles/:vehicleId/budgets')
  listByVehicle(
    @Param('vehicleId') vehicleId: string,
  ): Promise<BudgetSummary[]> {
    return this.budgets.listByVehicle(vehicleId);
  }

  @Get('budgets/:budgetId')
  getById(@Param('budgetId') budgetId: string): Promise<BudgetDetail> {
    return this.budgets.getById(budgetId);
  }

  /** PUT /api/v1/budgets/{budgetId}: replaces the lines of a draft (US1-AC2, D3). */
  @Put('budgets/:budgetId')
  update(
    @Param('budgetId') budgetId: string,
    @Body() dto: BudgetInputDto,
  ): Promise<BudgetDetail> {
    return this.budgets.replaceLines(budgetId, dto);
  }

  @Post('budgets/:budgetId/send')
  @HttpCode(200)
  send(@Param('budgetId') budgetId: string): Promise<BudgetDetail> {
    return this.budgets.send(budgetId);
  }

  @Post('budgets/:budgetId/approve')
  @HttpCode(200)
  approve(@Param('budgetId') budgetId: string): Promise<BudgetDetail> {
    return this.budgets.decide(budgetId, 'aprobado');
  }

  @Post('budgets/:budgetId/reject')
  @HttpCode(200)
  reject(@Param('budgetId') budgetId: string): Promise<BudgetDetail> {
    return this.budgets.decide(budgetId, 'rechazado');
  }
}
