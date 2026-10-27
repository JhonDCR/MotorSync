import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';

// Tipos de specs/006-ordenes-trabajo/contracts/openapi.yaml.

export const WORK_ORDER_STATUSES = [
  'abierta',
  'en_proceso',
  'terminada',
  'entregada',
  'cancelada',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export interface WorkOrderUserRef {
  id: string;
  name: string;
}

export interface WorkOrderSummary {
  id: string;
  number: number;
  status: WorkOrderStatus;
  plate: string;
  vehicleId: string;
  assignee: WorkOrderUserRef;
  createdAt: string;
}

export interface WorkOrderItem {
  position: number;
  kind: 'mano_obra' | 'repuesto';
  description: string;
  quantity: string;
}

export interface WorkOrderHistoryEntry {
  status: WorkOrderStatus;
  changedBy: WorkOrderUserRef;
  changedAt: string;
  reason: string | null;
}

export interface WorkOrderNote {
  body: string;
  createdBy: WorkOrderUserRef;
  createdAt: string;
}

export interface WorkOrderDetail extends WorkOrderSummary {
  budgetId: string;
  checkinId: string;
  createdBy: WorkOrderUserRef;
  items: WorkOrderItem[];
  history: WorkOrderHistoryEntry[];
  notes: WorkOrderNote[];
}

const API = '/api/v1';
const enc = encodeURIComponent;

/** Work order endpoints (contract 006). Errors arrive as HttpErrorResponse with the Problem body. */
@Injectable({ providedIn: 'root' })
export class WorkOrderService {
  private readonly http = inject(HttpClient);

  create(budgetId: string): Observable<WorkOrderDetail> {
    return this.http.post<WorkOrderDetail>(`${API}/budgets/${enc(budgetId)}/work-orders`, {});
  }

  list(status?: WorkOrderStatus): Observable<WorkOrderSummary[]> {
    const params = status ? new HttpParams().set('status', status) : undefined;
    return this.http.get<WorkOrderSummary[]>(`${API}/work-orders`, { params });
  }

  listByVehicle(vehicleId: string): Observable<WorkOrderSummary[]> {
    return this.http.get<WorkOrderSummary[]>(`${API}/vehicles/${enc(vehicleId)}/work-orders`);
  }

  getById(id: string): Observable<WorkOrderDetail> {
    return this.http.get<WorkOrderDetail>(`${API}/work-orders/${enc(id)}`);
  }

  start(id: string): Observable<WorkOrderDetail> {
    return this.http.post<WorkOrderDetail>(`${API}/work-orders/${enc(id)}/start`, {});
  }

  finish(id: string): Observable<WorkOrderDetail> {
    return this.http.post<WorkOrderDetail>(`${API}/work-orders/${enc(id)}/finish`, {});
  }

  deliver(id: string): Observable<WorkOrderDetail> {
    return this.http.post<WorkOrderDetail>(`${API}/work-orders/${enc(id)}/deliver`, {});
  }

  cancel(id: string, reason: string): Observable<WorkOrderDetail> {
    return this.http.post<WorkOrderDetail>(`${API}/work-orders/${enc(id)}/cancel`, { reason });
  }

  reassign(id: string, userId: string): Observable<WorkOrderDetail> {
    return this.http.patch<WorkOrderDetail>(`${API}/work-orders/${enc(id)}/assignee`, { userId });
  }

  addNote(id: string, body: string): Observable<WorkOrderDetail> {
    return this.http.post<WorkOrderDetail>(`${API}/work-orders/${enc(id)}/notes`, { body });
  }
}

/** Human message for a failed work order request (409 includes the current status or a code). */
export function workOrderErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    const raw = 'error' in error ? (error as { error: unknown }).error : null;
    const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    if (status === 409) {
      if (body['code'] === 'budget_not_approved') {
        return 'El presupuesto no está aprobado.';
      }
      if (body['code'] === 'work_order_exists') {
        return 'Este presupuesto ya tiene una orden de trabajo.';
      }
      const current = typeof body['currentStatus'] === 'string' ? body['currentStatus'] : 'distinto';
      return `No se puede hacer esto: la orden ya está en estado ${current}.`;
    }
    if (status === 400) {
      return 'Revise los datos: el texto es obligatorio.';
    }
    if (status === 403) {
      return 'Solo un administrador puede hacer esto.';
    }
    if (status === 404) {
      return 'Orden de trabajo no encontrada.';
    }
    if (status === 422) {
      return 'El usuario no existe, no pertenece al taller o está inactivo.';
    }
  }
  return 'No se pudo completar la operación. Revise la conexión e inténtelo de nuevo.';
}
