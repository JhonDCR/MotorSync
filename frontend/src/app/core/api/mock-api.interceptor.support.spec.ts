// T031 (003, PR1, US1, US2): rutas /auth/forgot-password y /support/** en mockApiInterceptor contra
// specs/003-soporte-plataforma/contracts/openapi.yaml y research R13.
// Archivo nuevo: los specs del mock de la 001 y de la 002 no se modifican.
//
// Contrato para el implementer-frontend (T034), archivos core/api/mock-api.interceptor.ts, mock-support.store.ts y
// mock-auth.store.ts:
//   - POST /api/v1/auth/forgot-password (pública):
//     Usa la cabecera `X-Forwarded-For` (o `'127.0.0.1'` por defecto) como origen simulado para el límite de 20
//     solicitudes por hora (429 HELP_RATE_LIMITED en la 21.ª). Responde 202 sin body para cualquier correo válido
//     (exista en MockAuthStore, no exista o sea de soporte), crea/actualiza un único ticket `open` por cuenta de
//     MockAuthStore con `requestCount` creciente, ignora campos extra y valida `email` con 400 VALIDATION_ERROR.
//   - Rutas públicas del panel:
//     POST /api/v1/support/auth/login    → 200 SupportSessionResponse / 400 / 401 INVALID_CREDENTIALS o
//                                          TEMPORARY_PASSWORD_EXPIRED / 429 ACCOUNT_LOCKED
//     POST /api/v1/support/auth/refresh  → exige `X-Requested-With: motorsync`; 200 SupportSessionResponse / 401
//     POST /api/v1/support/auth/logout   → exige `X-Requested-With: motorsync`; 204 idempotente
//   - Rutas protegidas del panel (Bearer de soporte):
//     GET  /api/v1/support/auth/me                 → 200 { agent } (permitida con mustChangePassword: true)
//     POST /api/v1/support/auth/password           → 200 SupportSessionResponse (permitida con mustChangePassword: true)
//     GET  /api/v1/support/tickets                 → 200 { items: TicketSummary[] } ordenados por createdAt ascendente
//     GET  /api/v1/support/tickets/:ticketId       → 200 TicketDetail / 404 NOT_FOUND
//     POST /api/v1/support/tickets/:ticketId/discard → 200 TicketDetail / 400 REQUIRED o UNKNOWN_FIELD / 404 /
//                                                      409 TICKET_NOT_OPEN
//     Cualquier otro método o ruta bajo /api/v1/support/** → 404 NOT_FOUND (US2-AC2, US2-AC11, FR-015).
//   - Separación de zonas (US2-AC5, US2-AC6, FR-008):
//     - Un token de taller (con o sin sid) en cualquier ruta protegida de `/api/v1/support/**` → 403 FORBIDDEN.
//     - Un token de soporte (`aud: 'motorsync-support'`) en cualquier ruta protegida del taller (`/api/v1/auth/me`,
//       `/api/v1/auth/password`, `/api/v1/users/**`, `/api/v1/clients/**`, `/api/v1/vehicles/**`) → 403 FORBIDDEN.
import { HttpClient, HttpErrorResponse, HttpHeaders, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  decodeClaims,
  LOGIN_URL,
  ME_URL,
  NEW_PASSWORD,
  OTHER_VALID_RUC,
  PASSWORD,
  PASSWORD_URL,
  REGISTER_BODY,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  TEMPORARY_PASSWORD,
  type SessionResponseFixture,
} from '../../../testing/auth-fixtures';
import { tokenFor } from '../../../testing/fake-jwt';
import {
  FORGOT_PASSWORD_URL,
  SUPPORT_EMAIL,
  SUPPORT_LOGIN_URL,
  SUPPORT_LOGOUT_URL,
  SUPPORT_ME_URL,
  SUPPORT_PASSWORD,
  SUPPORT_PASSWORD_URL,
  SUPPORT_REFRESH_URL,
  SUPPORT_TICKETS_URL,
  type CurrentSupportSessionFixture,
  type SupportSessionResponseFixture,
  type TicketDetailFixture,
  type TicketListResponseFixture,
} from '../../../testing/support-fixtures';
import type { Problem, UserHistoryResponse } from './api.models';
import { mockApiInterceptor } from './mock-api.interceptor';
import { MockAuthStore } from './mock-auth.store';
import { MockSupportStore } from './mock-support.store';
import { USE_MOCK_API } from './use-mock-api';

