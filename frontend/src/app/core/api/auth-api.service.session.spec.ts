// T041 (002, PR2, US3, US5): rutas de sesión de AuthApiService contra specs/002-autenticacion/contracts/openapi.yaml.
// Archivo nuevo: auth-api.service.spec.ts del PR1 no cambia.
//
// Contrato para el implementer-frontend (T040, T042, T044), archivo core/api/auth-api.service.ts (suma 4 métodos):
//   refresh(): Observable<SessionResponse>        // POST /api/v1/auth/refresh (200)
//   logout(): Observable<void>                    // POST /api/v1/auth/logout (204)
//   me(): Observable<CurrentSession>              // GET  /api/v1/auth/me (200; schema CurrentSession del contrato)
//   changePassword(body: ChangePasswordRequest): Observable<SessionResponse>   // POST /api/v1/auth/password (200)
//   - refresh y logout: `withCredentials: true` y la cabecera `X-Requested-With: motorsync` (R11, CSRF). El cuerpo
//     no lleva ningún token: el refresh token solo viaja en la cookie HttpOnly, que el frontend nunca lee.
//   - changePassword envía exactamente { currentPassword, newPassword } TAL CUAL (sin confirmación, sin userId, sin
//     recortar; FR-005, US5-AC8).
//   - Errores como el resto del servicio (toProblem): con cuerpo Problem, falla con ESE Problem.
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  authProblem,
  currentSession,
  LOGOUT_URL,
  ME_URL,
  NEW_PASSWORD,
  PASSWORD,
  PASSWORD_URL,
  problemFlush,
  REFRESH_URL,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  sessionResponse,
  type ChangePasswordRequestFixture,
  type CurrentSessionFixture,
  type SessionResponseFixture,
} from '../../../testing/auth-fixtures';
import { AuthApiService } from './auth-api.service';

const CHANGE_BODY: ChangePasswordRequestFixture = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD };

describe('AuthApiService: sesión y contraseña (T041)', () => {
  let service: AuthApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('refresh', () => {
    it('[US3-AC1] POST /auth/refresh con withCredentials y X-Requested-With: motorsync devuelve la SessionResponse', () => {
      const session = sessionResponse();
      let result: SessionResponseFixture | undefined;
      service.refresh().subscribe((response: SessionResponseFixture) => (result = response));

      const req = httpMock.expectOne(REFRESH_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.withCredentials).toBe(true);
      expect(req.request.headers.get(REQUESTED_WITH_HEADER)).toBe(REQUESTED_WITH_VALUE);
      req.flush(session);

      expect(result).toEqual(session);
    });

    it('[US3-AC2] un 401 SESSION_EXPIRED se propaga como el Problem tipado', () => {
      let received: unknown;
      service.refresh().subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(REFRESH_URL).flush(authProblem(401, 'SESSION_EXPIRED'), problemFlush(401));

      expect(received).toEqual(authProblem(401, 'SESSION_EXPIRED'));
      expect(received).not.toBeInstanceOf(HttpErrorResponse);
    });
  });

  describe('logout', () => {
    it('[US3-AC3] POST /auth/logout con withCredentials y X-Requested-With: motorsync (204)', () => {
      let completed = false;
      service.logout().subscribe({ complete: () => (completed = true) });

      const req = httpMock.expectOne(LOGOUT_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.withCredentials).toBe(true);
      expect(req.request.headers.get(REQUESTED_WITH_HEADER)).toBe(REQUESTED_WITH_VALUE);
      req.flush(null, { status: 204, statusText: 'No Content' });

      expect(completed).toBe(true);
    });
  });

  describe('me', () => {
    it('[US3] GET /auth/me devuelve usuario y taller de la sesión', () => {
      const current = currentSession({ role: 'asesor' });
      let result: CurrentSessionFixture | undefined;
      service.me().subscribe((response: CurrentSessionFixture) => (result = response));

      const req = httpMock.expectOne(ME_URL);
      expect(req.request.method).toBe('GET');
      req.flush(current);

      expect(result).toEqual(current);
    });
  });

  describe('changePassword', () => {
    it('[US5-AC2][FR-005] POST /auth/password con { currentPassword, newPassword } tal cual', () => {
      const session = sessionResponse();
      let result: SessionResponseFixture | undefined;
      service.changePassword(CHANGE_BODY).subscribe((response: SessionResponseFixture) => (result = response));

      const req = httpMock.expectOne(PASSWORD_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(CHANGE_BODY);
      expect(Object.keys(req.request.body as object).sort()).toEqual(['currentPassword', 'newPassword']);
      req.flush(session);

      expect(result).toEqual(session);
    });

    it('[US5-AC4] un 400 CURRENT_PASSWORD_INCORRECT se propaga como el Problem tipado', () => {
      const body = authProblem(400, 'CURRENT_PASSWORD_INCORRECT', {
        errors: [{ field: 'currentPassword', code: 'CURRENT_PASSWORD_INCORRECT', message: 'x' }],
      });
      let received: unknown;
      service.changePassword(CHANGE_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(PASSWORD_URL).flush(body, problemFlush(400));

      expect(received).toEqual(body);
    });
  });
});
