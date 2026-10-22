import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type { ClientCreate, ClientDetail, ClientSearchResponse } from './api.models';
import { toProblem } from './problem-operator';

const CLIENTS_URL = '/api/v1/clients';

/** Clients endpoints of contracts/openapi.yaml. */
@Injectable({ providedIn: 'root' })
export class ClientsApiService {
  private readonly http = inject(HttpClient);

  create(body: ClientCreate): Observable<ClientDetail> {
    return this.http.post<ClientDetail>(CLIENTS_URL, body).pipe(toProblem);
  }

  getById(clientId: string): Observable<ClientDetail> {
    return this.http.get<ClientDetail>(`${CLIENTS_URL}/${encodeURIComponent(clientId)}`).pipe(toProblem);
  }

  search(q: string): Observable<ClientSearchResponse> {
    const params = new HttpParams().set('q', q);
    return this.http.get<ClientSearchResponse>(`${CLIENTS_URL}/search`, { params }).pipe(toProblem);
  }
}
