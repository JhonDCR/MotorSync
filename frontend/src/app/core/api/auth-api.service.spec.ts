// T024 (002, PR1): AuthApiService contra specs/002-autenticacion/contracts/openapi.yaml.
//
// Contrato para el implementer-frontend (T025), archivo core/api/auth-api.service.ts:
//   @Injectable({ providedIn: 'root' }) export class AuthApiService {
//     register(body: RegisterRequest): Observable<SessionResponse>   // POST /api/v1/auth/register (201)
//     login(body: LoginRequest): Observable<SessionResponse>         // POST /api/v1/auth/login (200)
//   }
//   - Ambas peticiones con `withCredentials: true` (el servidor pone la cookie ms_refresh, HttpOnly, que el frontend
//     nunca lee). El contrato solo exige `X-Requested-With: motorsync` en /auth/refresh y /auth/logout (PR2):
//     aquí no se comprueba ni en un sentido ni en otro.
//   - El cuerpo se envía TAL CUAL: la contraseña nunca se recorta ni se transforma (FR-005). Nunca se añade
//     tenantId, tenant_id, role ni la cabecera X-Tenant-Id (US1-AC9, US2-AC10).
//   - Errores como en la 001 (toProblem de problem-operator.ts): con cuerpo Problem, el observable falla con ESE
//     Problem; sin Problem (fallo de red, status 0), con el HttpErrorResponse original.
//   - El servicio no guarda el token: de eso se encargan las pantallas (o quien el implementer decida), y lo
//     comprueban register.page.spec.ts y login.page.spec.ts.
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Problem } from './api.models';
import { AuthApiService } from './auth-api.service';
import {
  authProblem,
  PASSWORD,
  REGISTER_BODY,
  sessionResponse,
  type LoginRequestFixture,
  type SessionResponseFixture,
} from '../../../testing/auth-fixtures';

const REGISTER_URL = '/api/v1/auth/register';
const LOGIN_URL = '/api/v1/auth/login';
const PROBLEM_HEADERS = { 'Content-Type': 'application/problem+json' };

const LOGIN_BODY: LoginRequestFixture = { email: ' ANA.Perez@taller.ec ', password: PASSWORD };

