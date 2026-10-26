// T031 (003, PR1, US1): método forgotPassword de AuthApiService contra
// specs/003-soporte-plataforma/contracts/openapi.yaml.
// Archivo nuevo: auth-api.service.spec.ts y auth-api.service.session.spec.ts de la 002 no se modifican.
//
// Contrato para el implementer-frontend (T034), archivo core/api/auth-api.service.ts:
//   forgotPassword(email: string | ForgotPasswordRequest): Observable<void>
//     - POST /api/v1/auth/forgot-password con body exactamente `{ email }` (si recibe `{ email }`, extrae solo `email`
//       para no enviar nunca tenantId, userId ni ticketId; US1-AC9, FR-006).
//     - 202 Accepted sin body → emite `undefined` y completa.
//     - Errores con toProblem (400 VALIDATION_ERROR, 429 HELP_RATE_LIMITED → Problem; fallo de red → HttpErrorResponse).
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { problemFlush } from '../../../testing/auth-fixtures';
import { FORGOT_PASSWORD_URL, supportProblem } from '../../../testing/support-fixtures';
import type { Problem } from './api.models';
import { AuthApiService } from './auth-api.service';

describe('AuthApiService: forgotPassword (T031)', () => {
  let service: AuthApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('[US1-AC1][FR-001] hace POST /api/v1/auth/forgot-password con { email } y completa con 202 sin body', () => {
    let completed = false;
    let emitted: unknown = 'not-set';
    service.forgotPassword(' Ana.Perez@Taller.EC ').subscribe({
      next: (value: void) => (emitted = value),
      complete: () => (completed = true),
    });

    const req = httpMock.expectOne(FORGOT_PASSWORD_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: ' Ana.Perez@Taller.EC ' });
    req.flush(null, { status: 202, statusText: 'Accepted' });

    expect(emitted).toBeUndefined();
    expect(completed).toBe(true);
  });

  it('[US1-AC9][FR-006] envía únicamente { email } en el cuerpo y nunca añade tenantId, userId, ticketId ni X-Tenant-Id', () => {
    service.forgotPassword('ana.perez@taller.ec').subscribe();

    const req = httpMock.expectOne(FORGOT_PASSWORD_URL);
    expect(Object.keys(req.request.body as object)).toEqual(['email']);
    expect(req.request.headers.has('X-Tenant-Id')).toBe(false);
    req.flush(null, { status: 202, statusText: 'Accepted' });
  });

  it('[US1-AC6][FR-004] propaga un 429 HELP_RATE_LIMITED como el Problem tipado', () => {
    const body = supportProblem(429, 'HELP_RATE_LIMITED');
    let received: Problem | undefined;
    service.forgotPassword('ana.perez@taller.ec').subscribe({
      error: (err: Problem) => (received = err),
    });

    httpMock.expectOne(FORGOT_PASSWORD_URL).flush(body, problemFlush(429));

    expect(received).toEqual(body);
    expect(received).not.toBeInstanceOf(HttpErrorResponse);
  });

  it('[US1-AC8] propaga un 400 VALIDATION_ERROR con errors[] en email como el Problem tipado', () => {
    const body = supportProblem(400, 'VALIDATION_ERROR', {
      errors: [{ field: 'email', code: 'INVALID_EMAIL', message: 'Correo electrónico inválido' }],
    });
    let received: unknown;
    service.forgotPassword('correo-invalido').subscribe({
      error: (err: unknown) => (received = err),
    });

    httpMock.expectOne(FORGOT_PASSWORD_URL).flush(body, problemFlush(400));

    expect(received).toEqual(body);
  });

  it('[US1-AC2] un fallo de red (status 0) se propaga como HttpErrorResponse', () => {
    let received: unknown;
    service.forgotPassword('ana.perez@taller.ec').subscribe({
      error: (err: unknown) => (received = err),
    });

    httpMock.expectOne(FORGOT_PASSWORD_URL).error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

    expect(received).toBeInstanceOf(HttpErrorResponse);
    expect((received as HttpErrorResponse).status).toBe(0);
  });
});
