import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, Observable, throwError } from 'rxjs';
import type { ClientCreate, ClientDetail, ClientSearchResponse } from './api.models';
import { isProblem } from './problem';

const CLIENTS_URL = '/api/v1/clients';

/**
 * Errors with a Problem body (application/problem+json) fail with that Problem. Any other error
 * (for example a network failure with status 0) fails with the original HttpErrorResponse.
 */
function toProblem<T>(source: Observable<T>): Observable<T> {
  return source.pipe(
    catchError((error: unknown) =>
      throwError(() => (error instanceof HttpErrorResponse && isProblem(error.error) ? error.error : error)),
    ),
  );
}

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
