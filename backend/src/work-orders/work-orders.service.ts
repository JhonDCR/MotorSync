import { Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import type { LineKind } from '../budgets/dto/budget-input.dto.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { getManager, getTenantContext } from '../database/tenant-context.js';
import type { WorkOrderStatus } from './dto/work-order-input.dto.js';

export interface UserRef {
  id: string;
  name: string;
}

/** Contract `WorkOrderSummary`. */
export interface WorkOrderSummary {
  id: string;
  number: number;
  status: WorkOrderStatus;
  plate: string;
  vehicleId: string;
  assignee: UserRef;
  createdAt: string;
}

export interface WorkOrderItem {
  position: number;
  kind: LineKind;
  description: string;
  quantity: string;
}

export interface WorkOrderHistoryEntry {
  status: WorkOrderStatus;
  changedBy: UserRef;
  changedAt: string;
  reason: string | null;
}

export interface WorkOrderNote {
  body: string;
  createdBy: UserRef;
  createdAt: string;
}

/** Contract `WorkOrderDetail`. */
export interface WorkOrderDetail extends WorkOrderSummary {
  budgetId: string;
  checkinId: string;
  createdBy: UserRef;
  items: WorkOrderItem[];
  history: WorkOrderHistoryEntry[];
  notes: WorkOrderNote[];
}

export type Transition = 'start' | 'finish' | 'deliver';

/** D4/D6: expected status, target status and fixed audit reason of each normal transition. */
const TRANSITIONS: Record<
  Transition,
  { from: WorkOrderStatus; to: WorkOrderStatus; reason: string }
> = {
  start: { from: 'abierta', to: 'en_proceso', reason: 'OT en proceso' },
  finish: { from: 'en_proceso', to: 'terminada', reason: 'OT terminada' },
  deliver: { from: 'terminada', to: 'entregada', reason: 'OT entregada' },
};

/**
 * audit_log.reason needs at least 10 characters; shorter cancel reasons are prefixed in the audit
 * record only (the history keeps the reason verbatim).
 */
const AUDIT_REASON_MIN = 10;

interface SummaryRow {
  id: string;
  number: number;
  status: WorkOrderStatus;
  plate: string;
  vehicleId: string;
  assigneeId: string;
  assigneeName: string;
  createdAt: Date;
}

interface DetailRow extends SummaryRow {
  budgetId: string;
  checkinId: string;
  createdById: string;
  createdByName: string;
}

interface HistoryRow {
  status: WorkOrderStatus;
  userId: string;
  userName: string;
  changedAt: Date;
  reason: string | null;
}

interface NoteRow {
  body: string;
  userId: string;
  userName: string;
  createdAt: Date;
}

const SUMMARY_SELECT = `
SELECT w.id, w.number, w.status, v.plate, w.vehicle_id AS "vehicleId",
       w.assignee_id AS "assigneeId", au.name AS "assigneeName", w.created_at AS "createdAt"`;
const SUMMARY_FROM = `
FROM work_orders w
JOIN vehicles v ON v.tenant_id = w.tenant_id AND v.id = w.vehicle_id
JOIN users au ON au.tenant_id = w.tenant_id AND au.id = w.assignee_id`;

const DETAIL_SQL = `${SUMMARY_SELECT},
       w.budget_id AS "budgetId", w.checkin_id AS "checkinId",
       w.created_by AS "createdById", cu.name AS "createdByName"
${SUMMARY_FROM}
JOIN users cu ON cu.tenant_id = w.tenant_id AND cu.id = w.created_by
WHERE w.tenant_id = app_current_tenant() AND w.id = $1`;

const ORDER = 'ORDER BY w.created_at DESC, w.number DESC';

function notFound(): ProblemException {
  return new ProblemException(404, 'NOT_FOUND');
}

function invalidStatus(current: WorkOrderStatus): ProblemException {
  return new ProblemException(409, 'INVALID_WORK_ORDER_STATUS', {
    currentStatus: current,
  });
}

function uniqueViolation(e: unknown): { constraint?: string } | null {
  if (typeof e !== 'object' || e === null) return null;
  const err = e as { code?: unknown; constraint?: unknown };
  if (err.code !== '23505') return null;
  return {
    constraint: typeof err.constraint === 'string' ? err.constraint : undefined,
  };
}

function toSummary(r: SummaryRow): WorkOrderSummary {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    plate: r.plate,
    vehicleId: r.vehicleId,
    assignee: { id: r.assigneeId, name: r.assigneeName },
    createdAt: r.createdAt.toISOString(),
  };
}

