import { inject, Injectable } from '@angular/core';
import {
  WORK_ORDER_STATUSES,
  type WorkOrderDetail,
  type WorkOrderStatus,
  type WorkOrderSummary,
} from '../../features/work-orders/work-order.service';
import { MockApiStore, mockProblem, newId, type MockActor, type MockResult } from './mock-api.store';
import { MockBudgetStore } from './mock-budget.store';

// Work orders of the mock API (contract 006): 409 with code or currentStatus, like the backend.

type Action = 'start' | 'finish' | 'deliver' | 'cancel';

const TRANSITIONS: Record<Action, { from: readonly WorkOrderStatus[]; to: WorkOrderStatus }> = {
  start: { from: ['abierta'], to: 'en_proceso' },
  finish: { from: ['en_proceso'], to: 'terminada' },
  deliver: { from: ['terminada'], to: 'entregada' },
  cancel: { from: ['abierta', 'en_proceso'], to: 'cancelada' },
};

function textField(raw: unknown, field: string, max: number): string | null {
  const value =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[field] : undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' || text.length > max ? null : text;
}

function invalid<T>(field: string): MockResult<T> {
  return {
    ok: false,
    problem: mockProblem(400, 'VALIDATION_ERROR', {
      errors: [{ field, code: 'REQUIRED', message: field }],
    }),
  };
}

function notFound<T>(): MockResult<T> {
  return { ok: false, problem: mockProblem(404, 'NOT_FOUND') };
}

@Injectable({ providedIn: 'root' })
export class MockWorkOrderStore {
  private readonly budgets = inject(MockBudgetStore);
  private readonly vehicles = inject(MockApiStore);
  private readonly orders = new Map<string, WorkOrderDetail>();

  create(budgetId: string, actor: MockActor): MockResult<WorkOrderDetail> {
    const budget = this.budgets.get(budgetId);
    if (!budget.ok) {
      return budget;
    }
    if (budget.body.status !== 'aprobado') {
      return { ok: false, problem: mockProblem(409, 'budget_not_approved') };
    }
    if ([...this.orders.values()].some((o) => o.budgetId === budget.body.id)) {
      return { ok: false, problem: mockProblem(409, 'work_order_exists') };
    }
    const vehicle = this.vehicles.getVehicle(budget.body.vehicleId);
    const user = { id: actor.id, name: actor.name };
    const now = new Date().toISOString();
    const detail: WorkOrderDetail = {
      id: newId(),
      number: this.orders.size + 1,
      status: 'abierta',
      plate: vehicle.ok ? vehicle.body.plate : '',
      vehicleId: budget.body.vehicleId,
      assignee: user,
      createdAt: now,
      budgetId: budget.body.id,
      checkinId: budget.body.checkinId,
      createdBy: user,
      items: budget.body.lines.map((l, i) => ({
        position: i + 1,
        kind: l.kind,
        description: l.description,
        quantity: l.quantity,
      })),
      history: [{ status: 'abierta', changedBy: user, changedAt: now, reason: null }],
      notes: [],
    };
    this.orders.set(detail.id, detail);
    return { ok: true, status: 201, body: detail };
  }

  list(status: string | null): MockResult<WorkOrderSummary[]> {
    const wanted = WORK_ORDER_STATUSES.find((s) => s === status);
    return { ok: true, status: 200, body: this.summaries((o) => !wanted || o.status === wanted) };
  }

  listByVehicle(vehicleId: string): MockResult<WorkOrderSummary[]> {
    const vehicle = this.vehicles.getVehicle(vehicleId);
    return vehicle.ok
      ? { ok: true, status: 200, body: this.summaries((o) => o.vehicleId === vehicle.body.id) }
      : vehicle;
  }

  get(id: string): MockResult<WorkOrderDetail> {
    const order = this.orders.get(id);
    return order ? { ok: true, status: 200, body: order } : notFound();
  }

  transition(
    id: string,
    action: Action,
    raw: unknown,
    actor: MockActor,
  ): MockResult<WorkOrderDetail> {
    const current = this.orders.get(id);
    if (current === undefined) {
      return notFound();
    }
    let reason: string | null = null;
    if (action === 'cancel') {
      reason = textField(raw, 'reason', 500);
      if (reason === null) {
        return invalid('reason');
      }
    }
    const { from, to } = TRANSITIONS[action];
    if (!from.includes(current.status)) {
      return this.conflict(current.status);
    }
    const updated: WorkOrderDetail = {
      ...current,
      status: to,
      history: [
        ...current.history,
        {
          status: to,
          changedBy: { id: actor.id, name: actor.name },
          changedAt: new Date().toISOString(),
          reason,
        },
      ],
    };
    this.orders.set(id, updated);
    return { ok: true, status: 200, body: updated };
  }

  reassign(id: string, raw: unknown, actor: MockActor): MockResult<WorkOrderDetail> {
    const current = this.orders.get(id);
    if (current === undefined) {
      return notFound();
    }
    if (actor.role !== 'admin') {
      return { ok: false, problem: mockProblem(403, 'FORBIDDEN') };
    }
    const userId = textField(raw, 'userId', 36);
    if (userId === null) {
      return invalid('userId');
    }
    if (current.status === 'entregada' || current.status === 'cancelada') {
      return this.conflict(current.status);
    }
    const name = userId === actor.id ? actor.name : 'Usuario del taller';
    const updated = { ...current, assignee: { id: userId, name } };
    this.orders.set(id, updated);
    return { ok: true, status: 200, body: updated };
  }

  addNote(id: string, raw: unknown, actor: MockActor): MockResult<WorkOrderDetail> {
    const current = this.orders.get(id);
    if (current === undefined) {
      return notFound();
    }
    const body = textField(raw, 'body', 1000);
    if (body === null) {
      return invalid('body');
    }
    if (current.status === 'entregada' || current.status === 'cancelada') {
      return this.conflict(current.status);
    }
    const note = {
      body,
      createdBy: { id: actor.id, name: actor.name },
      createdAt: new Date().toISOString(),
    };
    const updated = { ...current, notes: [...current.notes, note] };
    this.orders.set(id, updated);
    return { ok: true, status: 201, body: updated };
  }

  /** Newest first. */
  private summaries(filter: (o: WorkOrderDetail) => boolean): WorkOrderSummary[] {
    return [...this.orders.values()]
      .filter(filter)
      .sort((a, b) => b.number - a.number)
      .map(({ id, number, status, plate, vehicleId, assignee, createdAt }) => ({
        id,
        number,
        status,
        plate,
        vehicleId,
        assignee,
        createdAt,
      }));
  }

  private conflict<T>(currentStatus: WorkOrderStatus): MockResult<T> {
    return { ok: false, problem: mockProblem(409, 'INVALID_WORK_ORDER_STATUS', { currentStatus }) };
  }
}
