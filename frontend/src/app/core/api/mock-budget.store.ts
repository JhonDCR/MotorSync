import { inject, Injectable } from '@angular/core';
import {
  type BudgetDetail,
  type BudgetLine,
  type BudgetStatus,
  type BudgetSummary,
  computeTotals,
  formatHundredths,
  LINE_KINDS,
  type LineKind,
  lineCents,
  toHundredths,
} from '../../features/budgets/budget.service';
import type { FieldError } from './api.models';
import {
  MockApiStore,
  mockProblem,
  newId,
  type MockActor,
  type MockResult,
} from './mock-api.store';
import { MockCheckinStore } from './mock-checkin.store';

// Budgets of the mock API (contract 005): same validations, 409 with currentStatus outside the allowed status.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TRANSITIONS: Record<'send' | 'approve' | 'reject', { from: BudgetStatus; to: BudgetStatus }> =
  {
    send: { from: 'borrador', to: 'enviado' },
    approve: { from: 'enviado', to: 'aprobado' },
    reject: { from: 'enviado', to: 'rechazado' },
  };

@Injectable({ providedIn: 'root' })
export class MockBudgetStore {
  private readonly checkins = inject(MockCheckinStore);
  private readonly vehicles = inject(MockApiStore);
  private readonly budgets = new Map<string, BudgetDetail>();

  create(checkinId: string, raw: unknown, actor: MockActor): MockResult<BudgetDetail> {
    const checkin = this.checkins.get(checkinId);
    if (!checkin.ok) {
      return checkin;
    }
    const lines = this.parse(raw);
    if (!lines.ok) {
      return lines;
    }
    const detail: BudgetDetail = {
      id: newId(),
      number: this.budgets.size + 1,
      checkinId: checkin.body.id,
      vehicleId: checkin.body.vehicleId,
      status: 'borrador',
      createdAt: new Date().toISOString(),
      taxRate: '0.1500',
      createdBy: { id: actor.id, name: actor.name },
      sentAt: null,
      decidedAt: null,
      decidedBy: null,
      ...this.amounts(lines.body),
    };
    this.budgets.set(detail.id, detail);
    return { ok: true, status: 201, body: detail };
  }

  update(id: string, raw: unknown): MockResult<BudgetDetail> {
    const current = this.budgets.get(id);
    if (current === undefined) {
      return { ok: false, problem: mockProblem(404, 'NOT_FOUND') };
    }
    const lines = this.parse(raw);
    if (!lines.ok) {
      return lines;
    }
    if (current.status !== 'borrador') {
      return this.conflict(current.status);
    }
    const updated = { ...current, ...this.amounts(lines.body) };
    this.budgets.set(id, updated);
    return { ok: true, status: 200, body: updated };
  }

  transition(
    id: string,
    action: 'send' | 'approve' | 'reject',
    actor: MockActor,
  ): MockResult<BudgetDetail> {
    const current = this.budgets.get(id);
    if (current === undefined) {
      return { ok: false, problem: mockProblem(404, 'NOT_FOUND') };
    }
    const { from, to } = TRANSITIONS[action];
    if (current.status !== from) {
      return this.conflict(current.status);
    }
    const now = new Date().toISOString();
    const updated: BudgetDetail =
      action === 'send'
        ? { ...current, status: to, sentAt: now }
        : { ...current, status: to, decidedAt: now, decidedBy: { id: actor.id, name: actor.name } };
    this.budgets.set(id, updated);
    return { ok: true, status: 200, body: updated };
  }

  get(id: string): MockResult<BudgetDetail> {
    const budget = this.budgets.get(id);
    return budget
      ? { ok: true, status: 200, body: budget }
      : { ok: false, problem: mockProblem(404, 'NOT_FOUND') };
  }

  listByCheckin(checkinId: string): MockResult<BudgetSummary[]> {
    const checkin = this.checkins.get(checkinId);
    return checkin.ok
      ? { ok: true, status: 200, body: this.summaries((b) => b.checkinId === checkinId) }
      : checkin;
  }

  listByVehicle(vehicleId: string): MockResult<BudgetSummary[]> {
    const vehicle = this.vehicles.getVehicle(vehicleId);
    return vehicle.ok
      ? { ok: true, status: 200, body: this.summaries((b) => b.vehicleId === vehicle.body.id) }
      : vehicle;
  }

  /** Newest first. */
  private summaries(filter: (b: BudgetDetail) => boolean): BudgetSummary[] {
    return [...this.budgets.values()]
      .filter(filter)
      .sort((a, b) => b.number - a.number)
      .map(({ id, number, checkinId, vehicleId, status, total, createdAt }) => ({
        id,
        number,
        checkinId,
        vehicleId,
        status,
        total,
        createdAt,
      }));
  }

  private conflict<T>(currentStatus: BudgetStatus): MockResult<T> {
    return { ok: false, problem: mockProblem(409, 'INVALID_BUDGET_STATUS', { currentStatus }) };
  }

  private amounts(lines: BudgetLine[]): Pick<BudgetDetail, 'lines' | 'subtotal' | 'tax' | 'total'> {
    return { lines, ...computeTotals(lines) };
  }

  private parse(raw: unknown): MockResult<BudgetLine[]> {
    const errors: FieldError[] = [];
    const invalid = (field: string): void => {
      errors.push({ field, code: 'REQUIRED', message: field });
    };
    const rawLines = isRecord(raw) ? raw['lines'] : undefined;
    if (!Array.isArray(rawLines) || rawLines.length < 1 || rawLines.length > 50) {
      return {
        ok: false,
        problem: mockProblem(400, 'VALIDATION_ERROR', {
          errors: [{ field: 'lines', code: 'REQUIRED', message: 'lines' }],
        }),
      };
    }
    const lines: BudgetLine[] = [];
    rawLines.forEach((l: unknown, i: number) => {
      const rec = isRecord(l) ? l : {};
      const kind = LINE_KINDS.find((k): k is LineKind => k === rec['kind']);
      const description = typeof rec['description'] === 'string' ? rec['description'].trim() : '';
      const quantity = typeof rec['quantity'] === 'string' ? rec['quantity'] : '';
      const unitPrice = typeof rec['unitPrice'] === 'string' ? rec['unitPrice'] : '';
      const cents = lineCents(quantity, unitPrice);
      if (kind === undefined) invalid(`lines[${i}].kind`);
      if (description === '' || description.length > 200) invalid(`lines[${i}].description`);
      if (toHundredths(quantity) === null || toHundredths(quantity) === 0)
        invalid(`lines[${i}].quantity`);
      if (toHundredths(unitPrice) === null) invalid(`lines[${i}].unitPrice`);
      if (kind !== undefined && cents !== null) {
        lines.push({
          id: newId(),
          kind,
          description,
          quantity,
          unitPrice,
          lineTotal: formatHundredths(cents),
        });
      }
    });
    if (errors.length > 0) {
      return { ok: false, problem: mockProblem(400, 'VALIDATION_ERROR', { errors }) };
    }
    return { ok: true, status: 200, body: lines };
  }
}
