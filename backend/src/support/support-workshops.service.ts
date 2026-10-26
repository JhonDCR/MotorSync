import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { normalizeDocument } from '../common/identifiers/normalize.js';
import { ProblemException } from '../common/problem-details.filter.js';
import type { ListWorkshopsDto } from './dto/list-workshops.dto.js';
import { SUPPORT_PAGE_SIZE } from './dto/list-workshops.dto.js';
import { getSupportContext, getSupportManager } from './support-context.js';

/** Contract `WorkshopSummary`: only the fields of FR-016. */
export interface WorkshopSummary {
  id: string;
  name: string;
  ruc: string | null;
  createdAt: string;
}

/** Contract `WorkshopAccount`: only the fields of FR-016. */
export interface WorkshopAccount {
  name: string;
  email: string;
  role: string;
  status: string;
  hasOpenTicket: boolean;
}

/** One page of `GET /support/workshops`. */
export interface WorkshopPage {
  items: WorkshopSummary[];
  page: number;
  pageSize: number;
  total: number;
}

/** `GET /support/workshops/{workshopId}/accounts`. */
export interface WorkshopAccountsResponse {
  workshop: WorkshopSummary;
  items: WorkshopAccount[];
}

/** Raw row of support_list_workshops(); bigint arrives as string. */
interface WorkshopRow {
  tenant_id: string;
  name: string;
  ruc: string | null;
  created_at: Date;
  total: string;
}

/** Raw row of support_list_workshop_accounts(); `user_id` is null when the workshop has no users. */
interface WorkshopAccountRow {
  user_id: string | null;
  name: string | null;
  email: string | null;
  role: string | null;
  status: string | null;
  has_open_ticket: boolean | null;
  workshop_name: string;
  workshop_ruc: string | null;
  workshop_created_at: Date;
}

/**
 * Workshop list/search and the accounts of one workshop (US4). It never touches the tables:
 * motorsync_app only has EXECUTE on the support owner's functions (data-model, R6), so every read
 * goes through support_list_workshops and support_list_workshop_accounts. The latter writes the
 * support_access_log row in the same call (FR-018). The transaction and the manager come from
 * SupportTransactionInterceptor, always without a workshop pinned.
 */
@Injectable()
export class SupportWorkshopsService {
  /** GET /support/workshops (US4-AC1, US4-AC2): 50 per page, ordered by name by the function. */
  async listWorkshops(query: ListWorkshopsDto): Promise<WorkshopPage> {
    const { agent } = getSupportContext();
    const page = query.page;
    const search = workshopSearch(query.q);
    const rows = (await getSupportManager().query(
      'SELECT * FROM support_list_workshops($1, $2, $3, $4, $5)',
      [
        agent.sessionId,
        search.nameQuery,
        search.rucPrefix,
        SUPPORT_PAGE_SIZE,
        (page - 1) * SUPPORT_PAGE_SIZE,
      ],
    )) as WorkshopRow[];
    return {
      items: rows.map(toWorkshopSummary),
      page,
      pageSize: SUPPORT_PAGE_SIZE,
      total: rows.length > 0 ? Number(rows[0].total) : 0,
    };
  }

  /**
   * GET /support/workshops/{workshopId}/accounts (US4-AC3, US4-AC6, US4-AC7): all the accounts of
   * the workshop, active and inactive. A missing or non-uuid id gives the same 404, so the route
   * never reveals which ids exist; rows without a user are dropped (LEFT JOIN with no accounts).
   */
  async listWorkshopAccounts(
    workshopId: string,
  ): Promise<WorkshopAccountsResponse> {
    assertWorkshopId(workshopId);
    const { agent, ip } = getSupportContext();
    const rows = (await getSupportManager().query(
      'SELECT * FROM support_list_workshop_accounts($1, $2, $3)',
      [agent.sessionId, workshopId, ip],
    )) as WorkshopAccountRow[];
    const first = rows[0];
    if (first === undefined) throw new ProblemException(404, 'NOT_FOUND');
    return {
      workshop: {
        id: workshopId,
        name: first.workshop_name,
        ruc: first.workshop_ruc,
        createdAt: first.workshop_created_at.toISOString(),
      },
      items: rows
        .map(toWorkshopAccount)
        .filter((account): account is WorkshopAccount => account !== null),
    };
  }
}

/** Non-uuid and unknown ids share the 404 of the contract (US4-AC7). */
function assertWorkshopId(workshopId: string): void {
  if (typeof workshopId !== 'string' || !isUUID(workshopId)) {
    throw new ProblemException(404, 'NOT_FOUND');
  }
}

/**
 * Decides the search of US4-AC2: a value that normalizes to digits is a RUC prefix (with or
 * without spaces or dashes); anything else is part of the commercial name, with LIKE's wildcards
 * escaped so `%` and `_` are literal. Without `q` both parameters are NULL (list everything).
 */
function workshopSearch(q: string | undefined): {
  nameQuery: string | null;
  rucPrefix: string | null;
} {
  if (q === undefined) return { nameQuery: null, rucPrefix: null };
  const normalized = normalizeDocument(q);
  if (/^\d+$/.test(normalized)) {
    return { nameQuery: null, rucPrefix: normalized };
  }
  return { nameQuery: escapeLike(q), rucPrefix: null };
}

/** Escapes `\`, `%` and `_` for LIKE's implicit backslash escape. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function toWorkshopSummary(row: WorkshopRow): WorkshopSummary {
  return {
    id: row.tenant_id,
    name: row.name,
    ruc: row.ruc,
    createdAt: row.created_at.toISOString(),
  };
}

function toWorkshopAccount(row: WorkshopAccountRow): WorkshopAccount | null {
  if (
    row.user_id === null ||
    row.name === null ||
    row.email === null ||
    row.role === null ||
    row.status === null
  ) {
    return null;
  }
  return {
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    hasOpenTicket: row.has_open_ticket === true,
  };
}
