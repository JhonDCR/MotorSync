import { Injectable } from '@nestjs/common';
import type { ListAccessLogDto } from './dto/list-access-log.dto.js';
import { SUPPORT_PAGE_SIZE } from './dto/list-workshops.dto.js';
import { getSupportContext, getSupportManager } from './support-context.js';

/** Contract `AccessLogEntry.agent`: never the email of the agent (FR-027). */
export interface AccessLogAgent {
  id: string;
  name: string;
}

/** Contract `WorkshopSummaryRef`: the workshop of one access log entry. */
export interface AccessLogWorkshop {
  id: string;
  name: string;
  ruc: string | null;
}

/** Contract `AccessLogEntry`: one row of the support access log. */
export interface AccessLogEntry {
  id: string;
  occurredAt: string;
  agent: AccessLogAgent;
  workshop: AccessLogWorkshop;
  ip: string | null;
  channel: string;
}

/** One page of `GET /support/access-log`. */
export interface AccessLogPage {
  items: AccessLogEntry[];
  page: number;
  pageSize: number;
  total: number;
}

/** Raw row of support_list_access_log(); bigint arrives as string. */
interface AccessLogRow {
  entry_id: string;
  occurred_at: Date;
  agent_id: string;
  agent_name: string;
  tenant_id: string;
  workshop_name: string;
  workshop_ruc: string | null;
  ip: string | null;
  channel: string;
  total: string;
}

/**
 * Read-only view of the support access log (US4-AC8, US4-AC9, FR-027). It never writes: the only
 * source of rows is support_list_access_log, a STABLE SECURITY DEFINER function of the support
 * owner (data-model, R6). The transaction and the manager come from SupportTransactionInterceptor,
 * always without a workshop pinned.
 */
@Injectable()
export class SupportAccessLogService {
  /** GET /support/access-log: newest first, 50 per page, optional workshop/agent filters. */
  async listAccessLog(query: ListAccessLogDto): Promise<AccessLogPage> {
    const { agent } = getSupportContext();
    const page = query.page;
    const rows = (await getSupportManager().query(
      'SELECT * FROM support_list_access_log($1, $2, $3, $4, $5)',
      [
        agent.sessionId,
        query.workshopId ?? null,
        query.agentId ?? null,
        SUPPORT_PAGE_SIZE,
        (page - 1) * SUPPORT_PAGE_SIZE,
      ],
    )) as AccessLogRow[];
    return {
      items: rows.map(toAccessLogEntry),
      page,
      pageSize: SUPPORT_PAGE_SIZE,
      total: rows.length > 0 ? Number(rows[0].total) : 0,
    };
  }
}

function toAccessLogEntry(row: AccessLogRow): AccessLogEntry {
  return {
    id: row.entry_id,
    occurredAt: row.occurred_at.toISOString(),
    agent: {
      id: row.agent_id,
      name: row.agent_name,
    },
    workshop: {
      id: row.tenant_id,
      name: row.workshop_name,
      ruc: row.workshop_ruc,
    },
    ip: row.ip,
    channel: row.channel,
  };
}
