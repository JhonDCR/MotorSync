import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { SupportArea } from './support-area.decorator.js';
import { ListWorkshopsDto } from './dto/list-workshops.dto.js';
import {
  SupportWorkshopsService,
  type WorkshopAccountsResponse,
  type WorkshopPage,
} from './support-workshops.service.js';

/**
 * Workshop list/search and workshop accounts (US4). Every route runs inside the transaction of
 * SupportTransactionInterceptor and belongs to the support zone: a workshop token gets 403
 * FORBIDDEN (FR-025). There is no route for business data or for a global account listing
 * (US4-AC4, US4-AC5): they stay 404.
 */
@SupportArea()
@Controller('support/workshops')
export class SupportWorkshopsController {
  constructor(
    @Inject(SupportWorkshopsService)
    private readonly workshops: SupportWorkshopsService,
  ) {}

  /** GET /api/v1/support/workshops (US4-AC1, US4-AC2): 50 per page, by name. */
  @Get()
  listWorkshops(@Query() query: ListWorkshopsDto): Promise<WorkshopPage> {
    return this.workshops.listWorkshops(query);
  }

  /** GET /api/v1/support/workshops/{workshopId}/accounts (US4-AC3): logs the access. */
  @Get(':workshopId/accounts')
  listWorkshopAccounts(
    @Param('workshopId') workshopId: string,
  ): Promise<WorkshopAccountsResponse> {
    return this.workshops.listWorkshopAccounts(workshopId);
  }
}
