import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import { Roles } from '../auth/roles.decorator.js';
import { AssigneeDto, BoardQueryDto, CancelWorkOrderDto, NoteDto } from './dto/work-order-input.dto.js';
import { WorkOrdersService, type WorkOrderDetail, type WorkOrderSummary } from './work-orders.service.js';

@Controller()
@Roles('asesor', 'admin')
export class WorkOrdersController {
  constructor(@Inject(WorkOrdersService) private readonly workOrders: WorkOrdersService) {}

  /** POST /api/v1/budgets/{budgetId}/work-orders (US1-AC1, US1-AC2). */
  @Post('budgets/:budgetId/work-orders')
  @HttpCode(201)
  async create(
    @Param('budgetId') budgetId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WorkOrderDetail> {
    const wo = await this.workOrders.create(budgetId);
    res.setHeader('Location', `/${API_PREFIX}/work-orders/${wo.id}`);
    return wo;
  }

  /** GET /api/v1/work-orders (US3-AC1). */
  @Get('work-orders')
  board(@Query() query: BoardQueryDto): Promise<WorkOrderSummary[]> {
    return this.workOrders.board(query.status, query.limit ?? 50);
  }

  @Get('vehicles/:vehicleId/work-orders')
  listByVehicle(@Param('vehicleId') vehicleId: string): Promise<WorkOrderSummary[]> {
    return this.workOrders.listByVehicle(vehicleId);
  }

  @Get('work-orders/:id')
  getById(@Param('id') id: string): Promise<WorkOrderDetail> {
    return this.workOrders.getById(id);
  }

  @Post('work-orders/:id/start')
  @HttpCode(200)
  start(@Param('id') id: string): Promise<WorkOrderDetail> {
    return this.workOrders.transition(id, 'start');
  }

  @Post('work-orders/:id/finish')
  @HttpCode(200)
  finish(@Param('id') id: string): Promise<WorkOrderDetail> {
    return this.workOrders.transition(id, 'finish');
  }

  @Post('work-orders/:id/deliver')
  @HttpCode(200)
  deliver(@Param('id') id: string): Promise<WorkOrderDetail> {
    return this.workOrders.transition(id, 'deliver');
  }

  @Post('work-orders/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Body() dto: CancelWorkOrderDto): Promise<WorkOrderDetail> {
    return this.workOrders.cancel(id, dto.reason);
  }

  /** US1-AC3: only admin reassigns. */
  @Patch('work-orders/:id/assignee')
  @Roles('admin')
  assign(@Param('id') id: string, @Body() dto: AssigneeDto): Promise<WorkOrderDetail> {
    return this.workOrders.assign(id, dto.userId);
  }

  @Post('work-orders/:id/notes')
  @HttpCode(201)
  addNote(@Param('id') id: string, @Body() dto: NoteDto): Promise<WorkOrderDetail> {
    return this.workOrders.addNote(id, dto.body);
  }
}