const REGISTER_URL = '/api/v1/auth/register';
const USERS_URL = '/api/v1/users';
const CLIENTS_SEARCH_URL = '/api/v1/clients/search?q=an';
const VEHICLES_SEARCH_URL = '/api/v1/vehicles/search?q=PB';
const CSRF = { [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE };

describe('mockApiInterceptor: /auth/forgot-password y /support/** (T031)', () => {
  let http: HttpClient;
  let supportStore: MockSupportStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        { provide: USE_MOCK_API, useValue: true },
        provideHttpClient(withInterceptors([mockApiInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    TestBed.inject(MockAuthStore);
    supportStore = TestBed.inject(MockSupportStore);
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  function bearer(token: string): HttpHeaders {
    return new HttpHeaders({ Authorization: `Bearer ${token}` });
  }

  async function failure(request: Promise<unknown>): Promise<HttpErrorResponse> {
    try {
      await request;
    } catch (error) {
      expect(error).toBeInstanceOf(HttpErrorResponse);
      return error as HttpErrorResponse;
    }
    throw new Error('Se esperaba un error HTTP y la petición tuvo éxito');
  }

  function problemOf(error: HttpErrorResponse): Problem {
    return error.error as Problem;
  }

  function fieldCodes(error: HttpErrorResponse): { field: string; code: string }[] {
    return (problemOf(error).errors ?? []).map(({ field, code }) => ({ field, code }));
  }

  function registerWorkshop(body: Record<string, unknown> = { ...REGISTER_BODY }) {
    return firstValueFrom(http.post<SessionResponseFixture>(REGISTER_URL, body, { withCredentials: true }));
  }

  function forgotPassword(body: unknown, origin?: string) {
    const headers = origin !== undefined ? new HttpHeaders({ 'X-Forwarded-For': origin }) : undefined;
    return firstValueFrom(http.post(FORGOT_PASSWORD_URL, body, { headers, observe: 'response' }));
  }

  function supportLogin(body: unknown) {
    return firstValueFrom(
      http.post<SupportSessionResponseFixture>(SUPPORT_LOGIN_URL, body, {
        withCredentials: true,
        observe: 'response',
      }),
    );
  }

  function supportRefresh(withCsrf = true) {
    return firstValueFrom(
      http.post<SupportSessionResponseFixture>(SUPPORT_REFRESH_URL, null, {
        withCredentials: true,
        headers: withCsrf ? CSRF : {},
        observe: 'response',
      }),
    );
  }

  function supportLogout(withCsrf = true) {
    return firstValueFrom(
      http.post(SUPPORT_LOGOUT_URL, null, {
        withCredentials: true,
        headers: withCsrf ? CSRF : {},
        observe: 'response',
      }),
    );
  }

  function supportMe(token: string) {
    return firstValueFrom(http.get<CurrentSupportSessionFixture>(SUPPORT_ME_URL, { headers: bearer(token) }));
  }

  function supportChangePassword(token: string, body: unknown) {
    return firstValueFrom(
      http.post<SupportSessionResponseFixture>(SUPPORT_PASSWORD_URL, body, { headers: bearer(token) }),
    );
  }

  function listTickets(token: string) {
    return firstValueFrom(http.get<TicketListResponseFixture>(SUPPORT_TICKETS_URL, { headers: bearer(token) }));
  }

  function getTicket(token: string, ticketId: string) {
    return firstValueFrom(http.get<TicketDetailFixture>(`${SUPPORT_TICKETS_URL}/${ticketId}`, { headers: bearer(token) }));
  }

  function discardTicket(token: string, ticketId: string, body: unknown) {
    return firstValueFrom(
      http.post<TicketDetailFixture>(`${SUPPORT_TICKETS_URL}/${ticketId}/discard`, body, { headers: bearer(token) }),
    );
  }

  async function seedAndLoginSupportAgent(email = SUPPORT_EMAIL, name = 'Pedro Soporte'): Promise<SupportSessionResponseFixture> {
    supportStore.addSupportAccount({
      name,
      email,
      password: SUPPORT_PASSWORD,
      status: 'active',
      mustChangePassword: false,
    });
    const res = await supportLogin({ email, password: SUPPORT_PASSWORD });
    return res.body as SupportSessionResponseFixture;
  }

  describe('POST /api/v1/auth/forgot-password (US1)', () => {
    it('[US1-AC1][US1-AC2][US1-AC3][US1-AC10] responde siempre 202 sin body (correo existente, inexistente o de soporte) y solo abre ticket para cuentas de taller', async () => {
      await registerWorkshop();
      const agent = await seedAndLoginSupportAgent();

      const resExisting = await forgotPassword({ email: ' Ana.Perez@Taller.EC ' });
      const resUnknown = await forgotPassword({ email: 'nadie@ejemplo.ec' });
      const resSupport = await forgotPassword({ email: SUPPORT_EMAIL });

      expect(resExisting.status).toBe(202);
      expect(resExisting.body).toBeNull();
      expect(resUnknown.status).toBe(202);
      expect(resUnknown.body).toBeNull();
      expect(resSupport.status).toBe(202);
      expect(resSupport.body).toBeNull();

      const inbox = await listTickets(agent.accessToken);
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0].account.email).toBe('ana.perez@taller.ec');
      expect(inbox.items[0].requestCount).toBe(1);
    });

    it('[US1-AC5][SC-008] mantiene un único ticket abierto por cuenta con requestCount creciente', async () => {
      await registerWorkshop();
      const agent = await seedAndLoginSupportAgent();

      await forgotPassword({ email: 'ana.perez@taller.ec' });
      await forgotPassword({ email: 'ANA.PEREZ@taller.ec' });
      await forgotPassword({ email: ' ana.perez@taller.ec ' });

      const inbox = await listTickets(agent.accessToken);
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0].requestCount).toBe(3);
    });

    it('[US1-AC6][FR-004] a la 21.ª solicitud del mismo origen simulado responde 429 HELP_RATE_LIMITED sin crear ni actualizar tickets', async () => {
      await registerWorkshop();
      await registerWorkshop({
        workshopName: 'Taller Benítez',
        ruc: OTHER_VALID_RUC,
        name: 'Bruno Benítez',
        email: 'bruno@taller.ec',
        password: PASSWORD,
      });
      const agent = await seedAndLoginSupportAgent();

      for (let i = 0; i < 20; i += 1) {
        const res = await forgotPassword({ email: 'ana.perez@taller.ec' }, '203.0.113.10');
        expect(res.status).toBe(202);
      }

      const rateLimitedExisting = await failure(forgotPassword({ email: 'bruno@taller.ec' }, '203.0.113.10'));
      const rateLimitedUnknown = await failure(forgotPassword({ email: 'nadie@ejemplo.ec' }, '203.0.113.10'));

      expect(rateLimitedExisting.status).toBe(429);
      expect(problemOf(rateLimitedExisting).code).toBe('HELP_RATE_LIMITED');
      expect(problemOf(rateLimitedUnknown)).toEqual(problemOf(rateLimitedExisting));

      const inbox = await listTickets(agent.accessToken);
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0].account.email).toBe('ana.perez@taller.ec');
      expect(inbox.items[0].requestCount).toBe(20);
    });

    it('[US1-AC8][US1-AC9] rechaza correo vacío o inválido con 400 VALIDATION_ERROR e ignora campos extra en una solicitud válida', async () => {
      const workshopB = await registerWorkshop({
        workshopName: 'Taller Benítez',
        ruc: OTHER_VALID_RUC,
        name: 'Bruno Benítez',
        email: 'bruno@taller.ec',
        password: PASSWORD,
      });
      await registerWorkshop();
      const agent = await seedAndLoginSupportAgent();

      const emptyErr = await failure(forgotPassword({ email: '  ' }));
      expect(emptyErr.status).toBe(400);
      expect(fieldCodes(emptyErr)).toContainEqual({ field: 'email', code: 'REQUIRED' });

      const invalidErr = await failure(forgotPassword({ email: 'invalido' }));
      expect(invalidErr.status).toBe(400);
      expect(fieldCodes(invalidErr)).toContainEqual({ field: 'email', code: 'INVALID_EMAIL' });

      const withExtra = await forgotPassword({
        email: 'ana.perez@taller.ec',
        tenantId: workshopB.workshop.id,
        userId: workshopB.user.id,
        ticketId: '99999999-9999-4999-8999-999999999999',
      });
      expect(withExtra.status).toBe(202);

      const inbox = await listTickets(agent.accessToken);
      expect(inbox.items).toHaveLength(1);
      expect(inbox.items[0].account.email).toBe('ana.perez@taller.ec');
      expect(inbox.items[0].workshop.name).toBe('Taller Andrade');
    });
  });

  describe('/support/auth/*: login, refresh, logout, me y password (US2)', () => {
    it('[US2-AC3][FR-009] login devuelve 401 INVALID_CREDENTIALS y bloquea con 429 ACCOUNT_LOCKED tras 5 fallos', async () => {
      await seedAndLoginSupportAgent();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const err = await failure(supportLogin({ email: SUPPORT_EMAIL, password: 'Clave-Incorrecta' }));
        expect(err.status).toBe(401);
        expect(problemOf(err).code).toBe('INVALID_CREDENTIALS');
        expect(JSON.stringify(err.error)).not.toContain('Clave-Incorrecta');
      }

      const locked = await failure(supportLogin({ email: SUPPORT_EMAIL, password: SUPPORT_PASSWORD }));
      expect(locked.status).toBe(429);
      expect(problemOf(locked).code).toBe('ACCOUNT_LOCKED');
    });

    it('[US2-AC1][FR-009] cuenta de soporte con temporal inicial bloquea /support/tickets con 403 PASSWORD_CHANGE_REQUIRED hasta cambiar contraseña', async () => {
      supportStore.addSupportAccount({
        name: 'Marta Soporte',
        email: 'marta.soporte@motorsync.ec',
        password: TEMPORARY_PASSWORD,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      });

      const loginRes = await supportLogin({ email: 'marta.soporte@motorsync.ec', password: TEMPORARY_PASSWORD });
      const tempSession = loginRes.body as SupportSessionResponseFixture;
      expect(tempSession.agent.mustChangePassword).toBe(true);
      expect(decodeClaims(tempSession.accessToken)?.['pwd_change']).toBe(true);

      const blocked = await failure(listTickets(tempSession.accessToken));
      expect(blocked.status).toBe(403);
      expect(problemOf(blocked).code).toBe('PASSWORD_CHANGE_REQUIRED');

      const meRes = await supportMe(tempSession.accessToken);
      expect(meRes.agent.mustChangePassword).toBe(true);

      const changed = await supportChangePassword(tempSession.accessToken, {
        currentPassword: TEMPORARY_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(changed.agent.mustChangePassword).toBe(false);
      expect(decodeClaims(changed.accessToken)?.['pwd_change']).toBe(false);

      const inbox = await listTickets(changed.accessToken);
      expect(inbox.items).toEqual([]);
    });

    it('[US2-AC9] refresh rota dentro de la misma sesión con X-Requested-With y logout es idempotente y revoca la sesión', async () => {
      const session = await seedAndLoginSupportAgent();

      const noCsrfRefresh = await failure(supportRefresh(false));
      expect(noCsrfRefresh.status).toBe(400);

      const refreshed = await supportRefresh(true);
      expect(refreshed.status).toBe(200);
      expect(decodeClaims(refreshed.body?.accessToken ?? '')?.['sid']).toBe(decodeClaims(session.accessToken)?.['sid']);

      const noCsrfLogout = await failure(supportLogout(false));
      expect(noCsrfLogout.status).toBe(400);

      expect((await supportLogout(true)).status).toBe(204);
      expect((await supportLogout(true)).status).toBe(204);

      const meAfterLogout = await failure(supportMe(session.accessToken));
      expect(meAfterLogout.status).toBe(401);
      expect(problemOf(meAfterLogout).code).toBe('SESSION_REVOKED');

      const refreshAfterLogout = await failure(supportRefresh(true));
      expect(refreshAfterLogout.status).toBe(401);
      expect(problemOf(refreshAfterLogout).code).toBe('SESSION_EXPIRED');
    });
  });

  describe('/support/tickets: bandeja ordenada, detalle y descarte (US2-AC7, AC8, AC11, AC12, AC13)', () => {
    it('[US2-AC7][FR-013] devuelve la bandeja de tickets abiertos ordenada por createdAt ascendente y con las claves exactas del contrato', async () => {
      await registerWorkshop();
      await registerWorkshop({
        workshopName: 'Taller Benítez',
        ruc: OTHER_VALID_RUC,
        name: 'Bruno Benítez',
        email: 'bruno@taller.ec',
        password: PASSWORD,
      });
      const agent = await seedAndLoginSupportAgent();

      await forgotPassword({ email: 'ana.perez@taller.ec' }, '198.51.100.1');
      await forgotPassword({ email: 'bruno@taller.ec' }, '198.51.100.2');

      const inbox = await listTickets(agent.accessToken);
      expect(inbox.items).toHaveLength(2);
      expect(inbox.items[0].account.email).toBe('ana.perez@taller.ec');
      expect(inbox.items[1].account.email).toBe('bruno@taller.ec');
      expect(Date.parse(inbox.items[0].createdAt)).toBeLessThanOrEqual(Date.parse(inbox.items[1].createdAt));

      for (const item of inbox.items) {
        expect(Object.keys(item).sort()).toEqual(
          ['account', 'createdAt', 'id', 'lastRequestedAt', 'number', 'requestCount', 'workshop'].sort(),
        );
        expect(Object.keys(item.account).sort()).toEqual(['email', 'name', 'role', 'status'].sort());
        expect(Object.keys(item.workshop).sort()).toEqual(['name', 'ruc'].sort());
      }
    });

    it('[US2-AC8][US2-AC12][US2-AC13][FR-012][FR-015] detalle y descarte: valida reason (REQUIRED), pasa a discarded, sale de la bandeja, no toca la auditoría del taller y rechaza otro descarte con 409 TICKET_NOT_OPEN', async () => {
      const workshopAdmin = await registerWorkshop();
      const agent = await seedAndLoginSupportAgent();

      await forgotPassword({ email: 'ana.perez@taller.ec' });
      const inbox = await listTickets(agent.accessToken);
      const ticketId = inbox.items[0].id;

      const openDetail = await getTicket(agent.accessToken, ticketId);
      expect(openDetail.status).toBe('open');
      expect(JSON.stringify(openDetail)).not.toContain(PASSWORD.trim());

      const requiredErr = await failure(discardTicket(agent.accessToken, ticketId, { reason: '   ' }));
      expect(requiredErr.status).toBe(400);
      expect(fieldCodes(requiredErr)).toContainEqual({ field: 'reason', code: 'REQUIRED' });

      const unknownFieldErr = await failure(
        discardTicket(agent.accessToken, ticketId, { reason: 'Motivo', userId: workshopAdmin.user.id }),
      );
      expect(unknownFieldErr.status).toBe(400);
      expect(fieldCodes(unknownFieldErr)).toContainEqual({ field: 'userId', code: 'UNKNOWN_FIELD' });

      const discarded = await discardTicket(agent.accessToken, ticketId, {
        reason: ' Solicitud duplicada atendida por su administrador ',
      });
      expect(discarded.status).toBe('discarded');
      expect(discarded.discard).toEqual({
        reason: 'Solicitud duplicada atendida por su administrador',
        discardedByName: 'Pedro Soporte',
        discardedAt: expect.any(String),
      });

      const afterInbox = await listTickets(agent.accessToken);
      expect(afterInbox.items).toHaveLength(0);

      const closedDetail = await getTicket(agent.accessToken, ticketId);
      expect(closedDetail.status).toBe('discarded');
      expect(closedDetail.discard?.reason).toBe('Solicitud duplicada atendida por su administrador');

      const secondDiscard = await failure(discardTicket(agent.accessToken, ticketId, { reason: 'Segundo intento' }));
      expect(secondDiscard.status).toBe(409);
      expect(problemOf(secondDiscard).code).toBe('TICKET_NOT_OPEN');

      const history = await firstValueFrom(
        http.get<UserHistoryResponse>(`${USERS_URL}/${workshopAdmin.user.id}/history`, {
          headers: bearer(workshopAdmin.accessToken),
        }),
      );
      expect(history.items).toEqual([]);
    });

    it('[US2-AC11][US2-AC13][FR-015] rutas prohibidas o inexistentes bajo /support responden 404 NOT_FOUND', async () => {
      const agent = await seedAndLoginSupportAgent();

      for (const req of [
        firstValueFrom(http.delete(`${SUPPORT_TICKETS_URL}/77777777-7777-4777-8777-777777777777`, { headers: bearer(agent.accessToken) })),
        firstValueFrom(
          http.post(`${SUPPORT_TICKETS_URL}/77777777-7777-4777-8777-777777777777/reopen`, {}, { headers: bearer(agent.accessToken) }),
        ),
        firstValueFrom(http.post('/api/v1/support/accounts', {}, { headers: bearer(agent.accessToken) })),
      ]) {
        const err = await failure(req);
        expect(err.status).toBe(404);
        expect(problemOf(err).code).toBe('NOT_FOUND');
      }
    });
  });

  describe('separación entre taller y soporte (US2-AC5, US2-AC6, FR-008)', () => {
    it('[US2-AC5][FR-008] un token de taller en /support/** recibe 403 FORBIDDEN', async () => {
      const workshopAdmin = await registerWorkshop();

      for (const token of [workshopAdmin.accessToken, tokenFor('admin'), tokenFor('asesor')]) {
        for (const req of [
          supportMe(token),
          supportChangePassword(token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
          listTickets(token),
          getTicket(token, '77777777-7777-4777-8777-777777777777'),
          discardTicket(token, '77777777-7777-4777-8777-777777777777', { reason: 'Motivo' }),
        ]) {
          const err = await failure(req);
          expect(err.status).toBe(403);
          expect(problemOf(err).code).toBe('FORBIDDEN');
        }
      }
    });

    it('[US2-AC6][FR-008] un token de soporte en rutas del taller recibe 403 FORBIDDEN y sus credenciales no entran en /auth/login', async () => {
      const agent = await seedAndLoginSupportAgent();
      const headers = bearer(agent.accessToken);

      for (const req of [
        firstValueFrom(http.get(ME_URL, { headers })),
        firstValueFrom(http.post(PASSWORD_URL, { currentPassword: SUPPORT_PASSWORD, newPassword: NEW_PASSWORD }, { headers })),
        firstValueFrom(http.get(USERS_URL, { headers })),
        firstValueFrom(http.get(CLIENTS_SEARCH_URL, { headers })),
        firstValueFrom(http.get(VEHICLES_SEARCH_URL, { headers })),
      ]) {
        const err = await failure(req);
        expect(err.status).toBe(403);
        expect(problemOf(err).code).toBe('FORBIDDEN');
      }

      const workshopLoginWithSupportCreds = await failure(
        firstValueFrom(http.post(LOGIN_URL, { email: SUPPORT_EMAIL, password: SUPPORT_PASSWORD })),
      );
      expect(workshopLoginWithSupportCreds.status).toBe(401);
      expect(problemOf(workshopLoginWithSupportCreds).code).toBe('INVALID_CREDENTIALS');
    });
  });
});
