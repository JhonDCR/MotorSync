// T031 (003, PR1, US1, US2): pruebas unitarias de MockSupportStore contra
// specs/003-soporte-plataforma/contracts/openapi.yaml y research R13.
//
// Contrato para el implementer-frontend (T034), archivo core/api/mock-support.store.ts:
//   @Injectable({ providedIn: 'root' }) export class MockSupportStore {
//     addSupportAccount(input: MockSupportAccountInput): void
//     forgotPassword(raw: unknown, origin?: string): MockResult<null>
//     login(raw: unknown): MockResult<SupportSessionResponse>
//     refresh(csrfHeaderValid: boolean): MockResult<SupportSessionResponse>
//     logout(csrfHeaderValid: boolean): MockResult<null>
//     me(token: string | null): MockResult<CurrentSupportSessionResponse>
//     changePassword(token: string | null, raw: unknown): MockResult<SupportSessionResponse>
//     listOpenTickets(token: string | null): MockResult<TicketListResponse>
//     getTicket(token: string | null, ticketId: string): MockResult<TicketDetail>
//     discardTicket(token: string | null, ticketId: string, raw: unknown): MockResult<TicketDetail>
//   }
//   Reglas:
//   - Cuenta semilla de desarrollo: `soporte@motorsync.test` (activa, sin cambio de contraseña pendiente).
//   - FR-024: los correos de soporte (normalizados) no pueden coincidir con los de cuentas de taller de MockAuthStore
//     en ningún sentido (addSupportAccount lanza error si el correo ya existe en MockAuthStore o en soporte; y
//     MockAuthStore.register / createUser devuelven 409 REGISTRATION_FAILED / EMAIL_UNAVAILABLE si el correo es de
//     soporte).
//   - forgotPassword(raw, origin = '127.0.0.1'):
//     - Valida solo `email` (REQUIRED / INVALID_EMAIL → 400 VALIDATION_ERROR; no cuenta para el límite por origen).
//     - Ignora cualquier campo extra en el body (tenantId, userId, ticketId; US1-AC9).
//     - Límite por origen simulado: 20 solicitudes válidas por hora por `origin`; de la 21.ª en adelante responde
//       429 HELP_RATE_LIMITED sin crear ni modificar tickets (US1-AC6).
//     - Si el correo normalizado existe en MockAuthStore, abre un ticket `open` (requestCount = 1) o, si esa cuenta ya
//       tiene un ticket `open`, incrementa `requestCount` y actualiza `lastRequestedAt` sin crear otro (US1-AC5,
//       US1-AC7, SC-008). Si el ticket anterior de la cuenta está `discarded` o `resolved`, crea un ticket nuevo.
//     - Si el correo no existe o es de soporte, no guarda nada ni crea ticket (US1-AC3, US1-AC10).
//     - Siempre devuelve `{ ok: true, status: 202, body: null }` dentro del límite (US1-AC2).
//   - Acceso de soporte (login, refresh, logout, me, changePassword):
//     - Mismas reglas de la 002 (bloqueo 5/15 en login y en changePassword, cookie simulada `ms_support_refresh`
//       separada de la del taller, CSRF `X-Requested-With: motorsync` en refresh y logout, temporal de 72 h con
//       PASSWORD_CHANGE_REQUIRED en las rutas del panel salvo me/password/logout).
//     - El JWT de soporte lleva `sub`, `sid`, `name`, `pwd_change`, `aud: 'motorsync-support'` y `exp` (nunca
//       `tenant_id` ni `role`).
//     - Un token de taller en cualquier método protegido de MockSupportStore devuelve 403 FORBIDDEN (US2-AC5).
//   - Tickets (listOpenTickets, getTicket, discardTicket):
//     - listOpenTickets devuelve solo los `open`, ordenados por `createdAt` ascendente (del más antiguo al más
//       reciente), y cada elemento tiene exactamente `id, number, createdAt, lastRequestedAt, requestCount,
//       account{email, name, role, status}, workshop{name, ruc}` (US2-AC7, FR-013).
//     - discardTicket exige `reason` no vacío tras recortar (1–500 caracteres; vacío o espacios → 400 REQUIRED en
//       `reason`; campos extra → 400 UNKNOWN_FIELD; ticket ya cerrado → 409 TICKET_NOT_OPEN; id inexistente → 404).
import { TestBed } from '@angular/core/testing';
import {
  decodeClaims,
  NEW_PASSWORD,
  OTHER_VALID_RUC,
  PASSWORD,
  REGISTER_BODY,
  TEMPORARY_PASSWORD,
} from '../../../testing/auth-fixtures';
import {
  SUPPORT_EMAIL,
  SUPPORT_JWT_AUDIENCE,
  SUPPORT_PASSWORD,
  type SupportSessionResponseFixture,
  type TicketDetailFixture,
  type TicketSummaryFixture,
} from '../../../testing/support-fixtures';
import { MockAuthStore } from './mock-auth.store';
import { MockSupportStore } from './mock-support.store';