describe('AuthApiService (T024)', () => {
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

  describe('register', () => {
    it('[US1-AC1] hace POST /api/v1/auth/register con withCredentials y devuelve la SessionResponse (201)', () => {
      const session = sessionResponse();
      let result: SessionResponseFixture | undefined;
      service.register(REGISTER_BODY).subscribe((response: SessionResponseFixture) => (result = response));

      const req = httpMock.expectOne(REGISTER_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.withCredentials).toBe(true);
      expect(req.request.body).toEqual(REGISTER_BODY);
      req.flush(session, { status: 201, statusText: 'Created' });

      expect(result).toEqual(session);
    });

    it('[FR-005][FR-006] envía la contraseña sin recortarla ni cambiar mayúsculas', () => {
      service.register(REGISTER_BODY).subscribe();

      const req = httpMock.expectOne(REGISTER_URL);
      expect((req.request.body as { password: string }).password).toBe(PASSWORD);
      req.flush(sessionResponse(), { status: 201, statusText: 'Created' });
    });

    it('[US1-AC9] no añade tenantId ni role al cuerpo, ni la cabecera X-Tenant-Id', () => {
      service.register(REGISTER_BODY).subscribe();

      const req = httpMock.expectOne(REGISTER_URL);
      const keys = Object.keys(req.request.body as object);
      expect(keys).not.toContain('tenantId');
      expect(keys).not.toContain('tenant_id');
      expect(keys).not.toContain('role');
      expect(req.request.headers.has('X-Tenant-Id')).toBe(false);
      req.flush(sessionResponse(), { status: 201, statusText: 'Created' });
    });

    it('[US1-AC4] un 409 RUC_ALREADY_REGISTERED se propaga como el Problem tipado', () => {
      const body = authProblem(409, 'RUC_ALREADY_REGISTERED');
      let received: unknown;
      service.register(REGISTER_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(REGISTER_URL).flush(body, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
      expect(received).not.toBeInstanceOf(HttpErrorResponse);
    });

    it('[US1-AC5] un 409 REGISTRATION_FAILED se propaga como el Problem tipado', () => {
      const body = authProblem(409, 'REGISTRATION_FAILED');
      let received: Problem | undefined;
      service.register(REGISTER_BODY).subscribe({ error: (err: Problem) => (received = err) });

      httpMock.expectOne(REGISTER_URL).flush(body, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });

      expect(received?.code).toBe('REGISTRATION_FAILED');
      expect(received?.status).toBe(409);
    });

    it('[US1-AC3][US1-AC6] un 400 VALIDATION_ERROR se propaga con errors[]', () => {
      const body = authProblem(400, 'VALIDATION_ERROR', {
        errors: [
          { field: 'ruc', code: 'INVALID_RUC', message: 'x' },
          { field: 'password', code: 'PASSWORD_TOO_SHORT', message: 'x' },
        ],
      });
      let received: unknown;
      service.register(REGISTER_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(REGISTER_URL).flush(body, { status: 400, statusText: 'Bad Request', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
    });

    it('[edge case conexión inestable] un fallo de red (status 0) se propaga como HttpErrorResponse', () => {
      let received: unknown;
      service.register(REGISTER_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(REGISTER_URL).error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

      expect(received).toBeInstanceOf(HttpErrorResponse);
      expect((received as HttpErrorResponse).status).toBe(0);
    });
  });

  describe('login', () => {
    it('[US2-AC1] hace POST /api/v1/auth/login con withCredentials y devuelve la SessionResponse (200)', () => {
      const session = sessionResponse({ role: 'asesor' });
      let result: SessionResponseFixture | undefined;
      service.login(LOGIN_BODY).subscribe((response: SessionResponseFixture) => (result = response));

      const req = httpMock.expectOne(LOGIN_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.withCredentials).toBe(true);
      expect(req.request.body).toEqual(LOGIN_BODY);
      req.flush(session);

      expect(result).toEqual(session);
    });

    it('[US2-AC2][FR-005] envía la contraseña tal cual (con espacios y mayúsculas)', () => {
      service.login(LOGIN_BODY).subscribe();

      const req = httpMock.expectOne(LOGIN_URL);
      expect((req.request.body as LoginRequestFixture).password).toBe(PASSWORD);
      req.flush(sessionResponse());
    });

    it('[US2-AC10] no añade tenantId ni role al cuerpo, ni la cabecera X-Tenant-Id', () => {
      service.login(LOGIN_BODY).subscribe();

      const req = httpMock.expectOne(LOGIN_URL);
      expect(Object.keys(req.request.body as object).sort()).toEqual(['email', 'password']);
      expect(req.request.headers.has('X-Tenant-Id')).toBe(false);
      req.flush(sessionResponse());
    });

    it('[US2-AC3] un 401 INVALID_CREDENTIALS se propaga como el Problem tipado', () => {
      const body = authProblem(401, 'INVALID_CREDENTIALS');
      let received: unknown;
      service.login(LOGIN_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(LOGIN_URL).flush(body, { status: 401, statusText: 'Unauthorized', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
      expect(received).not.toBeInstanceOf(HttpErrorResponse);
    });

    it('[US2-AC5] un 429 ACCOUNT_LOCKED se propaga como el Problem tipado', () => {
      const body = authProblem(429, 'ACCOUNT_LOCKED');
      let received: Problem | undefined;
      service.login(LOGIN_BODY).subscribe({ error: (err: Problem) => (received = err) });

      httpMock
        .expectOne(LOGIN_URL)
        .flush(body, { status: 429, statusText: 'Too Many Requests', headers: PROBLEM_HEADERS });

      expect(received?.code).toBe('ACCOUNT_LOCKED');
      expect(received?.status).toBe(429);
    });

    it('[US5-AC9] un 401 TEMPORARY_PASSWORD_EXPIRED se propaga como el Problem tipado', () => {
      const body = authProblem(401, 'TEMPORARY_PASSWORD_EXPIRED');
      let received: Problem | undefined;
      service.login(LOGIN_BODY).subscribe({ error: (err: Problem) => (received = err) });

      httpMock.expectOne(LOGIN_URL).flush(body, { status: 401, statusText: 'Unauthorized', headers: PROBLEM_HEADERS });

      expect(received?.code).toBe('TEMPORARY_PASSWORD_EXPIRED');
    });

    it('[edge case conexión inestable] un fallo de red (status 0) se propaga como HttpErrorResponse', () => {
      let received: unknown;
      service.login(LOGIN_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(LOGIN_URL).error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

      expect(received).toBeInstanceOf(HttpErrorResponse);
    });
  });
});
