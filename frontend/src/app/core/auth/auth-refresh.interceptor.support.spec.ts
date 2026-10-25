// T037 (003, PR1, US2): aislamiento de authRefreshInterceptor frente a peticiones de soporte (research R4, FR-008).
//
// Contrato para el implementer-frontend (T038), archivo core/auth/auth-refresh.interceptor.ts:
//   - `authRefreshInterceptor` (el interceptor del taller) DEBE ignorar por completo cualquier petición a
//     `/api/v1/support/**`.
//   - Un 401 (`TOKEN_EXPIRED`, `SESSION_EXPIRED`, `SESSION_REVOKED`) o 403 (`PASSWORD_CHANGE_REQUIRED`) que venga de
//     `/api/v1/support/**` jamás debe disparar `POST /api/v1/auth/refresh`, jamás debe borrar la sesión del taller
//     (`SessionStore` / `motorsync.token`) y jamás debe navegar a `/login` ni a `/change-password`.
import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  problemFlush,
  REFRESH_URL,
  sessionResponseWithToken,
} from '../../../testing/auth-fixtures';
import {
  SUPPORT_REFRESH_URL,
  SUPPORT_TICKETS_URL,
  SUPPORT_TOKEN_STORAGE_KEY,
  supportProblem,
  TICKET_ID,
} from '../../../testing/support-fixtures';
import { authRefreshInterceptor } from './auth-refresh.interceptor';
import { AUTH_TOKEN_STORAGE_KEY, authTokenInterceptor } from './auth-token.interceptor';
import { SessionStore } from './session.store';

@Component({ template: '' })
class StubPage {}

const WORKSHOP_TOKEN = 'jwt.taller.intacto';
const SUPPORT_TOKEN = 'jwt.soporte.expirado';

describe('authRefreshInterceptor — ignora las rutas /api/v1/support/** (T037)', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let workshopStore: SessionStore;
  let router: Router;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'login', component: StubPage },
          { path: 'change-password', component: StubPage },
          { path: 'support', component: StubPage },
          { path: '**', component: StubPage },
        ]),
        provideHttpClient(withInterceptors([authTokenInterceptor, authRefreshInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    workshopStore = TestBed.inject(SessionStore);
    router = TestBed.inject(Router);
    await router.navigateByUrl('/support');
    workshopStore.setSession(sessionResponseWithToken(WORKSHOP_TOKEN, { role: 'admin', name: 'Ana Pérez' }));
    localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, SUPPORT_TOKEN);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  it('[US2-AC5][FR-008] un 401 TOKEN_EXPIRED en /api/v1/support/tickets NO llama a /api/v1/auth/refresh ni altera la sesión del taller', () => {
    let receivedError: unknown;
    http.get(SUPPORT_TICKETS_URL).subscribe({ error: (err: unknown) => (receivedError = err) });

    const req = httpMock.expectOne(SUPPORT_TICKETS_URL);
    req.flush(supportProblem(401, 'TOKEN_EXPIRED'), problemFlush(401));

    expect(receivedError).toBeInstanceOf(HttpErrorResponse);
    httpMock.expectNone(REFRESH_URL);
    httpMock.expectNone(SUPPORT_REFRESH_URL);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(WORKSHOP_TOKEN);
    expect(workshopStore.isSignedIn()).toBe(true);
    expect(router.url).toBe('/support');
  });

  it('[US2-AC5][FR-008] un 401 SESSION_EXPIRED o SESSION_REVOKED en /api/v1/support/** NO limpia SessionStore ni redirige a /login', () => {
    let receivedError: unknown;
    http.get(`${SUPPORT_TICKETS_URL}/${TICKET_ID}`).subscribe({ error: (err: unknown) => (receivedError = err) });

    const req = httpMock.expectOne(`${SUPPORT_TICKETS_URL}/${TICKET_ID}`);
    req.flush(supportProblem(401, 'SESSION_REVOKED'), problemFlush(401));

    expect(receivedError).toBeInstanceOf(HttpErrorResponse);
    httpMock.expectNone(REFRESH_URL);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(WORKSHOP_TOKEN);
    expect(workshopStore.isSignedIn()).toBe(true);
    expect(router.url).toBe('/support');
  });

  it('[US2-AC5][FR-008] un 403 PASSWORD_CHANGE_REQUIRED en /api/v1/support/** NO redirige a /change-password del taller', () => {
    let receivedError: unknown;
    http.get(SUPPORT_TICKETS_URL).subscribe({ error: (err: unknown) => (receivedError = err) });

    const req = httpMock.expectOne(SUPPORT_TICKETS_URL);
    req.flush(supportProblem(403, 'PASSWORD_CHANGE_REQUIRED'), problemFlush(403));

    expect(receivedError).toBeInstanceOf(HttpErrorResponse);
    expect(router.url).toBe('/support');
    expect(workshopStore.isSignedIn()).toBe(true);
  });
});
