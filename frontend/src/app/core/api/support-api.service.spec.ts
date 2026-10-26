// T031 (003, PR1, US2): SupportApiService contra specs/003-soporte-plataforma/contracts/openapi.yaml.
//
// Contrato para el implementer-frontend (T034), archivo core/api/support-api.service.ts:
//   @Injectable({ providedIn: 'root' }) export class SupportApiService {
//     login(body: SupportLoginRequest): Observable<SupportSessionResponse>                  // POST /api/v1/support/auth/login (200, withCredentials: true)
//     refresh(): Observable<SupportSessionResponse>                                         // POST /api/v1/support/auth/refresh (200, withCredentials: true + X-Requested-With: motorsync)
//     logout(): Observable<void>                                                            // POST /api/v1/support/auth/logout (204, withCredentials: true + X-Requested-With: motorsync)
//     me(): Observable<CurrentSupportSessionResponse>                                       // GET  /api/v1/support/auth/me (200, { agent })
//     changePassword(body: ChangePasswordRequest): Observable<SupportSessionResponse>       // POST /api/v1/support/auth/password (200, { currentPassword, newPassword })
//     listOpenTickets(): Observable<TicketListResponse>                                     // GET  /api/v1/support/tickets (200, { items })
//     getTicket(ticketId: string): Observable<TicketDetail>                                 // GET  /api/v1/support/tickets/:ticketId (200)
//     discardTicket(ticketId: string, reason: string | DiscardTicketRequest): Observable<TicketDetail> // POST /api/v1/support/tickets/:ticketId/discard (200, { reason })
//   }
//   - login, refresh y logout usan `withCredentials: true` (cookie HttpOnly `ms_support_refresh`).
//   - refresh y logout incluyen además la cabecera `X-Requested-With: motorsync` (CSRF).
//   - Las contraseñas se envían TAL CUAL (sin recortar ni transformar; FR-009).
//   - Errores con toProblem (Problem tipado o HttpErrorResponse ante fallo de red).
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  NEW_PASSWORD,
  problemFlush,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  type ChangePasswordRequestFixture,
} from '../../../testing/auth-fixtures';
import {
  currentSupportSession,
  SUPPORT_EMAIL,
  SUPPORT_LOGIN_URL,
  SUPPORT_LOGOUT_URL,
  SUPPORT_ME_URL,
  SUPPORT_PASSWORD,
  SUPPORT_PASSWORD_URL,
  SUPPORT_REFRESH_URL,
  SUPPORT_TICKETS_URL,
  supportProblem,
  supportSessionResponse,
  TICKET_ID,
  ticketDetailFixture,
  ticketSummaryFixture,
  type CurrentSupportSessionFixture,
  type SupportLoginRequestFixture,
  type SupportSessionResponseFixture,
  type TicketDetailFixture,
  type TicketListResponseFixture,
} from '../../../testing/support-fixtures';
import type { Problem } from './api.models';
import { SupportApiService } from './support-api.service';

const LOGIN_BODY: SupportLoginRequestFixture = {
  email: ` ${SUPPORT_EMAIL.toUpperCase()} `,
  password: SUPPORT_PASSWORD,
};

const CHANGE_BODY: ChangePasswordRequestFixture = {
  currentPassword: SUPPORT_PASSWORD,
  newPassword: NEW_PASSWORD,
};

