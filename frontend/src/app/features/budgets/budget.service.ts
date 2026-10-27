import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';

// Tipos de specs/005-presupuestos/contracts/openapi.yaml. Montos como string decimal.

export const BUDGET_STATUSES = ['borrador', 'enviado', 'aprobado', 'rechazado'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

export const LINE_KINDS = ['mano_obra', 'repuesto'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

export const LINE_KIND_LABELS: Record<LineKind, string> = {
  mano_obra: 'Mano de obra',
  repuesto: 'Repuesto',
};

export interface LineInput {
  kind: LineKind;
  description: string;
  quantity: string;
  unitPrice: string;
}

export interface BudgetInput {
  lines: LineInput[];
}

export interface UserRef {
  id: string;
  name: string;
}

export interface BudgetSummary {
  id: string;
  number: number;
  checkinId: string;
  vehicleId: string;
  status: BudgetStatus;
  total: string;
  createdAt: string;
}

export interface BudgetLine extends LineInput {
  id: string;
  lineTotal: string;
}

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

export const TAX_RATE_PERCENT = 15;
const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

/** Decimal string with up to 2 decimals to hundredths, or null if invalid. No floating point. */
export function toHundredths(value: string): number | null {
  const text = value.trim();
  if (!MONEY.test(text)) {
    return null;
  }
  const [int, frac = ''] = text.split('.');
  return Number(int) * 100 + Number(frac.padEnd(2, '0'));
}

export function formatHundredths(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}

/** Line total in cents, rounded half up (quantity × price come in 1/10 000). */
export function lineCents(quantity: string, unitPrice: string): number | null {
  const q = toHundredths(quantity);
  const p = toHundredths(unitPrice);
  return q === null || p === null ? null : Math.floor((q * p + 50) / 100);
}

export function computeTotals(lines: readonly Pick<LineInput, 'quantity' | 'unitPrice'>[]): {
  subtotal: string;
  tax: string;
  total: string;
} {
  const subtotal = lines.reduce((sum, l) => sum + (lineCents(l.quantity, l.unitPrice) ?? 0), 0);
  const tax = Math.floor((subtotal * TAX_RATE_PERCENT + 50) / 100);
  return {
    subtotal: formatHundredths(subtotal),
    tax: formatHundredths(tax),
    total: formatHundredths(subtotal + tax),
  };
}

const API = '/api/v1';
const enc = encodeURIComponent;

/** Budget endpoints (contract 005). Errors arrive as HttpErrorResponse with the Problem body. */
@Injectable({ providedIn: 'root' })
export class BudgetService {
  private readonly http = inject(HttpClient);

  create(checkinId: string, body: BudgetInput): Observable<BudgetDetail> {
    return this.http.post<BudgetDetail>(`${API}/checkins/${enc(checkinId)}/budgets`, body);
  }

  listByCheckin(checkinId: string): Observable<BudgetSummary[]> {
    return this.http.get<BudgetSummary[]>(`${API}/checkins/${enc(checkinId)}/budgets`);
  }

  listByVehicle(vehicleId: string): Observable<BudgetSummary[]> {
    return this.http.get<BudgetSummary[]>(`${API}/vehicles/${enc(vehicleId)}/budgets`);
  }

  getById(id: string): Observable<BudgetDetail> {
    return this.http.get<BudgetDetail>(`${API}/budgets/${enc(id)}`);
  }

  update(id: string, body: BudgetInput): Observable<BudgetDetail> {
    return this.http.put<BudgetDetail>(`${API}/budgets/${enc(id)}`, body);
  }

  send(id: string): Observable<BudgetDetail> {
    return this.http.post<BudgetDetail>(`${API}/budgets/${enc(id)}/send`, null);
  }

  approve(id: string): Observable<BudgetDetail> {
    return this.http.post<BudgetDetail>(`${API}/budgets/${enc(id)}/approve`, null);
  }

  reject(id: string): Observable<BudgetDetail> {
    return this.http.post<BudgetDetail>(`${API}/budgets/${enc(id)}/reject`, null);
  }
}

/** Human message for a failed budget request (409 includes the current status). */
export function budgetErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    const body = 'error' in error ? (error as { error: unknown }).error : null;
    const current =
      typeof body === 'object' && body !== null && 'currentStatus' in body
        ? String((body as { currentStatus: unknown }).currentStatus)
        : null;
    if (status === 409) {
      return `No se puede hacer esto: el presupuesto ya está en estado ${current ?? 'distinto'}.`;
    }
    if (status === 400) {
      return 'Revise las líneas: descripción obligatoria y cantidades o precios con hasta 2 decimales.';
    }
    if (status === 404) {
      return 'Presupuesto o check-in no encontrado.';
    }
  }
  return 'No se pudo completar la operación. Revise la conexión e inténtelo de nuevo.';
}
