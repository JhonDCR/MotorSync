// T051 (003, PR2, US3): POST /api/v1/support/tickets/:ticketId/temporary-password en mockApiInterceptor
// contra specs/003-soporte-plataforma/contracts/openapi.yaml, spec.md (US3) y research R9/R11/R13.
// Archivo nuevo: no modifica mock-api.interceptor.support.spec.ts del PR1.
//
// Contrato para el implementer-frontend (T052), archivos core/api/mock-api.interceptor.ts,
// mock-support.store.ts, mock-auth.store.ts y api.models.ts:
//   - POST /api/v1/support/tickets/:ticketId/temporary-password (protegida por Bearer de soporte):
//     - Con token de taller (o sin aud: 'motorsync-support') → 403 FORBIDDEN (US2-AC5, FR-008).
//     - Con sesión de soporte con temporal pendiente → 403 PASSWORD_CHANGE_REQUIRED.
//     - Valida el body: solo admite `verificationNote` (1..1000 caracteres tras recortar; vacía o solo espacios o
//       > 1000 → 400 VALIDATION_ERROR con REQUIRED / VALIDATION_ERROR en `verificationNote`; `userId`, `tenantId`
//       u otro campo → 400 VALIDATION_ERROR con UNKNOWN_FIELD; US3-AC3, US3-AC9).
//     - Si el ticket no existe o el id no es uuid → 404 NOT_FOUND.
//     - Si el ticket ya está `resolved` o `discarded` → 409 TICKET_NOT_OPEN (una sola temporal por ticket; US3-AC2,
//       US3-AC5, US3-AC12).
//     - Si la cuenta del ticket está `inactive` → 409 ACCOUNT_INACTIVE (US3-AC8).
//     - En caso de éxito (200 TemporaryPasswordResponse):
//       - Genera una contraseña temporal con formato `^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$` (19 caracteres,
//         sin 0/O ni 1/I/L; FR-019).
//       - En MockAuthStore actualiza la cuenta del ticket: nueva contraseña temporal funcional para `/auth/login`,
//         `mustChangePassword = true`, `temporaryPasswordExpiresAt` a ~72 h, cierra las sesiones abiertas de la
//         cuenta (`sessionsClosed`), reinicia el bloqueo/intentos fallidos, conserva `role` y `status` (US3-AC13) y
//         fija `updatedByName = "Soporte MotorSync (<nombre del agente>)"`.
//       - Agrega al historial de la cuenta (`GET /api/v1/users/:id/history`) un registro
//         `action = 'user.password_reset_by_support'`, `actorRole = 'platform_support'`, `actorName` = nombre del
//         agente (sin correo), `channel = 'support_panel'`, `before = { mustChangePassword }`,
//         `after = { mustChangePassword: true, temporaryPasswordExpiresAt, sessionsClosed, supportTicketNumber }`
//         (sin contraseñas ni `verificationNote`; US3-AC6, FR-020).
//       - El ticket pasa a `status = 'resolved'` con `resolution = { verificationNote (recortada), resolvedByName,
//         resolvedAt }`, sale de la bandeja de abiertos y ninguna consulta posterior (`GET /support/tickets/:id`)
//         contiene la contraseña temporal generada (US3-AC2).
import { HttpClient, HttpErrorResponse, HttpHeaders, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  LOGIN_URL,
  ME_URL,
  OTHER_VALID_RUC,
  PASSWORD,
  REGISTER_BODY,
  TEMPORARY_PASSWORD,
  type SessionResponseFixture,
} from '../../../testing/auth-fixtures';
import { tokenFor } from '../../../testing/fake-jwt';
import {
  FORGOT_PASSWORD_URL,
  SUPPORT_EMAIL,
  SUPPORT_LOGIN_URL,
  SUPPORT_PASSWORD,
  SUPPORT_TICKETS_URL,
  type SupportSessionResponseFixture,
  type TemporaryPasswordResponseFixture,
  type TicketDetailFixture,
  type TicketListResponseFixture,
} from '../../../testing/support-fixtures';
import type { Problem, UserAccount } from './api.models';
import { mockApiInterceptor } from './mock-api.interceptor';
import { MockAuthStore } from './mock-auth.store';
import { MockSupportStore } from './mock-support.store';
import { USE_MOCK_API } from './use-mock-api';

