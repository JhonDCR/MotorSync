// T064 (003, PR3, US4): consulta de talleres y bitácora en mockApiInterceptor, contra
// specs/003-soporte-plataforma/contracts/openapi.yaml, spec.md (US4) y research R12/R13.
// Archivos nuevos: no modifican las specs del PR1 ni del PR2.
//
// Contrato para el implementer-frontend (T065), archivos core/api/mock-support.store.ts,
// core/api/mock-auth.store.ts y core/api/mock-api.interceptor.ts:
//   - GET /api/v1/support/workshops?q=&page= (Bearer de soporte):
//       - Solo id, name, ruc y createdAt, ordenados por nombre, pageSize fijo 50.
//       - q por RUC (con o sin espacios/guiones, prefijo) o parte del nombre (sin mayúsculas ni tildes);
//         `%` y `_` son literales, no comodines. q de 121 caracteres o page < 1 → 400 VALIDATION_ERROR.
//   - GET /api/v1/support/workshops/{workshopId}/accounts:
//       - workshop (WorkshopSummary) e items con name, email, role, status y hasOpenTicket (activas e inactivas).
//       - taller inexistente o id no uuid → 404 NOT_FOUND, sin registrar en la bitácora.
//       - Cada consulta exitosa agrega EXACTAMENTE una entrada a la bitácora (agente, taller, occurredAt, ip/canal).
//   - GET /api/v1/support/access-log?workshopId=&agentId=&page=:
//       - De la más reciente a la más antigua, pageSize 50, claves exactas
//         id, occurredAt, agent{id,name}, workshop{id,name,ruc}, ip, channel (nunca el correo del agente).
//       - Filtros opcionales y combinables; id inexistente → página vacía; workshopId no uuid → 400.
//       - Consultar la bitácora NO agrega registros. POST/PUT/PATCH/DELETE → 404 (solo lectura).
//   - Token de taller (o sin aud motorsync-support) → 403 FORBIDDEN; sin token → 401 UNAUTHORIZED.
import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders,
  HttpParams,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  OTHER_VALID_RUC,
  PASSWORD,
  REGISTER_BODY,
  type SessionResponseFixture,
} from '../../../testing/auth-fixtures';
import { tokenFor } from '../../../testing/fake-jwt';
import {
  SUPPORT_ACCESS_LOG_URL,
  SUPPORT_EMAIL,
  SUPPORT_LOGIN_URL,
  SUPPORT_PASSWORD,
  SUPPORT_WORKSHOPS_URL,
  type AccessLogResponseFixture,
  type SupportSessionResponseFixture,
  type WorkshopAccountsResponseFixture,
  type WorkshopListResponseFixture,
} from '../../../testing/support-fixtures';
import type { Problem } from './api.models';
import { mockApiInterceptor } from './mock-api.interceptor';
import { MockAuthStore, type MockAccountInput } from './mock-auth.store';
import { MockSupportStore } from './mock-support.store';
import { USE_MOCK_API } from './use-mock-api';

const REGISTER_URL = '/api/v1/auth/register';
const FORGOT_PASSWORD_URL = '/api/v1/auth/forgot-password';
const MARTA_EMAIL = 'marta.soporte@motorsync.ec';
const UNKNOWN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ACCOUNT_KEYS = ['email', 'hasOpenTicket', 'name', 'role', 'status'];
const ACCESS_LOG_KEYS = ['agent', 'channel', 'id', 'ip', 'occurredAt', 'workshop'];