describe('MockSupportStore (T031)', () => {
  let support: MockSupportStore;
  let auth: MockAuthStore;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    auth = TestBed.inject(MockAuthStore);
    support = TestBed.inject(MockSupportStore);
  });

  function registerWorkshopA() {
    const res = auth.register(REGISTER_BODY);
    if (!res.ok) throw new Error('Falló registro de taller A en fixture');
    return res.body;
  }

  function registerWorkshopB() {
    const res = auth.register({
      workshopName: 'Taller Benítez',
      ruc: OTHER_VALID_RUC,
      name: 'Bruno Benítez',
      email: 'bruno@taller.ec',
      password: PASSWORD,
    });
    if (!res.ok) throw new Error('Falló registro de taller B en fixture');
    return res.body;
  }

  function addActiveAgent(email = SUPPORT_EMAIL, name = 'Pedro Soporte'): void {
    support.addSupportAccount({
      name,
      email,
      password: SUPPORT_PASSWORD,
      status: 'active',
      mustChangePassword: false,
    });
  }

  function loginAgent(email = SUPPORT_EMAIL, password = SUPPORT_PASSWORD): SupportSessionResponseFixture {
    const res = support.login({ email, password });
    if (!res.ok) throw new Error(`Falló login de soporte: ${res.problem.code}`);
    return res.body;
  }

  describe('forgotPassword (US1)', () => {
    it('[US1-AC1][US1-AC2][US1-AC3][US1-AC10] responde siempre 202 para cuenta existente, inexistente o de soporte, y solo crea ticket para la de taller', () => {
      registerWorkshopA();
      addActiveAgent();

      const existing = support.forgotPassword({ email: ' Ana.Perez@Taller.EC ' });
      const unknown = support.forgotPassword({ email: 'nadie@ejemplo.ec' });
      const supportEmail = support.forgotPassword({ email: SUPPORT_EMAIL });

      expect(existing).toEqual({ ok: true, status: 202, body: null });
      expect(unknown).toEqual({ ok: true, status: 202, body: null });
      expect(supportEmail).toEqual({ ok: true, status: 202, body: null });

      const agentSession = loginAgent();
      const inbox = support.listOpenTickets(agentSession.accessToken);
      expect(inbox.ok).toBe(true);
      if (!inbox.ok) return;

      expect(inbox.body.items).toHaveLength(1);
      expect(inbox.body.items[0].account.email).toBe('ana.perez@taller.ec');
      expect(inbox.body.items[0].requestCount).toBe(1);
      expect(JSON.stringify(inbox.body)).not.toContain('nadie@ejemplo.ec');
      expect(JSON.stringify(inbox.body)).not.toContain(SUPPORT_EMAIL);
    });

    it('[US1-AC4][FR-005] pedir ayuda no altera la contraseña, las sesiones ni la auditoría de la cuenta del taller', () => {
      const workshopSession = registerWorkshopA();

      support.forgotPassword({ email: REGISTER_BODY.email });

      expect(auth.me(workshopSession.accessToken).ok).toBe(true);
      expect(auth.login({ email: REGISTER_BODY.email, password: PASSWORD }).ok).toBe(true);
      const history = auth.getUserHistory(workshopSession.accessToken, workshopSession.user.id);
      expect(history).toEqual({ ok: true, status: 200, body: { items: [] } });
    });

    it('[US1-AC5][SC-008] no duplica el ticket abierto de una misma cuenta: incrementa requestCount y actualiza lastRequestedAt', () => {
      registerWorkshopA();
      addActiveAgent();
      const agentSession = loginAgent();

      support.forgotPassword({ email: 'ana.perez@taller.ec' });
      const firstList = support.listOpenTickets(agentSession.accessToken);
      if (!firstList.ok) throw new Error('Se esperaba 200');
      const firstTicket = firstList.body.items[0];

      support.forgotPassword({ email: ' ANA.PEREZ@TALLER.EC ' });
      support.forgotPassword({ email: 'ana.perez@taller.ec' });

      const secondList = support.listOpenTickets(agentSession.accessToken);
      expect(secondList.ok).toBe(true);
      if (!secondList.ok) return;

      expect(secondList.body.items).toHaveLength(1);
      const updatedTicket = secondList.body.items[0];
      expect(updatedTicket.id).toBe(firstTicket.id);
      expect(updatedTicket.number).toBe(firstTicket.number);
      expect(updatedTicket.requestCount).toBe(3);
      expect(Date.parse(updatedTicket.lastRequestedAt)).toBeGreaterThanOrEqual(Date.parse(firstTicket.createdAt));
    });

    it('[US1-AC5][US2-AC13] si el ticket anterior fue descartado, una nueva solicitud crea un ticket nuevo', () => {
      registerWorkshopA();
      addActiveAgent();
      const agentSession = loginAgent();

      support.forgotPassword({ email: 'ana.perez@taller.ec' });
      const firstList = support.listOpenTickets(agentSession.accessToken);
      if (!firstList.ok) throw new Error('Se esperaba 200');
      const firstTicket = firstList.body.items[0];

      const discarded = support.discardTicket(agentSession.accessToken, firstTicket.id, {
        reason: 'El usuario recordó su contraseña',
      });
      expect(discarded.ok).toBe(true);

      support.forgotPassword({ email: 'ana.perez@taller.ec' });
      const afterReRequest = support.listOpenTickets(agentSession.accessToken);
      expect(afterReRequest.ok).toBe(true);
      if (!afterReRequest.ok) return;

      expect(afterReRequest.body.items).toHaveLength(1);
      expect(afterReRequest.body.items[0].id).not.toBe(firstTicket.id);
      expect(afterReRequest.body.items[0].number).toBeGreaterThan(firstTicket.number);
      expect(afterReRequest.body.items[0].requestCount).toBe(1);
    });

    it('[US1-AC6][FR-004] permite 20 solicitudes por origen simulado y rechaza la 21.ª con 429 HELP_RATE_LIMITED sin crear ni modificar tickets', () => {
      registerWorkshopA();
      registerWorkshopB();
      addActiveAgent();
      const agentSession = loginAgent();

      for (let i = 0; i < 20; i += 1) {
        const res = support.forgotPassword({ email: 'ana.perez@taller.ec' }, '10.0.0.1');
        expect(res).toEqual({ ok: true, status: 202, body: null });
      }

      const twentyFirstExisting = support.forgotPassword({ email: 'bruno@taller.ec' }, '10.0.0.1');
      const twentySecondUnknown = support.forgotPassword({ email: 'nadie@ejemplo.ec' }, '10.0.0.1');

      expect(twentyFirstExisting.ok).toBe(false);
      expect(twentySecondUnknown.ok).toBe(false);
      if (twentyFirstExisting.ok || twentySecondUnknown.ok) return;

      expect(twentyFirstExisting.problem.status).toBe(429);
      expect(twentyFirstExisting.problem.code).toBe('HELP_RATE_LIMITED');
      expect(twentySecondUnknown.problem).toEqual(twentyFirstExisting.problem);

      const inbox = support.listOpenTickets(agentSession.accessToken);
      if (!inbox.ok) throw new Error('Se esperaba 200');
      expect(inbox.body.items).toHaveLength(1);
      expect(inbox.body.items[0].account.email).toBe('ana.perez@taller.ec');
      expect(inbox.body.items[0].requestCount).toBe(20);
    });

    it('[US1-AC7] 30 solicitudes desde orígenes distintos para el mismo correo se aceptan todas en un único ticket con requestCount = 30', () => {
      registerWorkshopA();
      addActiveAgent();
      const agentSession = loginAgent();

      for (let i = 1; i <= 30; i += 1) {
        const res = support.forgotPassword({ email: 'ana.perez@taller.ec' }, `192.168.1.${i}`);
        expect(res).toEqual({ ok: true, status: 202, body: null });
      }

      const inbox = support.listOpenTickets(agentSession.accessToken);
      if (!inbox.ok) throw new Error('Se esperaba 200');
      expect(inbox.body.items).toHaveLength(1);
      expect(inbox.body.items[0].requestCount).toBe(30);
    });

    it('[US1-AC8] correo vacío o inválido responde 400 VALIDATION_ERROR y no consume el límite por origen', () => {
      registerWorkshopA();

      const empty = support.forgotPassword({ email: '   ' }, '10.0.0.99');
      const invalid = support.forgotPassword({ email: 'no-es-correo' }, '10.0.0.99');

      expect(empty.ok).toBe(false);
      expect(invalid.ok).toBe(false);
      if (empty.ok || invalid.ok) return;
      expect(empty.problem.status).toBe(400);
      expect(empty.problem.code).toBe('VALIDATION_ERROR');
      expect(empty.problem.errors).toContainEqual(expect.objectContaining({ field: 'email', code: 'REQUIRED' }));
      expect(invalid.problem.errors).toContainEqual(expect.objectContaining({ field: 'email', code: 'INVALID_EMAIL' }));

      for (let i = 0; i < 20; i += 1) {
        expect(support.forgotPassword({ email: 'ana.perez@taller.ec' }, '10.0.0.99').ok).toBe(true);
      }
    });

    it('[US1-AC9][FR-006] ignora tenantId, userId y ticketId enviados en el body y responde 202', () => {
      const workshopB = registerWorkshopB();
      registerWorkshopA();
      addActiveAgent();
      const agentSession = loginAgent();

      const res = support.forgotPassword({
        email: 'ana.perez@taller.ec',
        tenantId: workshopB.workshop.id,
        userId: workshopB.user.id,
        ticketId: '99999999-9999-4999-8999-999999999999',
      });

      expect(res).toEqual({ ok: true, status: 202, body: null });
      const inbox = support.listOpenTickets(agentSession.accessToken);
      if (!inbox.ok) throw new Error('Se esperaba 200');
      expect(inbox.body.items).toHaveLength(1);
      expect(inbox.body.items[0].account.email).toBe('ana.perez@taller.ec');
      expect(inbox.body.items[0].workshop.name).toBe('Taller Andrade');
    });
  });

  describe('login, sesión y contraseña de soporte (US2)', () => {
    it('[US2-AC3][US2-AC4][R3] login exitoso devuelve token de soporte con aud motorsync-support, sin tenant_id ni role', () => {
      addActiveAgent();

      const res = support.login({ email: `  ${SUPPORT_EMAIL.toUpperCase()} `, password: SUPPORT_PASSWORD });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.status).toBe(200);
      expect(res.body.expiresIn).toBe(900);
      expect(res.body.agent.email).toBe(SUPPORT_EMAIL);
      expect(res.body.agent.mustChangePassword).toBe(false);

      const claims = decodeClaims(res.body.accessToken);
      expect(claims).not.toBeNull();
      expect(claims?.['aud']).toBe(SUPPORT_JWT_AUDIENCE);
      expect(claims?.['sub']).toBe(res.body.agent.id);
      expect(claims?.['sid']).toEqual(expect.any(String));
      expect(claims?.['pwd_change']).toBe(false);
      expect(claims).not.toHaveProperty('tenant_id');
      expect(claims).not.toHaveProperty('role');
    });

    it('[US2-AC3][US2-AC5][FR-009] correo inexistente, contraseña incorrecta, cuenta desactivada o cuenta de taller dan el mismo 401 INVALID_CREDENTIALS', () => {
      registerWorkshopA();
      addActiveAgent();
      support.addSupportAccount({
        name: 'Inactivo Soporte',
        email: 'inactivo.soporte@motorsync.ec',
        password: SUPPORT_PASSWORD,
        status: 'inactive',
      });

      const unknown = support.login({ email: 'nadie@motorsync.ec', password: SUPPORT_PASSWORD });
      const wrongPwd = support.login({ email: SUPPORT_EMAIL, password: 'Otra clave 123' });
      const inactive = support.login({ email: 'inactivo.soporte@motorsync.ec', password: SUPPORT_PASSWORD });
      const workshopCreds = support.login({ email: REGISTER_BODY.email, password: PASSWORD });

      expect(unknown.ok).toBe(false);
      if (unknown.ok || wrongPwd.ok || inactive.ok || workshopCreds.ok) return;

      expect(unknown.problem.status).toBe(401);
      expect(unknown.problem.code).toBe('INVALID_CREDENTIALS');
      expect(wrongPwd.problem).toEqual(unknown.problem);
      expect(inactive.problem).toEqual(unknown.problem);
      expect(workshopCreds.problem).toEqual(unknown.problem);
    });

    it('[US2-AC3][FR-009] bloquea con 429 ACCOUNT_LOCKED tras 5 fallos seguidos (exista o no el correo)', () => {
      addActiveAgent();

      for (let i = 0; i < 5; i += 1) {
        const failRes = support.login({ email: SUPPORT_EMAIL, password: 'incorrecta' });
        expect(failRes.ok).toBe(false);
        if (!failRes.ok) expect(failRes.problem.code).toBe('INVALID_CREDENTIALS');
      }

      const locked = support.login({ email: SUPPORT_EMAIL, password: SUPPORT_PASSWORD });
      expect(locked.ok).toBe(false);
      if (!locked.ok) {
        expect(locked.problem.status).toBe(429);
        expect(locked.problem.code).toBe('ACCOUNT_LOCKED');
      }
    });

    it('[US2-AC1][FR-009] cuenta de soporte con temporal inicial exige cambiarla (403 PASSWORD_CHANGE_REQUIRED en tickets) hasta POST /support/auth/password', () => {
      support.addSupportAccount({
        name: 'Marta Soporte',
        email: 'marta.soporte@motorsync.ec',
        password: TEMPORARY_PASSWORD,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      });

      const loginRes = support.login({ email: 'marta.soporte@motorsync.ec', password: TEMPORARY_PASSWORD });
      expect(loginRes.ok).toBe(true);
      if (!loginRes.ok) return;
      expect(loginRes.body.agent.mustChangePassword).toBe(true);

      const blockedTickets = support.listOpenTickets(loginRes.body.accessToken);
      expect(blockedTickets.ok).toBe(false);
      if (!blockedTickets.ok) {
        expect(blockedTickets.problem.status).toBe(403);
        expect(blockedTickets.problem.code).toBe('PASSWORD_CHANGE_REQUIRED');
      }

      expect(support.me(loginRes.body.accessToken).ok).toBe(true);

      const changed = support.changePassword(loginRes.body.accessToken, {
        currentPassword: TEMPORARY_PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(changed.ok).toBe(true);
      if (!changed.ok) return;
      expect(changed.body.agent.mustChangePassword).toBe(false);
      expect(support.listOpenTickets(changed.body.accessToken).ok).toBe(true);
    });

    it('[US2-AC9] refresh y logout respetan X-Requested-With, logout es idempotente y revoca la sesión', () => {
      addActiveAgent();
      const session = loginAgent();

      expect(support.refresh(false).ok).toBe(false);
      const refreshed = support.refresh(true);
      expect(refreshed.ok).toBe(true);
      if (refreshed.ok) {
        expect(decodeClaims(refreshed.body.accessToken)?.['sid']).toBe(decodeClaims(session.accessToken)?.['sid']);
      }

      expect(support.logout(false).ok).toBe(false);
      expect(support.logout(true)).toEqual({ ok: true, status: 204, body: null });
      expect(support.logout(true)).toEqual({ ok: true, status: 204, body: null });

      const meAfterLogout = support.me(session.accessToken);
      expect(meAfterLogout.ok).toBe(false);
      if (!meAfterLogout.ok) expect(meAfterLogout.problem.code).toBe('SESSION_REVOKED');

      const refreshAfterLogout = support.refresh(true);
      expect(refreshAfterLogout.ok).toBe(false);
      if (!refreshAfterLogout.ok) expect(refreshAfterLogout.problem.code).toBe('SESSION_EXPIRED');
    });
  });

  describe('bandeja, detalle y descarte (US2-AC7, AC8, AC12, AC13)', () => {
    it('[US2-AC7][FR-013] listOpenTickets devuelve solo tickets abiertos ordenados por createdAt ascendente y con las claves exactas del contrato', () => {
      registerWorkshopA();
      registerWorkshopB();
      addActiveAgent();
      const agentSession = loginAgent();

      support.forgotPassword({ email: 'ana.perez@taller.ec' }, '10.1.0.1');
      support.forgotPassword({ email: 'bruno@taller.ec' }, '10.1.0.2');

      const list = support.listOpenTickets(agentSession.accessToken);
      expect(list.ok).toBe(true);
      if (!list.ok) return;

      expect(list.body.items).toHaveLength(2);
      const [first, second] = list.body.items as [TicketSummaryFixture, TicketSummaryFixture];
      expect(first.account.email).toBe('ana.perez@taller.ec');
      expect(second.account.email).toBe('bruno@taller.ec');
      expect(Date.parse(first.createdAt)).toBeLessThanOrEqual(Date.parse(second.createdAt));

      expect(Object.keys(first).sort()).toEqual(
        ['account', 'createdAt', 'id', 'lastRequestedAt', 'number', 'requestCount', 'workshop'].sort(),
      );
      expect(Object.keys(first.account).sort()).toEqual(['email', 'name', 'role', 'status'].sort());
      expect(Object.keys(first.workshop).sort()).toEqual(['name', 'ruc'].sort());
    });

    it('[US2-AC8][US2-AC12][US2-AC13] discardTicket valida reason (REQUIRED, UNKNOWN_FIELD), pasa a discarded, lo saca de la bandeja y rechaza un segundo descarte con 409 TICKET_NOT_OPEN', () => {
      registerWorkshopA();
      addActiveAgent();
      const agentSession = loginAgent();

      support.forgotPassword({ email: 'ana.perez@taller.ec' });
      const inbox = support.listOpenTickets(agentSession.accessToken);
      if (!inbox.ok) throw new Error('Se esperaba 200');
      const ticketId = inbox.body.items[0].id;

      const emptyReason = support.discardTicket(agentSession.accessToken, ticketId, { reason: '   ' });
      expect(emptyReason.ok).toBe(false);
      if (!emptyReason.ok) {
        expect(emptyReason.problem.status).toBe(400);
        expect(emptyReason.problem.errors).toContainEqual(expect.objectContaining({ field: 'reason', code: 'REQUIRED' }));
      }

      const unknownField = support.discardTicket(agentSession.accessToken, ticketId, {
        reason: 'Motivo válido',
        userId: '11111111-1111-4111-8111-111111111111',
      });
      expect(unknownField.ok).toBe(false);
      if (!unknownField.ok) {
        expect(unknownField.problem.status).toBe(400);
        expect(unknownField.problem.errors).toContainEqual(
          expect.objectContaining({ field: 'userId', code: 'UNKNOWN_FIELD' }),
        );
      }

      const discarded = support.discardTicket(agentSession.accessToken, ticketId, {
        reason: '  Tiene otro administrador activo en el taller  ',
      });
      expect(discarded.ok).toBe(true);
      if (!discarded.ok) return;

      const detail: TicketDetailFixture = discarded.body;
      expect(detail.status).toBe('discarded');
      expect(detail.discard).toEqual({
        reason: 'Tiene otro administrador activo en el taller',
        discardedByName: 'Pedro Soporte',
        discardedAt: expect.any(String),
      });

      const afterDiscardInbox = support.listOpenTickets(agentSession.accessToken);
      if (!afterDiscardInbox.ok) throw new Error('Se esperaba 200');
      expect(afterDiscardInbox.body.items).toHaveLength(0);

      const secondDiscard = support.discardTicket(agentSession.accessToken, ticketId, { reason: 'Otro motivo' });
      expect(secondDiscard.ok).toBe(false);
      if (!secondDiscard.ok) {
        expect(secondDiscard.problem.status).toBe(409);
        expect(secondDiscard.problem.code).toBe('TICKET_NOT_OPEN');
      }
    });
  });

  describe('separación y FR-024 (US2-AC5, US2-AC6, FR-024)', () => {
    it('[US2-AC5][FR-008] un token de taller recibe 403 FORBIDDEN en todas las operaciones protegidas de soporte', () => {
      const workshopSession = registerWorkshopA();

      for (const result of [
        support.me(workshopSession.accessToken),
        support.changePassword(workshopSession.accessToken, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        }),
        support.listOpenTickets(workshopSession.accessToken),
        support.getTicket(workshopSession.accessToken, '77777777-7777-4777-8777-777777777777'),
        support.discardTicket(workshopSession.accessToken, '77777777-7777-4777-8777-777777777777', {
          reason: 'Intento desde taller',
        }),
      ]) {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.problem.status).toBe(403);
          expect(result.problem.code).toBe('FORBIDDEN');
        }
      }
    });

    it('[FR-024] rechaza registrar un taller o crear un usuario de taller con un correo de soporte y viceversa', () => {
      addActiveAgent();
      const workshopSession = registerWorkshopA();

      const regWithSupportEmail = auth.register({
        ...REGISTER_BODY,
        ruc: OTHER_VALID_RUC,
        email: ` ${SUPPORT_EMAIL.toUpperCase()} `,
      });
      expect(regWithSupportEmail.ok).toBe(false);
      if (!regWithSupportEmail.ok) {
        expect(regWithSupportEmail.problem.status).toBe(409);
        expect(regWithSupportEmail.problem.code).toBe('REGISTRATION_FAILED');
      }

      const createWithSupportEmail = auth.createUser(workshopSession.accessToken, {
        name: 'Impostor',
        email: SUPPORT_EMAIL,
        role: 'asesor',
        temporaryPassword: TEMPORARY_PASSWORD,
      });
      expect(createWithSupportEmail.ok).toBe(false);
      if (!createWithSupportEmail.ok) {
        expect(createWithSupportEmail.problem.status).toBe(409);
        expect(createWithSupportEmail.problem.code).toBe('EMAIL_UNAVAILABLE');
      }

      expect(() =>
        support.addSupportAccount({
          name: 'Conflicto Taller',
          email: REGISTER_BODY.email,
          password: SUPPORT_PASSWORD,
        }),
      ).toThrow();
    });
  });
});