@Injectable()
export class WorkOrdersService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /** US1-AC1/AC2: from an approved budget; items copied in order, assignee = author. */
  async create(budgetId: string): Promise<WorkOrderDetail> {
    if (!isUUID(budgetId)) throw notFound();
    const manager = getManager();
    const { user } = getTenantContext();
    const budgets: { status: string; checkinId: string; vehicleId: string }[] =
      await manager.query(
        `SELECT status, checkin_id AS "checkinId", vehicle_id AS "vehicleId" FROM budgets
          WHERE tenant_id = app_current_tenant() AND id = $1 FOR UPDATE`,
        [budgetId],
      );
    const budget = budgets[0];
    if (!budget) throw notFound();
    if (budget.status !== 'aprobado')
      throw new ProblemException(409, 'budget_not_approved');
    const existing: unknown[] = await manager.query(
      'SELECT 1 FROM work_orders WHERE tenant_id = app_current_tenant() AND budget_id = $1',
      [budgetId],
    );
    if (existing.length > 0)
      throw new ProblemException(409, 'work_order_exists');

    const counter: { number: number }[] = await manager.query(
      `INSERT INTO work_order_counters (tenant_id, last_number) VALUES (app_current_tenant(), 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_number = work_order_counters.last_number + 1
       RETURNING last_number AS number`,
    );
    let id: string;
    try {
      const inserted: { id: string }[] = await manager.query(
        `INSERT INTO work_orders (tenant_id, number, budget_id, checkin_id, vehicle_id,
                                  assignee_id, created_by)
         VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $5) RETURNING id`,
        [
          counter[0].number,
          budgetId,
          budget.checkinId,
          budget.vehicleId,
          user.userId,
        ],
      );
      id = inserted[0].id;
    } catch (e) {
      const unique = uniqueViolation(e);
      if (!unique) throw e;
      throw new ProblemException(
        409,
        unique.constraint === 'work_orders_tenant_budget_key'
          ? 'work_order_exists'
          : 'checkin_has_active_work_order',
      );
    }
    await manager.query(
      `INSERT INTO work_order_items (tenant_id, work_order_id, position, kind, description, quantity)
       SELECT app_current_tenant(), $1, row_number() OVER (ORDER BY position), kind,
              description, quantity
         FROM budget_lines WHERE tenant_id = app_current_tenant() AND budget_id = $2`,
      [id, budgetId],
    );
    await this.insertHistory(id, 'abierta', null);
    return this.getById(id);
  }

  /** US2-AC1: conditional UPDATE; 0 rows -> 404 or 409 with currentStatus. */
  async transition(id: string, action: Transition): Promise<WorkOrderDetail> {
    const t = TRANSITIONS[action];
    await this.changeStatus(id, [t.from], t.to);
    await this.audit.record({
      action: 'work_order.status_changed',
      entityType: 'work_order',
      entityId: id,
      before: { status: t.from },
      after: { status: t.to },
      reason: t.reason,
    });
    await this.insertHistory(id, t.to, null);
    return this.getById(id);
  }

  /** US2-AC2: abierta|en_proceso -> cancelada with the reason given by the user. */
  async cancel(id: string, reason: string): Promise<WorkOrderDetail> {
    const from = await this.changeStatus(
      id,
      ['abierta', 'en_proceso'],
      'cancelada',
    );
    const trimmed = reason.trim() === '' ? reason : reason.trim();
    await this.audit.record({
      action: 'work_order.cancelled',
      entityType: 'work_order',
      entityId: id,
      before: { status: from },
      after: { status: 'cancelada' },
      reason:
        Array.from(trimmed).length >= AUDIT_REASON_MIN
          ? trimmed
          : `OT cancelada: ${trimmed}`,
    });
    await this.insertHistory(id, 'cancelada', reason);
    return this.getById(id);
  }

  /** US1-AC3: admin only (controller); 422 if the user is not an active user of the tenant. */
  async assign(id: string, userId: string): Promise<WorkOrderDetail> {
    if (!isUUID(id)) throw notFound();
    const manager = getManager();
    const current: { assigneeId: string }[] = await manager.query(
      `SELECT assignee_id AS "assigneeId" FROM work_orders
        WHERE tenant_id = app_current_tenant() AND id = $1 FOR UPDATE`,
      [id],
    );
    if (!current[0]) throw notFound();
    const users: unknown[] = await manager.query(
      `SELECT 1 FROM users
        WHERE tenant_id = app_current_tenant() AND id = $1 AND status = 'active'`,
      [userId],
    );
    if (users.length === 0) {
      throw new ProblemException(422, 'VALIDATION_ERROR', {
        errors: [
          {
            field: 'userId',
            code: 'INVALID_ASSIGNEE',
            message: 'Usuario inexistente, de otro taller o inactivo',
          },
        ],
      });
    }
    await manager.query(
      `WITH u AS (UPDATE work_orders SET assignee_id = $2, updated_at = now()
        WHERE tenant_id = app_current_tenant() AND id = $1 RETURNING id) SELECT id FROM u`,
      [id, userId],
    );
    await this.audit.record({
      action: 'work_order.assignee_changed',
      entityType: 'work_order',
      entityId: id,
      before: { assigneeId: current[0].assigneeId },
      after: { assigneeId: userId },
      reason: 'Responsable reasignado',
    });
    return this.getById(id);
  }

  /** US2-AC4: notes only while the work order is not entregada or cancelada. */
  async addNote(id: string, body: string): Promise<WorkOrderDetail> {
    if (!isUUID(id)) throw notFound();
    const status = await this.currentStatus(id, true);
    if (status === null) throw notFound();
    if (status === 'entregada' || status === 'cancelada')
      throw invalidStatus(status);
    await getManager().query(
      `INSERT INTO work_order_notes (tenant_id, work_order_id, body, created_by)
       VALUES (app_current_tenant(), $1, $2, $3)`,
      [id, body, getTenantContext().user.userId],
    );
    return this.getById(id);
  }

  /** US3-AC1: board, newest first. */
  async board(
    status: WorkOrderStatus | undefined,
    limit: number,
  ): Promise<WorkOrderSummary[]> {
    const rows: SummaryRow[] = await getManager().query(
      `${SUMMARY_SELECT} ${SUMMARY_FROM}
        WHERE w.tenant_id = app_current_tenant() AND ($1::text IS NULL OR w.status = $1)
        ${ORDER} LIMIT $2`,
      [status ?? null, limit],
    );
    return rows.map(toSummary);
  }

  /** US3-AC1/AC2: 404 if the vehicle is missing or from another tenant. */
  async listByVehicle(vehicleId: string): Promise<WorkOrderSummary[]> {
    if (!isUUID(vehicleId)) throw notFound();
    const manager = getManager();
    const exists: unknown[] = await manager.query(
      'SELECT 1 FROM vehicles WHERE tenant_id = app_current_tenant() AND id = $1',
      [vehicleId],
    );
    if (exists.length === 0) throw notFound();
    const rows: SummaryRow[] = await manager.query(
      `${SUMMARY_SELECT} ${SUMMARY_FROM}
        WHERE w.tenant_id = app_current_tenant() AND w.vehicle_id = $1 ${ORDER}`,
      [vehicleId],
    );
    return rows.map(toSummary);
  }

  async getById(id: string): Promise<WorkOrderDetail> {
    if (!isUUID(id)) throw notFound();
    const manager = getManager();
    const rows: DetailRow[] = await manager.query(DETAIL_SQL, [id]);
    const row = rows[0];
    if (!row) throw notFound();
    const items: WorkOrderItem[] = await manager.query(
      `SELECT position, kind, description, quantity::text AS quantity FROM work_order_items
        WHERE tenant_id = app_current_tenant() AND work_order_id = $1 ORDER BY position`,
      [id],
    );
    const history: HistoryRow[] = await manager.query(
      `SELECT h.status, h.changed_by AS "userId", u.name AS "userName",
              h.changed_at AS "changedAt", h.reason
         FROM work_order_status_changes h
         JOIN users u ON u.tenant_id = h.tenant_id AND u.id = h.changed_by
        WHERE h.tenant_id = app_current_tenant() AND h.work_order_id = $1
        ORDER BY h.changed_at, h.id`,
      [id],
    );
    const notes: NoteRow[] = await manager.query(
      `SELECT n.body, n.created_by AS "userId", u.name AS "userName",
              n.created_at AS "createdAt"
         FROM work_order_notes n
         JOIN users u ON u.tenant_id = n.tenant_id AND u.id = n.created_by
        WHERE n.tenant_id = app_current_tenant() AND n.work_order_id = $1
        ORDER BY n.created_at, n.id`,
      [id],
    );
    return {
      ...toSummary(row),
      budgetId: row.budgetId,
      checkinId: row.checkinId,
      createdBy: { id: row.createdById, name: row.createdByName },
      items: items.map((i) => ({
        position: Number(i.position),
        kind: i.kind,
        description: i.description,
        quantity: i.quantity,
      })),
      history: history.map((h) => ({
        status: h.status,
        changedBy: { id: h.userId, name: h.userName },
        changedAt: h.changedAt.toISOString(),
        reason: h.reason,
      })),
      notes: notes.map((n) => ({
        body: n.body,
        createdBy: { id: n.userId, name: n.userName },
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  /** UPDATE ... WHERE status = ANY(from) inside a CTE; returns the previous status. */
  private async changeStatus(
    id: string,
    from: WorkOrderStatus[],
    to: WorkOrderStatus,
  ): Promise<WorkOrderStatus> {
    if (!isUUID(id)) throw notFound();
    const previous = await this.currentStatus(id, true);
    if (previous === null) throw notFound();
    const updated: unknown[] = await getManager().query(
      `WITH u AS (UPDATE work_orders SET status = $3, updated_at = now()
        WHERE tenant_id = app_current_tenant() AND id = $1 AND status = ANY($2::text[])
        RETURNING id) SELECT id FROM u`,
      [id, from, to],
    );
    if (updated.length === 0) throw invalidStatus(previous);
    return previous;
  }

  private async currentStatus(
    id: string,
    lock = false,
  ): Promise<WorkOrderStatus | null> {
    const rows: { status: WorkOrderStatus }[] = await getManager().query(
      `SELECT status FROM work_orders WHERE tenant_id = app_current_tenant() AND id = $1
       ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0]?.status ?? null;
  }

  private async insertHistory(
    id: string,
    status: WorkOrderStatus,
    reason: string | null,
  ): Promise<void> {
    await getManager().query(
      `INSERT INTO work_order_status_changes (tenant_id, work_order_id, status, changed_by, reason)
       VALUES (app_current_tenant(), $1, $2, $3, $4)`,
      [id, status, getTenantContext().user.userId, reason],
    );
  }
}