describe('mockApiInterceptor: /support/workshops y /support/access-log (T064)', () => {
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

  /** RUC de sociedad privada (tercer dígito 9) único para las pruebas de paginación. */
  function bulkWorkshopBody(index: number): Record<string, unknown> {
    return {
      workshopName: `Taller Bulk ${String(index).padStart(2, '0')}`,
      ruc: `179${String(1_000_000 + index).padStart(7, '0')}001`,
      name: `Admin Bulk ${index}`,
      email: `bulk${index}@taller.ec`,
      password: PASSWORD,
    };
  }

  async function seedAndLoginSupportAgent(
    name = 'Pedro Soporte',
    email = SUPPORT_EMAIL,
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

  function listWorkshops(token: string, query: { q?: string; page?: number } = {}) {
    let params = new HttpParams();
    if (query.q !== undefined) params = params.set('q', query.q);
    if (query.page !== undefined) params = params.set('page', String(query.page));
    return firstValueFrom(
      http.get<WorkshopListResponseFixture>(SUPPORT_WORKSHOPS_URL, { headers: bearer(token), params }),
    );
  }

  function listWorkshopAccounts(token: string, workshopId: string) {
    return firstValueFrom(
      http.get<WorkshopAccountsResponseFixture>(
        `${SUPPORT_WORKSHOPS_URL}/${encodeURIComponent(workshopId)}/accounts`,
        { headers: bearer(token) },
      ),
    );
  }

  function listAccessLog(
    token: string,
    query: { workshopId?: string; agentId?: string; page?: number } = {},
  ) {
    let params = new HttpParams();
    if (query.workshopId !== undefined) params = params.set('workshopId', query.workshopId);
    if (query.agentId !== undefined) params = params.set('agentId', query.agentId);
    if (query.page !== undefined) params = params.set('page', String(query.page));
    return firstValueFrom(
      http.get<AccessLogResponseFixture>(SUPPORT_ACCESS_LOG_URL, { headers: bearer(token), params }),
    );
  }

  function forgotPassword(email: string) {
    return firstValueFrom(http.post(FORGOT_PASSWORD_URL, { email }, { observe: 'response' }));
  }

  function addAccount(workshopId: string, input: Partial<MockAccountInput> = {}): void {
    authStore.addAccount({
      workshopId,
      name: 'Luis Asesor',
      email: 'luis.asesor@taller.ec',
      role: 'asesor',
      password: PASSWORD,
      status: 'active',
      ...input,
    });
  }

  function keysOf(value: object): string[] {
    return Object.keys(value).sort();
  }

  it('[US4-AC1][US4-AC2] lista talleres con solo id, nombre, RUC y fecha de alta y busca por RUC (con o sin separadores y por prefijo) y por nombre sin mayúsculas ni tildes', async () => {
    const workshopA = await registerWorkshop();
    const workshopB = await registerWorkshop({
      workshopName: 'Taller Benítez',
      ruc: OTHER_VALID_RUC,
      name: 'Bruno Benítez',
      email: 'bruno@taller.ec',
      password: PASSWORD,
    });
    const agent = await seedAndLoginSupportAgent();

    const all = await listWorkshops(agent.accessToken);
    expect(all.page).toBe(1);
    expect(all.pageSize).toBe(50);
    expect(all.total).toBe(3); // taller semilla del mock + A + B
    expect(all.items).toHaveLength(3);
    expect(all.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([workshopA.workshop.id, workshopB.workshop.id]),
    );
    for (const item of all.items) {
      expect(keysOf(item)).toEqual(['createdAt', 'id', 'name', 'ruc']);
    }

    for (const q of ['1790012345001', '179-001-234-5001', '179 001 234 5001', '179001']) {
      const result = await listWorkshops(agent.accessToken, { q });
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(workshopA.workshop.id);
      expect(result.items[0].ruc).toBe(REGISTER_BODY.ruc);
    }

    for (const q of ['andrade', 'ANDRADE', 'andra']) {
      const result = await listWorkshops(agent.accessToken, { q });
      expect(result.items.map((item) => item.id)).toEqual([workshopA.workshop.id]);
    }

    for (const q of ['benitez', 'BENÍTEZ', 'Benítez']) {
      const result = await listWorkshops(agent.accessToken, { q });
      expect(result.items.map((item) => item.id)).toEqual([workshopB.workshop.id]);
    }
  });

  it('[US4-AC2] busca % y _ como caracteres literales, no como comodines', async () => {
    await registerWorkshop();
    const percent = await registerWorkshop({
      workshopName: 'Taller 100% Real',
      ruc: '1791000000001',
      name: 'Percy Porcentaje',
      email: 'percy@taller.ec',
      password: PASSWORD,
    });
    const underscore = await registerWorkshop({
      workshopName: 'Taller_Guion',
      ruc: '1791000001001',
      name: 'Úrsula Guion',
      email: 'ursula@taller.ec',
      password: PASSWORD,
    });
    const agent = await seedAndLoginSupportAgent();

    for (const q of ['%', '100%', '% Real']) {
      const result = await listWorkshops(agent.accessToken, { q });
      expect(result.total).toBe(1);
      expect(result.items.map((item) => item.id)).toEqual([percent.workshop.id]);
    }

    for (const q of ['_', '_Guion', 'Taller_']) {
      const result = await listWorkshops(agent.accessToken, { q });
      expect(result.total).toBe(1);
      expect(result.items.map((item) => item.id)).toEqual([underscore.workshop.id]);
    }
  });

  it('[US4-AC1] devuelve 50 talleres por página, pageSize 50, page y total, ordenados por nombre', async () => {
    await Promise.all(Array.from({ length: 51 }, (_, index) => registerWorkshop(bulkWorkshopBody(index))));
    const agent = await seedAndLoginSupportAgent();

    const first = await listWorkshops(agent.accessToken, { page: 1 });
    expect(first.page).toBe(1);
    expect(first.pageSize).toBe(50);
    expect(first.total).toBe(52); // 51 talleres de la prueba + el taller semilla del mock
    expect(first.items).toHaveLength(50);

    const second = await listWorkshops(agent.accessToken, { page: 2 });
    expect(second.page).toBe(2);
    expect(second.pageSize).toBe(50);
    expect(second.total).toBe(52);
    expect(second.items).toHaveLength(2);
    expect(second.items.map((item) => item.name)).toEqual([
      'Taller Bulk 50',
      'Taller Demo MotorSync',
    ]);

    const firstIds = new Set(first.items.map((item) => item.id));
    expect(second.items.every((item) => !firstIds.has(item.id))).toBe(true);

    const names = [...first.items, ...second.items].map((item) => item.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('[US4-AC1][US4-AC2] rechaza page = 0 y q de 121 caracteres con 400 VALIDATION_ERROR', async () => {
    await registerWorkshop();
    const agent = await seedAndLoginSupportAgent();

    const pageErr = await failure(listWorkshops(agent.accessToken, { page: 0 }));
    expect(pageErr.status).toBe(400);
    expect(problemOf(pageErr).code).toBe('VALIDATION_ERROR');
    expect(fieldCodes(pageErr).some((error) => error.field === 'page')).toBe(true);

    const queryErr = await failure(listWorkshops(agent.accessToken, { q: 'a'.repeat(121) }));
    expect(queryErr.status).toBe(400);
    expect(problemOf(queryErr).code).toBe('VALIDATION_ERROR');
    expect(fieldCodes(queryErr).some((error) => error.field === 'q')).toBe(true);
  });

  it('[US4-AC3][US4-AC7] devuelve las cuentas activas e inactivas del taller con hasOpenTicket, y responde 404 sin bitácora para un taller inexistente o un id no uuid', async () => {
    const workshop = await registerWorkshop();
    addAccount(workshop.workshop.id);
    addAccount(workshop.workshop.id, {
      name: 'Marta Inactiva',
      email: 'marta.inactiva@taller.ec',
      status: 'inactive',
    });
    await forgotPassword('ana.perez@taller.ec');
    const agent = await seedAndLoginSupportAgent();

    const result = await listWorkshopAccounts(agent.accessToken, workshop.workshop.id);
    expect(keysOf(result.workshop)).toEqual(['createdAt', 'id', 'name', 'ruc']);
    expect(result.workshop).toEqual({
      id: workshop.workshop.id,
      name: REGISTER_BODY.workshopName,
      ruc: REGISTER_BODY.ruc,
      createdAt: expect.any(String),
    });
    expect(result.items).toHaveLength(3);

    for (const account of result.items) {
      expect(keysOf(account)).toEqual(ACCOUNT_KEYS);
    }

    const admin = result.items.find((account) => account.email === 'ana.perez@taller.ec');
    expect(admin).toEqual({
      name: 'Ana Pérez',
      email: 'ana.perez@taller.ec',
      role: 'admin',
      status: 'active',
      hasOpenTicket: true,
    });

    const active = result.items.find((account) => account.email === 'luis.asesor@taller.ec');
    expect(active).toEqual({
      name: 'Luis Asesor',
      email: 'luis.asesor@taller.ec',
      role: 'asesor',
      status: 'active',
      hasOpenTicket: false,
    });

    const inactive = result.items.find((account) => account.email === 'marta.inactiva@taller.ec');
    expect(inactive).toEqual({
      name: 'Marta Inactiva',
      email: 'marta.inactiva@taller.ec',
      role: 'asesor',
      status: 'inactive',
      hasOpenTicket: false,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(PASSWORD.trim());
    expect(serialized).not.toContain('mustChangePassword');
    expect(serialized).not.toContain('temporaryPasswordExpiresAt');

    for (const workshopId of [UNKNOWN_ID, 'no-es-uuid']) {
      const err = await failure(listWorkshopAccounts(agent.accessToken, workshopId));
      expect(err.status).toBe(404);
      expect(problemOf(err).code).toBe('NOT_FOUND');
    }

    // US4-AC7: solo la consulta exitosa dejó una entrada en la bitácora.
    const log = await listAccessLog(agent.accessToken);
    expect(log.total).toBe(1);
  });

  it('[US4-AC6] abrir las cuentas agrega exactamente una entrada por consulta a la bitácora (agente, taller, fecha, IP o canal)', async () => {
    const workshop = await registerWorkshop();
    const agent = await seedAndLoginSupportAgent();

    const before = await listAccessLog(agent.accessToken);
    expect(before.total).toBe(0);

    const startedAt = Date.now();
    await listWorkshopAccounts(agent.accessToken, workshop.workshop.id);

    const after = await listAccessLog(agent.accessToken);
    expect(after.page).toBe(1);
    expect(after.pageSize).toBe(50);
    expect(after.total).toBe(1);
    expect(after.items).toHaveLength(1);

    const entry = after.items[0];
    expect(keysOf(entry)).toEqual(ACCESS_LOG_KEYS);
    expect(keysOf(entry.agent)).toEqual(['id', 'name']);
    expect(keysOf(entry.workshop)).toEqual(['id', 'name', 'ruc']);
    expect(entry.agent).toEqual({ id: agent.agent.id, name: 'Pedro Soporte' });
    expect(entry.workshop).toEqual({
      id: workshop.workshop.id,
      name: REGISTER_BODY.workshopName,
      ruc: REGISTER_BODY.ruc,
    });
    expect(new Date(entry.occurredAt).toISOString()).toBe(entry.occurredAt);
    expect(Date.parse(entry.occurredAt)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(entry.occurredAt)).toBeLessThanOrEqual(Date.now());
    expect(entry.channel).toBe('support_panel');
    expect(entry.ip === null || typeof entry.ip === 'string').toBe(true);
    expect(JSON.stringify(entry)).not.toContain(SUPPORT_EMAIL);

    // Cada consulta nueva agrega una entrada; consultar la bitácora no agrega ninguna (US4-AC9).
    await listWorkshopAccounts(agent.accessToken, workshop.workshop.id);
    const twice = await listAccessLog(agent.accessToken);
    expect(twice.total).toBe(2);
    expect((await listAccessLog(agent.accessToken)).total).toBe(2);
  });

  it('[US4-AC8] ordena la bitácora de la más reciente a la más antigua, expone las claves exactas y combina los filtros workshopId y agentId', async () => {
    const workshopA = await registerWorkshop();
    const workshopB = await registerWorkshop({
      workshopName: 'Taller Benítez',
      ruc: OTHER_VALID_RUC,
      name: 'Bruno Benítez',
      email: 'bruno@taller.ec',
      password: PASSWORD,
    });
    const pedro = await seedAndLoginSupportAgent();
    const marta = await seedAndLoginSupportAgent('Marta Soporte', MARTA_EMAIL);

    await listWorkshopAccounts(pedro.accessToken, workshopA.workshop.id);
    await listWorkshopAccounts(marta.accessToken, workshopB.workshop.id);
    await listWorkshopAccounts(pedro.accessToken, workshopB.workshop.id);

    const all = await listAccessLog(pedro.accessToken);
    expect(all.page).toBe(1);
    expect(all.pageSize).toBe(50);
    expect(all.total).toBe(3);
    expect(all.items).toHaveLength(3);

    // Más reciente primero: Pedro/B, Marta/B, Pedro/A.
    expect(all.items.map((entry) => [entry.agent.name, entry.workshop.id])).toEqual([
      ['Pedro Soporte', workshopB.workshop.id],
      ['Marta Soporte', workshopB.workshop.id],
      ['Pedro Soporte', workshopA.workshop.id],
    ]);
    const times = all.items.map((entry) => Date.parse(entry.occurredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    for (const entry of all.items) {
      expect(keysOf(entry)).toEqual(ACCESS_LOG_KEYS);
      expect(keysOf(entry.agent)).toEqual(['id', 'name']);
      expect(keysOf(entry.workshop)).toEqual(['id', 'name', 'ruc']);
    }
    const serialized = JSON.stringify(all.items);
    expect(serialized).not.toContain(SUPPORT_EMAIL);
    expect(serialized).not.toContain(MARTA_EMAIL);

    const byWorkshopA = await listAccessLog(pedro.accessToken, {
      workshopId: workshopA.workshop.id,
    });
    expect(byWorkshopA.total).toBe(1);
    expect(byWorkshopA.items.map((entry) => entry.agent.name)).toEqual(['Pedro Soporte']);
    expect(byWorkshopA.pageSize).toBe(50);

    const byMarta = await listAccessLog(pedro.accessToken, { agentId: marta.agent.id });
    expect(byMarta.total).toBe(1);
    expect(byMarta.items.map((entry) => entry.workshop.id)).toEqual([workshopB.workshop.id]);

    const combined = await listAccessLog(pedro.accessToken, {
      workshopId: workshopB.workshop.id,
      agentId: marta.agent.id,
    });
    expect(combined.total).toBe(1);
    expect(combined.items[0].agent.name).toBe('Marta Soporte');

    const combinedEmpty = await listAccessLog(pedro.accessToken, {
      workshopId: workshopA.workshop.id,
      agentId: marta.agent.id,
    });
    expect(combinedEmpty.items).toEqual([]);
    expect(combinedEmpty.total).toBe(0);

    const unknownWorkshop = await listAccessLog(pedro.accessToken, { workshopId: UNKNOWN_ID });
    expect(unknownWorkshop.items).toEqual([]);
    expect(unknownWorkshop.total).toBe(0);

    const unknownAgent = await listAccessLog(pedro.accessToken, { agentId: UNKNOWN_ID });
    expect(unknownAgent.items).toEqual([]);
    expect(unknownAgent.total).toBe(0);
  });

  it('[US4-AC8] pagina la bitácora de 50 en 50: 51 registros dejan 1 en la página 2', async () => {
    const workshop = await registerWorkshop();
    const agent = await seedAndLoginSupportAgent();

    await Promise.all(
      Array.from({ length: 51 }, () => listWorkshopAccounts(agent.accessToken, workshop.workshop.id)),
    );

    const first = await listAccessLog(agent.accessToken, { page: 1 });
    expect(first.page).toBe(1);
    expect(first.pageSize).toBe(50);
    expect(first.total).toBe(51);
    expect(first.items).toHaveLength(50);

    const second = await listAccessLog(agent.accessToken, { page: 2 });
    expect(second.page).toBe(2);
    expect(second.pageSize).toBe(50);
    expect(second.total).toBe(51);
    expect(second.items).toHaveLength(1);

    const firstIds = new Set(first.items.map((entry) => entry.id));
    expect(firstIds.has(second.items[0].id)).toBe(false);

    const times = first.items.map((entry) => Date.parse(entry.occurredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('[US4-AC8] rechaza un workshopId que no es uuid con 400 VALIDATION_ERROR', async () => {
    await registerWorkshop();
    const agent = await seedAndLoginSupportAgent();

    const err = await failure(listAccessLog(agent.accessToken, { workshopId: 'no-es-uuid' }));
    expect(err.status).toBe(400);
    expect(problemOf(err).code).toBe('VALIDATION_ERROR');
    expect(fieldCodes(err).some((error) => error.field === 'workshopId')).toBe(true);
  });

  it('[US4-AC9] consultar la bitácora no agrega registros y ninguna escritura (POST/PUT/PATCH/DELETE) está permitida', async () => {
    const workshop = await registerWorkshop();
    const agent = await seedAndLoginSupportAgent();
    await listWorkshopAccounts(agent.accessToken, workshop.workshop.id);

    const firstRead = await listAccessLog(agent.accessToken);
    expect(firstRead.total).toBe(1);
    const entryId = firstRead.items[0].id;

    expect((await listAccessLog(agent.accessToken)).total).toBe(1);
    expect((await listAccessLog(agent.accessToken, { page: 1 })).total).toBe(1);

    const urls = [SUPPORT_ACCESS_LOG_URL, `${SUPPORT_ACCESS_LOG_URL}/${entryId}`];
    for (const url of urls) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const err = await failure(
          firstValueFrom(
            http.request(method, url, {
              headers: bearer(agent.accessToken),
              body: method === 'DELETE' ? null : {},
            }),
          ),
        );
        expect(err.status).toBe(404);
        expect(problemOf(err).code).toBe('NOT_FOUND');
      }
    }

    expect((await listAccessLog(agent.accessToken)).total).toBe(1);
  });

  it('[US2-AC5][FR-025] un token de taller recibe 403 FORBIDDEN y una petición sin token recibe 401 UNAUTHORIZED', async () => {
    const workshop = await registerWorkshop();

    for (const token of [workshop.accessToken, tokenFor('admin'), tokenFor('asesor')]) {
      for (const request of [
        listWorkshops(token),
        listAccessLog(token),
        listWorkshopAccounts(token, workshop.workshop.id),
      ]) {
        const err = await failure(request);
        expect(err.status).toBe(403);
        expect(problemOf(err).code).toBe('FORBIDDEN');
      }
    }

    for (const request of [
      firstValueFrom(http.get(SUPPORT_WORKSHOPS_URL)),
      firstValueFrom(http.get(SUPPORT_ACCESS_LOG_URL)),
    ]) {
      const err = await failure(request);
      expect(err.status).toBe(401);
      expect(problemOf(err).code).toBe('UNAUTHORIZED');
    }
  });
});