describe('SupportApiService (T031)', () => {
  let service: SupportApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SupportApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('login', () => {
    it('[US2-AC3][US2-AC4] hace POST /api/v1/support/auth/login con withCredentials y devuelve SupportSessionResponse (200)', () => {
      const session = supportSessionResponse();
      let result: SupportSessionResponseFixture | undefined;
      service.login(LOGIN_BODY).subscribe((res: SupportSessionResponseFixture) => (result = res));

      const req = httpMock.expectOne(SUPPORT_LOGIN_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.withCredentials).toBe(true);
      expect(req.request.body).toEqual(LOGIN_BODY);
      req.flush(session);

      expect(result).toEqual(session);
    });

    it('[FR-009][FR-010] envía la contraseña tal cual y solo las claves email y password (sin tenantId ni role)', () => {
      service.login(LOGIN_BODY).subscribe();

      const req = httpMock.expectOne(SUPPORT_LOGIN_URL);
      expect((req.request.body as SupportLoginRequestFixture).password).toBe(SUPPORT_PASSWORD);
      expect(Object.keys(req.request.body as object).sort()).toEqual(['email', 'password']);
      expect(req.request.headers.has('X-Tenant-Id')).toBe(false);
      req.flush(supportSessionResponse());
    });

    it('[US2-AC3] propaga 401 INVALID_CREDENTIALS y 429 ACCOUNT_LOCKED como Problem tipado', () => {
      const invalidBody = supportProblem(401, 'INVALID_CREDENTIALS');
      let invalidReceived: unknown;
      service.login(LOGIN_BODY).subscribe({ error: (err: unknown) => (invalidReceived = err) });
      httpMock.expectOne(SUPPORT_LOGIN_URL).flush(invalidBody, problemFlush(401));
      expect(invalidReceived).toEqual(invalidBody);
      expect(invalidReceived).not.toBeInstanceOf(HttpErrorResponse);

      const lockedBody = supportProblem(429, 'ACCOUNT_LOCKED');
      let lockedReceived: Problem | undefined;
      service.login(LOGIN_BODY).subscribe({ error: (err: Problem) => (lockedReceived = err) });
      httpMock.expectOne(SUPPORT_LOGIN_URL).flush(lockedBody, problemFlush(429));
      expect(lockedReceived?.code).toBe('ACCOUNT_LOCKED');
      expect(lockedReceived?.status).toBe(429);
    });
  });

  describe('refresh', () => {
    it('[US2-AC9][FR-009] hace POST /api/v1/support/auth/refresh con withCredentials y X-Requested-With: motorsync', () => {
      const session = supportSessionResponse();
      let result: SupportSessionResponseFixture | undefined;
      service.refresh().subscribe((res: SupportSessionResponseFixture) => (result = res));

      const req = httpMock.expectOne(SUPPORT_REFRESH_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.withCredentials).toBe(true);
      expect(req.request.headers.get(REQUESTED_WITH_HEADER)).toBe(REQUESTED_WITH_VALUE);
      expect(req.request.body).toBeNull();
      req.flush(session);

      expect(result).toEqual(session);
    });

    it('[US2-AC9] propaga 401 SESSION_EXPIRED y 409 REFRESH_CONFLICT como Problem tipado', () => {
      const expired = supportProblem(401, 'SESSION_EXPIRED');
      let received: unknown;
      service.refresh().subscribe({ error: (err: unknown) => (received = err) });
      httpMock.expectOne(SUPPORT_REFRESH_URL).flush(expired, problemFlush(401));
      expect(received).toEqual(expired);
    });
  });

  describe('logout', () => {
    it('[US2-AC9] hace POST /api/v1/support/auth/logout con withCredentials y X-Requested-With: motorsync (204)', () => {
      let completed = false;
      service.logout().subscribe({ complete: () => (completed = true) });

      const req = httpMock.expectOne(SUPPORT_LOGOUT_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.withCredentials).toBe(true);
      expect(req.request.headers.get(REQUESTED_WITH_HEADER)).toBe(REQUESTED_WITH_VALUE);
      expect(req.request.body).toBeNull();
      req.flush(null, { status: 204, statusText: 'No Content' });

      expect(completed).toBe(true);
    });
  });

  describe('me', () => {
    it('[US2-AC3][FR-009] hace GET /api/v1/support/auth/me y devuelve el agente de la sesión actual', () => {
      const current = currentSupportSession();
      let result: CurrentSupportSessionFixture | undefined;
      service.me().subscribe((res: CurrentSupportSessionFixture) => (result = res));

      const req = httpMock.expectOne(SUPPORT_ME_URL);
      expect(req.request.method).toBe('GET');
      req.flush(current);

      expect(result).toEqual(current);
    });

    it('[US2-AC5] propaga 403 FORBIDDEN como Problem tipado', () => {
      const forbidden = supportProblem(403, 'FORBIDDEN');
      let received: unknown;
      service.me().subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(SUPPORT_ME_URL).flush(forbidden, problemFlush(403));

      expect(received).toEqual(forbidden);
    });
  });

  describe('changePassword', () => {
    it('[US2-AC1][FR-009] hace POST /api/v1/support/auth/password con { currentPassword, newPassword } tal cual', () => {
      const session = supportSessionResponse({ mustChangePassword: false });
      let result: SupportSessionResponseFixture | undefined;
      service.changePassword(CHANGE_BODY).subscribe((res: SupportSessionResponseFixture) => (result = res));

      const req = httpMock.expectOne(SUPPORT_PASSWORD_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(CHANGE_BODY);
      expect(Object.keys(req.request.body as object).sort()).toEqual(['currentPassword', 'newPassword']);
      req.flush(session);

      expect(result).toEqual(session);
    });

    it('[FR-009] propaga 400 CURRENT_PASSWORD_INCORRECT como Problem tipado', () => {
      const body = supportProblem(400, 'CURRENT_PASSWORD_INCORRECT', {
        errors: [{ field: 'currentPassword', code: 'CURRENT_PASSWORD_INCORRECT', message: 'x' }],
      });
      let received: unknown;
      service.changePassword(CHANGE_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(SUPPORT_PASSWORD_URL).flush(body, problemFlush(400));

      expect(received).toEqual(body);
    });
  });

  describe('listOpenTickets', () => {
    it('[US2-AC7][FR-013] hace GET /api/v1/support/tickets y devuelve los tickets abiertos (200)', () => {
      const list: TicketListResponseFixture = { items: [ticketSummaryFixture()] };
      let result: TicketListResponseFixture | undefined;
      service.listOpenTickets().subscribe((res: TicketListResponseFixture) => (result = res));

      const req = httpMock.expectOne(SUPPORT_TICKETS_URL);
      expect(req.request.method).toBe('GET');
      req.flush(list);

      expect(result).toEqual(list);
    });
  });

  describe('getTicket', () => {
    it('[FR-012] hace GET /api/v1/support/tickets/:ticketId y devuelve el detalle del ticket (200)', () => {
      const detail = ticketDetailFixture();
      let result: TicketDetailFixture | undefined;
      service.getTicket(TICKET_ID).subscribe((res: TicketDetailFixture) => (result = res));

      const req = httpMock.expectOne(`${SUPPORT_TICKETS_URL}/${TICKET_ID}`);
      expect(req.request.method).toBe('GET');
      req.flush(detail);

      expect(result).toEqual(detail);
    });

    it('[FR-012] propaga 404 NOT_FOUND como Problem tipado', () => {
      const notFound = supportProblem(404, 'NOT_FOUND');
      let received: unknown;
      service.getTicket(TICKET_ID).subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne(`${SUPPORT_TICKETS_URL}/${TICKET_ID}`)
        .flush(notFound, { status: 404, statusText: 'Not Found', headers: { 'Content-Type': 'application/problem+json' } });

      expect(received).toEqual(notFound);
    });
  });

  describe('discardTicket', () => {
    it('[US2-AC12][US2-AC8] hace POST /api/v1/support/tickets/:ticketId/discard con { reason } y devuelve TicketDetail (200)', () => {
      const discarded = ticketDetailFixture({
        status: 'discarded',
        discard: {
          reason: 'El taller tiene otro administrador activo',
          discardedByName: 'Pedro Soporte',
          discardedAt: '2026-10-25T15:00:00.000Z',
        },
      });
      let result: TicketDetailFixture | undefined;
      service
        .discardTicket(TICKET_ID, 'El taller tiene otro administrador activo')
        .subscribe((res: TicketDetailFixture) => (result = res));

      const req = httpMock.expectOne(`${SUPPORT_TICKETS_URL}/${TICKET_ID}/discard`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ reason: 'El taller tiene otro administrador activo' });
      expect(Object.keys(req.request.body as object)).toEqual(['reason']);
      req.flush(discarded);

      expect(result).toEqual(discarded);
    });

    it('[US2-AC12] propaga 400 VALIDATION_ERROR con REQUIRED en reason como Problem tipado', () => {
      const body = supportProblem(400, 'VALIDATION_ERROR', {
        errors: [{ field: 'reason', code: 'REQUIRED', message: 'Campo obligatorio' }],
      });
      let received: unknown;
      service.discardTicket(TICKET_ID, '   ').subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(`${SUPPORT_TICKETS_URL}/${TICKET_ID}/discard`).flush(body, problemFlush(400));

      expect(received).toEqual(body);
    });

    it('[US2-AC13] propaga 409 TICKET_NOT_OPEN como Problem tipado', () => {
      const body = supportProblem(409, 'TICKET_NOT_OPEN');
      let received: Problem | undefined;
      service.discardTicket(TICKET_ID, 'Motivo válido').subscribe({ error: (err: Problem) => (received = err) });

      httpMock.expectOne(`${SUPPORT_TICKETS_URL}/${TICKET_ID}/discard`).flush(body, problemFlush(409));

      expect(received).toEqual(body);
    });

    it('[FR-009] un fallo de red (status 0) se propaga como HttpErrorResponse', () => {
      let received: unknown;
      service.discardTicket(TICKET_ID, 'Motivo válido').subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne(`${SUPPORT_TICKETS_URL}/${TICKET_ID}/discard`)
        .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

      expect(received).toBeInstanceOf(HttpErrorResponse);
    });
  });
});
