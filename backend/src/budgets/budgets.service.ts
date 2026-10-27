import { Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { getManager, getTenantContext } from '../database/tenant-context.js';
import type { BudgetInputDto, LineKind } from './dto/budget-input.dto.js';
import {
  computeTotals,
  DEFAULT_TAX_RATE,
  lineTotal,
  parseMoney,
  type Totals,
} from './money.util.js';

export type BudgetStatus = 'borrador' | 'enviado' | 'aprobado' | 'rechazado';

export interface UserRef {
  id: string;
  name: string;
}

/** Contract `BudgetSummary`. */
export interface BudgetSummary {
  id: string;
  number: number;
  checkinId: string;
  vehicleId: string;
  status: BudgetStatus;
  total: string;
  createdAt: string;
}

export interface BudgetLine {
  id: string;
  kind: LineKind;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
}

/** Contract `BudgetDetail`. */
export interface BudgetDetail extends BudgetSummary {
  taxRate: string;
  subtotal: string;
  tax: string;
  createdBy: UserRef;
  sentAt: string | null;
  decidedAt: string | null;
  decidedBy: UserRef | null;
  lines: BudgetLine[];
}

interface SummaryRow {
  id: string;
  number: number;
  checkinId: string;
  vehicleId: string;
  status: BudgetStatus;
  total: string;
  createdAt: Date;
}

interface DetailRow extends SummaryRow {
  taxRate: string;
  subtotal: string;
  tax: string;
  createdById: string;
  createdByName: string;
  sentAt: Date | null;
  decidedAt: Date | null;
  decidedById: string | null;
  decidedByName: string | null;
}

type PreparedLine = Omit<BudgetLine, 'id'>;

const SUMMARY_COLUMNS = `b.id, b.number, b.checkin_id AS "checkinId", b.vehicle_id AS "vehicleId",
       b.status, b.total::text AS total, b.created_at AS "createdAt"`;

const DETAIL_SQL = `
SELECT ${SUMMARY_COLUMNS},
       b.tax_rate::text AS "taxRate", b.subtotal::text AS subtotal, b.tax::text AS tax,
       b.created_by AS "createdById", cu.name AS "createdByName",
       b.sent_at AS "sentAt", b.decided_at AS "decidedAt",
       b.decided_by AS "decidedById", du.name AS "decidedByName"
FROM budgets b
JOIN users cu ON cu.tenant_id = b.tenant_id AND cu.id = b.created_by
LEFT JOIN users du ON du.tenant_id = b.tenant_id AND du.id = b.decided_by
WHERE b.tenant_id = app_current_tenant() AND b.id = $1`;

const LINES_SQL = `
SELECT id, kind, description, quantity::text AS quantity, unit_price::text AS "unitPrice",
       line_total::text AS "lineTotal"
FROM budget_lines
WHERE tenant_id = app_current_tenant() AND budget_id = $1
ORDER BY position`;

// Updates are wrapped in a CTE because TypeORM returns [rows, count] for a bare UPDATE.

/** Bounds of numeric(10,2) (quantity) and numeric(12,2) (amounts), in cents. */
const MAX_QUANTITY_CENTS = 10_000_000_000n;
const MAX_AMOUNT_CENTS = 1_000_000_000_000n;

function notFound(): ProblemException {
  return new ProblemException(404, 'NOT_FOUND');
}

function outOfRange(field: string): ProblemException {
  return new ProblemException(400, 'VALIDATION_ERROR', {
    errors: [{ field, code: 'OUT_OF_RANGE', message: 'Monto fuera de rango' }],
  });
}

const iso = (d: Date | null): string | null =>
  d === null ? null : d.toISOString();

/** Normalizes "2" to "2.00". */
const fixed = (s: string): string => lineTotal(s, '1');

function toSummary(row: SummaryRow): BudgetSummary {
  return {
    id: row.id,
    number: row.number,
    checkinId: row.checkinId,
    vehicleId: row.vehicleId,
    status: row.status,
    total: row.total,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Recomputes every amount on the server (D1); clients never send totals. */
function prepare(dto: BudgetInputDto): {
  lines: PreparedLine[];
  totals: Totals;
} {
  const lines = dto.lines.map((l, i): PreparedLine => {
    if (parseMoney(l.quantity) >= MAX_QUANTITY_CENTS)
      throw outOfRange(`lines.${i}.quantity`);
    if (parseMoney(l.unitPrice) >= MAX_AMOUNT_CENTS)
      throw outOfRange(`lines.${i}.unitPrice`);
    const total = lineTotal(l.quantity, l.unitPrice);
    if (parseMoney(total) >= MAX_AMOUNT_CENTS) throw outOfRange(`lines.${i}`);
    return {
      kind: l.kind,
      description: l.description,
      quantity: fixed(l.quantity),
      unitPrice: fixed(l.unitPrice),
      lineTotal: total,
    };
  });
  const totals = computeTotals(
    lines.map((l) => l.lineTotal),
    DEFAULT_TAX_RATE,
  );
  if (parseMoney(totals.total) >= MAX_AMOUNT_CENTS) throw outOfRange('lines');
  return { lines, totals };
}

@Injectable()
export class BudgetsService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /** US1-AC1: draft with the next per-tenant number (D5) and server-side totals. */
  async create(checkinId: string, dto: BudgetInputDto): Promise<BudgetDetail> {
    const { lines, totals } = prepare(dto);
    if (!isUUID(checkinId)) throw notFound();
    const manager = getManager();
    const { user } = getTenantContext();
    const checkins: { vehicleId: string }[] = await manager.query(
      `SELECT vehicle_id AS "vehicleId" FROM checkins
        WHERE tenant_id = app_current_tenant() AND id = $1`,
      [checkinId],
    );
    if (checkins.length === 0) throw notFound();

    const counter: { number: number }[] = await manager.query(
      `INSERT INTO budget_counters (tenant_id, last_number) VALUES (app_current_tenant(), 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_number = budget_counters.last_number + 1
       RETURNING last_number AS number`,
    );
    const inserted: { id: string }[] = await manager.query(
      `INSERT INTO budgets (tenant_id, number, checkin_id, vehicle_id, tax_rate,
                            subtotal, tax, total, created_by)
       VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        counter[0].number,
        checkinId,
        checkins[0].vehicleId,
        DEFAULT_TAX_RATE,
        totals.subtotal,
        totals.tax,
        totals.total,
        user.userId,
      ],
    );
    const id = inserted[0].id;
    await this.insertLines(id, lines);
    return this.getById(id);
  }

  /** US1-AC2 (D3): replaces all lines of a draft; 409 with currentStatus otherwise. */
  async replaceLines(
    budgetId: string,
    dto: BudgetInputDto,
  ): Promise<BudgetDetail> {
    const { lines, totals } = prepare(dto);
    if (!isUUID(budgetId)) throw notFound();
    const manager = getManager();
    const updated: unknown[] = await manager.query(
      `WITH u AS (UPDATE budgets SET subtotal = $2, tax = $3, total = $4, updated_at = now()
        WHERE tenant_id = app_current_tenant() AND id = $1 AND status = 'borrador'
        RETURNING id) SELECT id FROM u`,
      [budgetId, totals.subtotal, totals.tax, totals.total],
    );
    if (updated.length === 0) throw await this.transitionError(budgetId);
    await manager.query(
      'DELETE FROM budget_lines WHERE tenant_id = app_current_tenant() AND budget_id = $1',
      [budgetId],
    );
    await this.insertLines(budgetId, lines);
    return this.getById(budgetId);
  }

  /** US2-AC1 (D4): borrador -> enviado. */
  async send(budgetId: string): Promise<BudgetDetail> {
    if (!isUUID(budgetId)) throw notFound();
    const updated: unknown[] = await getManager().query(
      `WITH u AS (UPDATE budgets SET status = 'enviado', sent_at = now(), updated_at = now()
        WHERE tenant_id = app_current_tenant() AND id = $1 AND status = 'borrador'
        RETURNING id) SELECT id FROM u`,
      [budgetId],
    );
    if (updated.length === 0) throw await this.transitionError(budgetId);
    return this.getById(budgetId);
  }

  /** US2-AC1 (D6): enviado -> aprobado | rechazado, audited in the same transaction. */
  async decide(
    budgetId: string,
    status: 'aprobado' | 'rechazado',
  ): Promise<BudgetDetail> {
    if (!isUUID(budgetId)) throw notFound();
    const { user } = getTenantContext();
    const updated: unknown[] = await getManager().query(
      `WITH u AS (UPDATE budgets SET status = $2, decided_at = now(), decided_by = $3, updated_at = now()
        WHERE tenant_id = app_current_tenant() AND id = $1 AND status = 'enviado'
        RETURNING id) SELECT id FROM u`,
      [budgetId, status, user.userId],
    );
    if (updated.length === 0) throw await this.transitionError(budgetId);
    await this.audit.record({
      action: status === 'aprobado' ? 'budget.approved' : 'budget.rejected',
      entityType: 'budget',
      entityId: budgetId,
      before: { status: 'enviado' },
      after: { status },
      // audit_log_asesor_reason requires a reason for asesor actors; the contract has no body.
      reason:
        status === 'aprobado'
          ? 'Presupuesto aprobado'
          : 'Presupuesto rechazado',
    });
    return this.getById(budgetId);
  }

  /** US3-AC1: newest first; 404 if the check-in is missing or from another tenant (US3-AC2). */
  listByCheckin(checkinId: string): Promise<BudgetSummary[]> {
    return this.list('checkins', 'checkin_id', checkinId);
  }

  listByVehicle(vehicleId: string): Promise<BudgetSummary[]> {
    return this.list('vehicles', 'vehicle_id', vehicleId);
  }

  async getById(budgetId: string): Promise<BudgetDetail> {
    if (!isUUID(budgetId)) throw notFound();
    const manager = getManager();
    const rows: DetailRow[] = await manager.query(DETAIL_SQL, [budgetId]);
    const row = rows[0];
    if (!row) throw notFound();
    const lines: BudgetLine[] = await manager.query(LINES_SQL, [budgetId]);
    return {
      ...toSummary(row),
      taxRate: row.taxRate,
      subtotal: row.subtotal,
      tax: row.tax,
      createdBy: { id: row.createdById, name: row.createdByName },
      sentAt: iso(row.sentAt),
      decidedAt: iso(row.decidedAt),
      decidedBy:
        row.decidedById === null
          ? null
          : { id: row.decidedById, name: row.decidedByName ?? '' },
      lines: lines.map((l) => ({
        id: l.id,
        kind: l.kind,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
      })),
    };
  }

  private async list(
    parent: 'checkins' | 'vehicles',
    column: 'checkin_id' | 'vehicle_id',
    parentId: string,
  ): Promise<BudgetSummary[]> {
    if (!isUUID(parentId)) throw notFound();
    const manager = getManager();
    const exists: unknown[] = await manager.query(
      `SELECT 1 FROM ${parent} WHERE tenant_id = app_current_tenant() AND id = $1`,
      [parentId],
    );
    if (exists.length === 0) throw notFound();
    const rows: SummaryRow[] = await manager.query(
      `SELECT ${SUMMARY_COLUMNS} FROM budgets b
        WHERE b.tenant_id = app_current_tenant() AND b.${column} = $1
        ORDER BY b.created_at DESC, b.number DESC`,
      [parentId],
    );
    return rows.map(toSummary);
  }

  private async insertLines(
    budgetId: string,
    lines: PreparedLine[],
  ): Promise<void> {
    const manager = getManager();
    for (const [i, l] of lines.entries()) {
      await manager.query(
        `INSERT INTO budget_lines (tenant_id, budget_id, position, kind, description,
                                   quantity, unit_price, line_total)
         VALUES (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7)`,
        [
          budgetId,
          i,
          l.kind,
          l.description,
          l.quantity,
          l.unitPrice,
          l.lineTotal,
        ],
      );
    }
  }

  /** 0 rows updated (D4): 404 if the budget is not visible, otherwise 409 with its status. */
  private async transitionError(budgetId: string): Promise<ProblemException> {
    const rows: { status: BudgetStatus }[] = await getManager().query(
      'SELECT status FROM budgets WHERE tenant_id = app_current_tenant() AND id = $1',
      [budgetId],
    );
    const current = rows[0];
    return current
      ? new ProblemException(409, 'INVALID_BUDGET_STATUS', {
          currentStatus: current.status,
        })
      : notFound();
  }
}
