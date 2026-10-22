import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type { VehicleCreate, VehicleDetail, VehicleSearchResponse } from './api.models';
import { toProblem } from './problem-operator';

const VEHICLES_URL = '/api/v1/vehicles';

/** Vehicles endpoints of contracts/openapi.yaml. */
@Injectable({ providedIn: 'root' })
export class VehiclesApiService {
  private readonly http = inject(HttpClient);

  create(body: VehicleCreate): Observable<VehicleDetail> {
    return this.http.post<VehicleDetail>(VEHICLES_URL, body).pipe(toProblem);
  }

  getById(vehicleId: string): Observable<VehicleDetail> {
    return this.http.get<VehicleDetail>(`${VEHICLES_URL}/${encodeURIComponent(vehicleId)}`).pipe(toProblem);
  }

  search(q: string): Observable<VehicleSearchResponse> {
    const params = new HttpParams().set('q', q);
    return this.http.get<VehicleSearchResponse>(`${VEHICLES_URL}/search`, { params }).pipe(toProblem);
  }
}
