import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable, Injector } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  OwnershipHistoryResponse,
  OwnershipTransferRequest,
  VehicleClinicalHistory,
  VehicleCreate,
  VehicleDetail,
  VehicleSearchResponse,
  VehicleUpdate,
} from './api.models';
import { toProblem } from './problem-operator';

const VEHICLES_URL = '/api/v1/vehicles';

function vehicleUrl(vehicleId: string): string {
  return `${VEHICLES_URL}/${encodeURIComponent(vehicleId)}`;
}

/** Vehicles endpoints of contracts/openapi.yaml. */
@Injectable({ providedIn: 'root' })
export class VehiclesApiService {
  private readonly injector = inject(Injector);

  private get http(): HttpClient {
    return this.injector.get(HttpClient);
  }

  create(body: VehicleCreate): Observable<VehicleDetail> {
    return this.http.post<VehicleDetail>(VEHICLES_URL, body).pipe(toProblem);
  }

  getById(vehicleId: string): Observable<VehicleDetail> {
    return this.http.get<VehicleDetail>(vehicleUrl(vehicleId)).pipe(toProblem);
  }

  /** PATCH with optimistic locking (version) and optional reason (FR-019). */
  update(vehicleId: string, body: VehicleUpdate): Observable<VehicleDetail> {
    return this.http.patch<VehicleDetail>(vehicleUrl(vehicleId), body).pipe(toProblem);
  }

  transferOwnership(vehicleId: string, body: OwnershipTransferRequest): Observable<VehicleDetail> {
    return this.http.post<VehicleDetail>(`${vehicleUrl(vehicleId)}/ownership-transfers`, body).pipe(toProblem);
  }

  /** Items come newest first from the API; they are not reordered. */
  getOwnershipHistory(vehicleId: string): Observable<OwnershipHistoryResponse> {
    return this.http.get<OwnershipHistoryResponse>(`${vehicleUrl(vehicleId)}/ownership-history`).pipe(toProblem);
  }

  getHistory(vehicleId: string): Observable<VehicleClinicalHistory> {
    return this.http.get<VehicleClinicalHistory>(`${vehicleUrl(vehicleId)}/history`).pipe(toProblem);
  }

  search(q: string): Observable<VehicleSearchResponse> {
    const params = new HttpParams().set('q', q);
    return this.http.get<VehicleSearchResponse>(`${VEHICLES_URL}/search`, { params }).pipe(toProblem);
  }
}
