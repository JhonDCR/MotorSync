import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ProblemException } from '../common/problem-details.filter.js';
import { getSupportContext, getSupportManager } from './support-context.js';

/** Contract `TicketAccount`: only the fields of FR-013. */
export interface TicketAccount {
  email: string;
  name: string;
  role: string;
  status: string;
}

/** Contract `TicketWorkshop`. `ruc` is null only in workshops created before feature 002. */
export interface TicketWorkshop {
  name: string;
  ruc: string | null;
}

/** Contract `TicketSummary`: one row of the open inbox. */
export interface TicketSummary {
  id: string;
  number: number;
  createdAt: string;
  lastRequestedAt: string;
  requestCount: number;
  account: TicketAccount;
  workshop: TicketWorkshop;
}

/** Contract `TicketDetail.resolution`: only present when the ticket is resolved. */
export interface TicketResolution {
  verificationNote: string;
  resolvedByName: string;
  resolvedAt: string;
}

/** Contract `TicketDetail.discard`: only present when the ticket is discarded. */
export interface TicketDiscard {
  reason: string;
  discardedByName: string;
  discardedAt: string;
}

/** Contract `TicketDetail`: summary plus status and the closing block that applies. */
export interface TicketDetail extends TicketSummary {
  status: string;
  resolution: TicketResolution | null;
  discard: TicketDiscard | null;
}

/** Raw row of support_list_open_tickets(); bigint arrives as string. */
interface TicketSummaryRow {
  ticket_id: string;
  number: string;
  created_at: Date;
  last_requested_at: Date;
  request_count: number;
  email: string;
  account_name: string;
  account_role: string;
  account_status: string;
  workshop_name: string;
  workshop_ruc: string | null;
}

/** Raw row of support_get_ticket(): the summary columns plus status and the closing data. */
interface TicketDetailRow extends TicketSummaryRow {
  status: string;
  verification_note: string | null;
  resolved_by_name: string | null;
  resolved_at: Date | null;
  discard_reason: string | null;
  discarded_by_name: string | null;
  discarded_at: Date | null;
}

/** Raw row of `SELECT support_discard_ticket(...) AS result`. */
interface DiscardResultRow {
  result: string;
}

/**
 * Inbox, detail and discard of support tickets (US2). It never touches the tables: motorsync_app
 * only has EXECUTE on the three functions of the support owner (data-model, R6), so every read
 * and write goes through support_list_open_tickets, support_get_ticket and
 * support_discard_ticket. The transaction and the manager come from
 * SupportTransactionInterceptor, always without a workshop pinned.
 */
@Injectable()
export class SupportTicketsService {
  /** GET /support/tickets (US2-AC7, FR-013): open tickets, oldest first by (created_at, number). */
  async listOpenTickets(): Promise<TicketSummary[]> {
    const { agent } = getSupportContext();
    const rows = (await getSupportManager().query(
      'SELECT * FROM support_list_open_tickets($1)',
      [agent.sessionId],
    )) as TicketSummaryRow[];
    return rows.map(toTicketSummary);
  }

  /**
   * GET /support/tickets/{ticketId} (FR-012, FR-015): open, resolved or discarded. A missing or
   * non-uuid id gives the same 404, so the route never reveals which ids exist.
   */
  async getTicket(ticketId: string): Promise<TicketDetail> {
    assertTicketId(ticketId);
    const { agent } = getSupportContext();
    const rows = (await getSupportManager().query(
      'SELECT * FROM support_get_ticket($1, $2)',
      [agent.sessionId, ticketId],
    )) as TicketDetailRow[];
    const row = rows[0];
    if (!row) throw new ProblemException(404, 'NOT_FOUND');
    return toTicketDetail(row);
  }

  /**
   * POST /support/tickets/{ticketId}/discard (US2-AC12, US2-AC13, US3-AC12): the function takes
   * the row FOR UPDATE, so two agents discarding the same ticket get one 200 and one 409. The
   * detail is read in this same transaction, after the row is already discarded.
   */
  async discardTicket(ticketId: string, reason: string): Promise<TicketDetail> {
    assertTicketId(ticketId);
    const { manager, agent, ip } = getSupportContext();
    const rows = (await manager.query(
      'SELECT support_discard_ticket($1, $2, $3, $4) AS result',
      [agent.sessionId, ticketId, reason, ip],
    )) as DiscardResultRow[];
    const result = rows[0]?.result;
    if (result === 'not_found') throw new ProblemException(404, 'NOT_FOUND');
    if (result === 'not_open')
      throw new ProblemException(409, 'TICKET_NOT_OPEN');
    if (result !== 'discarded') {
      // The function only returns those three values: fail closed instead of returning garbage.
      throw new ProblemException(404, 'NOT_FOUND');
    }
    return this.getTicket(ticketId);
  }
}

/** Non-uuid and unknown ids share the 404 of the contract (FR-015). */
function assertTicketId(ticketId: string): void {
  if (typeof ticketId !== 'string' || !isUUID(ticketId)) {
    throw new ProblemException(404, 'NOT_FOUND');
  }
}

function toTicketSummary(row: TicketSummaryRow): TicketSummary {
  return {
    id: row.ticket_id,
    number: Number(row.number),
    createdAt: row.created_at.toISOString(),
    lastRequestedAt: row.last_requested_at.toISOString(),
    requestCount: Number(row.request_count),
    account: {
      email: row.email,
      name: row.account_name,
      role: row.account_role,
      status: row.account_status,
    },
    workshop: {
      name: row.workshop_name,
      ruc: row.workshop_ruc,
    },
  };
}

function toTicketDetail(row: TicketDetailRow): TicketDetail {
  return {
    ...toTicketSummary(row),
    status: row.status,
    resolution: toResolution(row),
    discard: toDiscard(row),
  };
}

function toResolution(row: TicketDetailRow): TicketResolution | null {
  if (
    row.status !== 'resolved' ||
    row.verification_note === null ||
    row.resolved_by_name === null ||
    row.resolved_at === null
  ) {
    return null;
  }
  return {
    verificationNote: row.verification_note,
    resolvedByName: row.resolved_by_name,
    resolvedAt: row.resolved_at.toISOString(),
  };
}

function toDiscard(row: TicketDetailRow): TicketDiscard | null {
  if (
    row.status !== 'discarded' ||
    row.discard_reason === null ||
    row.discarded_by_name === null ||
    row.discarded_at === null
  ) {
    return null;
  }
  return {
    reason: row.discard_reason,
    discardedByName: row.discarded_by_name,
    discardedAt: row.discarded_at.toISOString(),
  };
}