const REGISTER_URL = '/api/v1/auth/register';
const USERS_URL = '/api/v1/users';
const TEMP_PASSWORD_PATTERN = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/;
const VERIFICATION_NOTE = 'Videollamada con cédula en mano y confirmación del RUC del taller';

interface AuditEntryForSupportSpec {
  id: string;
  action: string;
  actorName: string;
  actorRole: string;
  occurredAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  channel: string;
}

interface UserHistoryForSupportSpec {
  items: AuditEntryForSupportSpec[];
}

describe('mockApiInterceptor: POST /support/tickets/:ticketId/temporary-password (T051)', () => {
  let http: HttpClient;
  let authStore: MockAuthStore;
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
    authStore = TestBed.inject(MockAuthStore);
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

  function workshopLogin(email: string, password: string) {
    return firstValueFrom(http.post<SessionResponseFixture>(LOGIN_URL, { email, password }, { withCredentials: true }));
  }

  function workshopMe(token: string) {
    return firstValueFrom(http.get(ME_URL, { headers: bearer(token) }));
  }

  function forgotPassword(email: string) {
    return firstValueFrom(http.post(FORGOT_PASSWORD_URL, { email }, { observe: 'response' }));
  }

  function listTickets(token: string) {
    return firstValueFrom(http.get<TicketListResponseFixture>(SUPPORT_TICKETS_URL, { headers: bearer(token) }));
  }

  function getTicket(token: string, ticketId: string) {
    return firstValueFrom(
      http.get<TicketDetailFixture>(`${SUPPORT_TICKETS_URL}/${ticketId}`, { headers: bearer(token) }),
    );
  }

  function discardTicket(token: string, ticketId: string, reason: string) {
    return firstValueFrom(
      http.post<TicketDetailFixture>(
        `${SUPPORT_TICKETS_URL}/${ticketId}/discard`,
        { reason },
        { headers: bearer(token) },
      ),
    );
  }

  function generateTemporaryPassword(token: string, ticketId: string, body: unknown) {
    return firstValueFrom(
      http.post<TemporaryPasswordResponseFixture>(
        `${SUPPORT_TICKETS_URL}/${ticketId}/temporary-password`,
        body,
        { headers: bearer(token) },
      ),
    );
  }

  function getUser(token: string, userId: string) {
    return firstValueFrom(http.get<UserAccount>(`${USERS_URL}/${userId}`, { headers: bearer(token) }));
  }

  function getUserHistory(token: string, userId: string) {
    return firstValueFrom(
      http.get<UserHistoryForSupportSpec>(`${USERS_URL}/${userId}/history`, { headers: bearer(token) }),
    );
  }

  async function seedAndLoginSupportAgent(
    email = SUPPORT_EMAIL,
    name = 'Pedro Soporte',
  ): Promise<SupportSessionResponseFixture> {
    supportStore.addSupportAccount({
      name,
      email,
      password: SUPPORT_PASSWORD,
      status: 'active',
      mustChangePassword: false,
    });
    return firstValueFrom(
      http.post<SupportSessionResponseFixture>(
        SUPPORT_LOGIN_URL,
        { email, password: SUPPORT_PASSWORD },
        { withCredentials: true },
      ),
    );
  }

  it('[US3-AC1][US3-AC2][US3-AC4][US3-AC6][US3-AC13][FR-019][FR-020] genera la temporal con el formato del contrato, resuelve el ticket, cierra sesiones, reinicia el bloqueo, actualiza la cuenta de MockAuthStore y registra user.password_reset_by_support en el historial', async () => {
    const adminSession1 = await registerWorkshop();
    const adminSession2 = await workshopLogin('ana.perez@taller.ec', PASSWORD);
    const agent = await seedAndLoginSupportAgent();

    // Bloquea la cuenta de Ana con 5 intentos fallidos seguidos antes de que soporte genere la temporal.
    for (let i = 0; i < 5; i += 1) {
      const bad = await failure(workshopLogin('ana.perez@taller.ec', 'Clave-Erronea-123'));
      expect(bad.status).toBe(401);
    }
    const lockedBefore = await failure(workshopLogin('ana.perez@taller.ec', PASSWORD));
    expect(lockedBefore.status).toBe(429);

    await forgotPassword('ana.perez@taller.ec');
    const inbox = await listTickets(agent.accessToken);
    expect(inbox.items).toHaveLength(1);
    const ticket = inbox.items[0];

    const beforeMs = Date.now();
    const result = await generateTemporaryPassword(agent.accessToken, ticket.id, {
      verificationNote: `  ${VERIFICATION_NOTE}  `,
    });

    // Formato de la contraseña temporal: 4 bloques de 4 caracteres sin 0/O ni 1/I/L separados por guiones.
    expect(result.temporaryPassword).toMatch(TEMP_PASSWORD_PATTERN);
    expect(result.temporaryPassword).toHaveLength(19);
    expect(result.sessionsClosed).toBe(2);

    const expiresMs = Date.parse(result.temporaryPasswordExpiresAt);
    expect(expiresMs).toBeGreaterThanOrEqual(beforeMs + 71 * 3600 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 73 * 3600 * 1000);

    // El ticket queda resolved con la nota recortada y el nombre del agente, y sale de la bandeja de abiertos.
    expect(result.ticket.id).toBe(ticket.id);
    expect(result.ticket.status).toBe('resolved');
    expect(result.ticket.resolution).toEqual({
      verificationNote: VERIFICATION_NOTE,
      resolvedByName: 'Pedro Soporte',
      resolvedAt: expect.any(String),
    });

    const openAfter = await listTickets(agent.accessToken);
    expect(openAfter.items).toEqual([]);

    // US3-AC2: consultar el ticket después nunca devuelve la contraseña temporal.
    const detailAfter = await getTicket(agent.accessToken, ticket.id);
    expect(detailAfter.status).toBe('resolved');
    expect(JSON.stringify(detailAfter)).not.toContain(result.temporaryPassword);

    // Ambas sesiones anteriores de Ana quedaron revocadas.
    for (const oldToken of [adminSession1.accessToken, adminSession2.accessToken]) {
      const revoked = await failure(workshopMe(oldToken));
      expect(revoked.status).toBe(401);
      expect(problemOf(revoked).code).toBe('SESSION_REVOKED');
    }

    // La contraseña anterior ya no sirve, el bloqueo quedó reiniciado y la nueva temporal abre sesión con mustChangePassword = true.
    const oldPwdErr = await failure(workshopLogin('ana.perez@taller.ec', PASSWORD));
    expect(oldPwdErr.status).toBe(401);
    expect(problemOf(oldPwdErr).code).toBe('INVALID_CREDENTIALS');

    const tempLogin = await workshopLogin('ana.perez@taller.ec', result.temporaryPassword);
    expect(tempLogin.user.mustChangePassword).toBe(true);
    expect(tempLogin.user.temporaryPasswordExpiresAt).toBe(result.temporaryPasswordExpiresAt);
    expect(tempLogin.user.role).toBe('admin');

    // Al cambiar su contraseña obligatoria, Ana puede consultar su cuenta y su historial de auditoría.
    const changedSession = await firstValueFrom(
      http.post<SessionResponseFixture>(
        '/api/v1/auth/password',
        { currentPassword: result.temporaryPassword, newPassword: 'Nueva Clave Admin 2026' },
        { headers: bearer(tempLogin.accessToken) },
      ),
    );

    const updatedAccount = await getUser(changedSession.accessToken, adminSession1.user.id);
    expect(updatedAccount.role).toBe('admin');
    expect(updatedAccount.status).toBe('active');
    expect(updatedAccount.updatedByName).toBe('Soporte MotorSync (Pedro Soporte)');

    const history = await getUserHistory(changedSession.accessToken, adminSession1.user.id);
    expect(history.items).toHaveLength(1);
    const entry = history.items[0];
    expect(entry.action).toBe('user.password_reset_by_support');
    expect(entry.actorRole).toBe('platform_support');
    expect(entry.actorName).toBe('Pedro Soporte');
    expect(entry.channel).toBe('support_panel');
    expect(entry.before).toEqual({ mustChangePassword: false });
    expect(entry.after).toEqual({
      mustChangePassword: true,
      temporaryPasswordExpiresAt: result.temporaryPasswordExpiresAt,
      sessionsClosed: 2,
      supportTicketNumber: ticket.number,
    });
    const serializedEntry = JSON.stringify(entry);
    expect(serializedEntry).not.toContain(result.temporaryPassword);
    expect(serializedEntry).not.toContain(PASSWORD.trim());
    expect(serializedEntry).not.toContain(VERIFICATION_NOTE);
    expect(serializedEntry).not.toContain(SUPPORT_EMAIL);
  });

  it('[US3-AC2][US3-AC5][US3-AC12] admite una sola temporal por ticket: rechaza la segunda llamada o un ticket descartado con 409 TICKET_NOT_OPEN y un id inexistente con 404 NOT_FOUND', async () => {
    const admin = await registerWorkshop();
    const agent = await seedAndLoginSupportAgent();

    await forgotPassword('ana.perez@taller.ec');
    const ticketId = (await listTickets(agent.accessToken)).items[0].id;

    const first = await generateTemporaryPassword(agent.accessToken, ticketId, {
      verificationNote: VERIFICATION_NOTE,
    });
    expect(first.ticket.status).toBe('resolved');

    // Segunda llamada sobre el mismo ticket ya resuelto → 409 TICKET_NOT_OPEN sin cambiar la temporal ni duplicar auditoría.
    const secondErr = await failure(
      generateTemporaryPassword(agent.accessToken, ticketId, { verificationNote: 'Segundo intento' }),
    );
    expect(secondErr.status).toBe(409);
    expect(problemOf(secondErr).code).toBe('TICKET_NOT_OPEN');

    // La primera temporal sigue funcionando.
    const loginWithFirst = await workshopLogin('ana.perez@taller.ec', first.temporaryPassword);
    expect(loginWithFirst.user.id).toBe(admin.user.id);

    // Un ticket nuevo descartado tampoco admite generar temporal → 409 TICKET_NOT_OPEN.
    await forgotPassword('ana.perez@taller.ec');
    const secondTicketId = (await listTickets(agent.accessToken)).items[0].id;
    await discardTicket(agent.accessToken, secondTicketId, 'Ya fue atendida');

    const discardedErr = await failure(
      generateTemporaryPassword(agent.accessToken, secondTicketId, { verificationNote: VERIFICATION_NOTE }),
    );
    expect(discardedErr.status).toBe(409);
    expect(problemOf(discardedErr).code).toBe('TICKET_NOT_OPEN');

    // Ticket inexistente o id no uuid → 404 NOT_FOUND.
    for (const unknownId of ['99999999-9999-4999-8999-999999999999', 'no-es-uuid']) {
      const notFoundErr = await failure(
        generateTemporaryPassword(agent.accessToken, unknownId, { verificationNote: VERIFICATION_NOTE }),
      );
      expect(notFoundErr.status).toBe(404);
      expect(problemOf(notFoundErr).code).toBe('NOT_FOUND');
    }
  });

  it('[US3-AC8] rechaza con 409 ACCOUNT_INACTIVE si la cuenta del ticket está desactivada, sin modificar la cuenta ni el ticket ni crear auditoría', async () => {
    const admin = await registerWorkshop();
    authStore.addAccount({
      id: '33333333-3333-4333-8333-333333333333',
      workshopId: admin.workshop.id,
      name: 'Luis Inactivo',
      email: 'luis.inactivo@taller.ec',
      role: 'asesor',
      password: PASSWORD,
      status: 'inactive',
    });
    const agent = await seedAndLoginSupportAgent();

    await forgotPassword('luis.inactivo@taller.ec');
    const ticketId = (await listTickets(agent.accessToken)).items[0].id;

    const inactiveErr = await failure(
      generateTemporaryPassword(agent.accessToken, ticketId, { verificationNote: VERIFICATION_NOTE }),
    );
    expect(inactiveErr.status).toBe(409);
    expect(problemOf(inactiveErr).code).toBe('ACCOUNT_INACTIVE');

    // El ticket sigue abierto y no hay registro de auditoría.
    const detail = await getTicket(agent.accessToken, ticketId);
    expect(detail.status).toBe('open');

    const history = await getUserHistory(admin.accessToken, '33333333-3333-4333-8333-333333333333');
    expect(history.items).toEqual([]);
  });

  it('[US3-AC3][US3-AC9] valida verificationNote (REQUIRED si falta, es vacía o solo espacios, y > 1000 caracteres) y rechaza userId o tenantId con 400 UNKNOWN_FIELD sin efectos', async () => {
    const workshopA = await registerWorkshop();
    const workshopB = await registerWorkshop({
      workshopName: 'Taller Benítez',
      ruc: OTHER_VALID_RUC,
      name: 'Bruno Benítez',
      email: 'bruno@taller.ec',
      password: PASSWORD,
    });
    const agent = await seedAndLoginSupportAgent();

    await forgotPassword('ana.perez@taller.ec');
    const ticketId = (await listTickets(agent.accessToken)).items[0].id;

    for (const invalidBody of [{}, { verificationNote: '' }, { verificationNote: '   \n\t  ' }]) {
      const err = await failure(generateTemporaryPassword(agent.accessToken, ticketId, invalidBody));
      expect(err.status).toBe(400);
      expect(problemOf(err).code).toBe('VALIDATION_ERROR');
      expect(fieldCodes(err)).toContainEqual({ field: 'verificationNote', code: 'REQUIRED' });
    }

    const tooLongErr = await failure(
      generateTemporaryPassword(agent.accessToken, ticketId, { verificationNote: 'x'.repeat(1001) }),
    );
    expect(tooLongErr.status).toBe(400);
    expect(problemOf(tooLongErr).code).toBe('VALIDATION_ERROR');
    expect((problemOf(tooLongErr).errors ?? []).some((e) => e.field === 'verificationNote')).toBe(true);

    const withUserIdErr = await failure(
      generateTemporaryPassword(agent.accessToken, ticketId, {
        verificationNote: VERIFICATION_NOTE,
        userId: workshopB.user.id,
      }),
    );
    expect(withUserIdErr.status).toBe(400);
    expect(fieldCodes(withUserIdErr)).toContainEqual({ field: 'userId', code: 'UNKNOWN_FIELD' });

    const withTenantIdErr = await failure(
      generateTemporaryPassword(agent.accessToken, ticketId, {
        verificationNote: VERIFICATION_NOTE,
        tenantId: workshopB.workshop.id,
      }),
    );
    expect(withTenantIdErr.status).toBe(400);
    expect(fieldCodes(withTenantIdErr)).toContainEqual({ field: 'tenantId', code: 'UNKNOWN_FIELD' });

    // Ninguno de los intentos rechazados cerró la sesión de Ana, ni alteró el ticket ni la auditoría de A o B.
    const meStillAlive = await workshopMe(workshopA.accessToken);
    expect(meStillAlive).toBeTruthy();
    expect((await getTicket(agent.accessToken, ticketId)).status).toBe('open');
    expect((await getUserHistory(workshopA.accessToken, workshopA.user.id)).items).toEqual([]);
    expect((await getUserHistory(workshopB.accessToken, workshopB.user.id)).items).toEqual([]);
  });

  it('[US2-AC5][US2-AC1][FR-008] rechaza con 403 FORBIDDEN un token de taller y con 403 PASSWORD_CHANGE_REQUIRED una sesión de soporte con temporal pendiente', async () => {
    const workshopAdmin = await registerWorkshop();
    const agent = await seedAndLoginSupportAgent();

    await forgotPassword('ana.perez@taller.ec');
    const ticketId = (await listTickets(agent.accessToken)).items[0].id;

    for (const token of [workshopAdmin.accessToken, tokenFor('admin'), tokenFor('asesor')]) {
      const err = await failure(
        generateTemporaryPassword(token, ticketId, { verificationNote: VERIFICATION_NOTE }),
      );
      expect(err.status).toBe(403);
      expect(problemOf(err).code).toBe('FORBIDDEN');
    }

    supportStore.addSupportAccount({
      name: 'Marta Temporal',
      email: 'marta.temp@motorsync.ec',
      password: TEMPORARY_PASSWORD,
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    });
    const martaSession = await firstValueFrom(
      http.post<SupportSessionResponseFixture>(
        SUPPORT_LOGIN_URL,
        { email: 'marta.temp@motorsync.ec', password: TEMPORARY_PASSWORD },
        { withCredentials: true },
      ),
    );

    const pwdChangeErr = await failure(
      generateTemporaryPassword(martaSession.accessToken, ticketId, { verificationNote: VERIFICATION_NOTE }),
    );
    expect(pwdChangeErr.status).toBe(403);
    expect(problemOf(pwdChangeErr).code).toBe('PASSWORD_CHANGE_REQUIRED');

    expect((await getTicket(agent.accessToken, ticketId)).status).toBe('open');
  });
});
