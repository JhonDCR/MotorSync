import { Controller, Get, Inject, Query } from '@nestjs/common';
import { SupportArea } from './support-area.decorator.js';
import { ListAccessLogDto } from './dto/list-access-log.dto.js';
import {
  SupportAccessLogService,
  type AccessLogPage,
} from './support-access-log.service.js';

/**
 * Read-only support access log (US4-AC8, US4-AC9, FR-027). It runs inside the transaction of
 * SupportTransactionInterceptor and belongs to the support zone: a workshop token gets 403
 * FORBIDDEN. There is deliberately no POST, PUT, PATCH or DELETE: any of them stays 404, and
 * reading the log never writes to it.
 */
@SupportArea()
@Controller('support/access-log')
export class SupportAccessLogController {
  constructor(
    @Inject(SupportAccessLogService)
    private readonly accessLog: SupportAccessLogService,
  ) {}

  /** GET /api/v1/support/access-log (US4-AC8): newest first, 50 per page. */
  @Get()
  listAccessLog(@Query() query: ListAccessLogDto): Promise<AccessLogPage> {
    return this.accessLog.listAccessLog(query);
  }
}
