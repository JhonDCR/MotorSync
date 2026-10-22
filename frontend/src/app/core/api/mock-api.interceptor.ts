import {
  HttpErrorResponse,
  HttpEvent,
  HttpHeaders,
  HttpInterceptorFn,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { mergeMap, Observable, throwError, timer, of } from 'rxjs';
import { MockApiStore, mockProblem, type MockResult } from './mock-api.store';
import { USE_MOCK_API } from './use-mock-api';

// API simulada en memoria (research R8). Solo actúa con USE_MOCK_API en true y en rutas /api/.
// Respeta contracts/openapi.yaml: éxitos con el status del contrato y errores como HttpErrorResponse
// cuyo `error` es el Problem (application/problem+json).

/** Simulated latency, so that loading states are visible in `ng serve --configuration mock`. */
const MOCK_LATENCY_MS = 150;
const API_PREFIX = '/api/';
const CLIENTS_PATH = '/api/v1/clients';
const CLIENT_BY_ID = /^\/api\/v1\/clients\/([^/]+)$/;

/** Path of the request URL, without origin, query or fragment. */
function pathOf(url: string): string {
  const withoutOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  return withoutOrigin.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
}

function respond(req: HttpRequest<unknown>, result: MockResult<unknown>, location?: string): Observable<HttpEvent<unknown>> {
  if (!result.ok) {
    return throwError(
      () =>
        new HttpErrorResponse({
          error: result.problem,
          headers: new HttpHeaders({ 'Content-Type': 'application/problem+json' }),
          status: result.problem.status,
          statusText: result.problem.title,
          url: req.urlWithParams,
        }),
    );
  }
  let headers = new HttpHeaders({ 'Content-Type': 'application/json' });
  if (location !== undefined) {
    headers = headers.set('Location', location);
  }
  return of(new HttpResponse({ body: result.body, headers, status: result.status, url: req.urlWithParams }));
}

function route(req: HttpRequest<unknown>, store: MockApiStore): Observable<HttpEvent<unknown>> {
  const path = pathOf(req.url);

  if (path === CLIENTS_PATH && req.method === 'POST') {
    const result = store.createClient(req.body);
    return respond(req, result, result.ok ? `${CLIENTS_PATH}/${result.body.id}` : undefined);
  }
  if (path === `${CLIENTS_PATH}/search` && req.method === 'GET') {
    return respond(req, store.searchClients(req.params.get('q')));
  }
  const byId = CLIENT_BY_ID.exec(path);
  if (byId !== null && req.method === 'GET') {
    return respond(req, store.getClient(decodeURIComponent(byId[1])));
  }
  return respond(req, { ok: false, problem: mockProblem(404, 'NOT_FOUND') });
}

export const mockApiInterceptor: HttpInterceptorFn = (req, next) => {
  if (inject(USE_MOCK_API) !== true || !`${pathOf(req.url)}/`.startsWith(API_PREFIX)) {
    return next(req);
  }
  const store = inject(MockApiStore);
  return timer(MOCK_LATENCY_MS).pipe(mergeMap(() => route(req, store)));
};
