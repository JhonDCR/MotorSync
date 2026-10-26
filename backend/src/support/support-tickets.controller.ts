import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import { SupportArea } from './support-area.decorator.js';
import { DiscardTicketDto } from './dto/discard-ticket.dto.js';
import { GenerateTemporaryPasswordDto } from './dto/generate-temporary-password.dto.js';
import {
  SupportPasswordService,
  type TemporaryPasswordResponse,
} from './support-password.service.js';
import {
  SupportTicketsService,
  type TicketDetail,
  type TicketSummary,
} from './support-tickets.service.js';

/**
 * Support inbox (US2) and temporary password generation (US3). Every route runs inside the
 * transaction of SupportTransactionInterceptor and belongs to the support zone: a workshop token
 * gets 403 FORBIDDEN and an agent with a pending password change gets 403 PASSWORD_CHANGE_REQUIRED
 * (no @AllowPendingPasswordChange() here). There is no @Roles(): any support agent can read,
 * discard and resolve tickets.
 */
@SupportArea()
@Controller('support/tickets')
export class SupportTicketsController {
  constructor(
    @Inject(SupportTicketsService)
    private readonly tickets: SupportTicketsService,
    @Inject(SupportPasswordService)
    private readonly password: SupportPasswordService,
  ) {}

  /** GET /api/v1/support/tickets (US2-AC7): open tickets, oldest first. */
  @Get()
  async listOpenTickets(): Promise<{ items: TicketSummary[] }> {
    return { items: await this.tickets.listOpenTickets() };
  }

  /** GET /api/v1/support/tickets/{ticketId} (FR-012, FR-015): open or closed ticket. */
  @Get(':ticketId')
  getTicket(@Param('ticketId') ticketId: string): Promise<TicketDetail> {
    return this.tickets.getTicket(ticketId);
  }

  /** POST /api/v1/support/tickets/{ticketId}/discard (US2-AC12): 200, not 201. */
  @Post(':ticketId/discard')
  @HttpCode(200)
  discardTicket(
    @Param('ticketId') ticketId: string,
    @Body() dto: DiscardTicketDto,
  ): Promise<TicketDetail> {
    return this.tickets.discardTicket(ticketId, dto.reason);
  }

  /** POST /api/v1/support/tickets/{ticketId}/temporary-password (US3-AC1, US3-AC2): 200, no-store. */
  @Post(':ticketId/temporary-password')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  generateTemporaryPassword(
    @Param('ticketId') ticketId: string,
    @Body() dto: GenerateTemporaryPasswordDto,
  ): Promise<TemporaryPasswordResponse> {
    return this.password.generateTemporaryPassword(
      ticketId,
      dto.verificationNote,
    );
  }
}
