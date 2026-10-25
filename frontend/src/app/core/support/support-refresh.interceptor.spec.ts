// T037 (003, PR1, US2): renovación de la sesión de soporte en el frontend (research R4, R5, R11, R13).
//
// Contrato para el implementer-frontend (T038), archivo core/support/support-refresh.interceptor.ts:
//   export const supportRefreshInterceptor: HttpInterceptorFn
//   Se registra en app.config.ts junto a authRefreshInterceptor y antes de mockApiInterceptor.
//   Comportamiento (solo actúa sobre peticiones a `/api/v1/support/**` que NO sean `/api/v1/support/auth/*`):
//   - 401 TOKEN_EXPIRED en `/api/v1/support/**` (excepto `/api/v1/support/auth/*`):
//       hace UN solo POST /api/v1/support/auth/refresh compartido por todas las peticiones de soporte que fallen
//       mientras está en curso (single-flight). Al 200 llama a SupportSessionStore.setSession(respuesta) y reintenta
//       cada petición original con `Authorization: Bearer <nuevo support token>`.
//   - El refresh responde 409 REFRESH_CONFLICT: repite el refresh UNA vez; si el segundo también falla, la petición
//       original falla y no hay un tercer refresh.
//   - 401 SESSION_EXPIRED (en el refresh o directo) → SupportSessionStore.clear() y navega a /support/login?reason=expired.
//   - 401 SESSION_REVOKED (en el refresh o directo) → SupportSessionStore.clear() y navega a /support/login?reason=revoked.
//   - 403 PASSWORD_CHANGE_REQUIRED → navega a /support/change-password; la petición falla; no borra la sesión de soporte.
//   - Las rutas `/api/v1/support/auth/*` (login, refresh, logout, password, me) y cualquier ruta fuera de
//       `/api/v1/support/**` pasan sin tocar.
//   - NINGÚN temporizador en segundo plano.
import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  problemFlush,
  REFRESH_URL,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
} from '../../../testing/auth-fixtures';
import {
  OTHER_TICKET_ID,
  SUPPORT_LOGIN_URL,
  SUPPORT_PASSWORD_URL,
  SUPPORT_REFRESH_URL,
  SUPPORT_TICKETS_URL,
  SUPPORT_TOKEN_STORAGE_KEY,
  supportProblem,
  supportSessionResponse,
  supportSessionToken,
  TICKET_ID,
} from '../../../testing/support-fixtures';
import { AUTH_TOKEN_STORAGE_KEY, authTokenInterceptor } from '../auth/auth-token.interceptor';
import { supportRefreshInterceptor } from './support-refresh.interceptor';
import { SupportSessionStore } from './support-session.store';

@Component({ template: '' })
class StubPage {}

const OLD_SUPPORT_TOKEN = supportSessionToken('Viejo', false, { jti: 'viejo' });
const NEW_SUPPORT_TOKEN = supportSessionToken('Nuevo', false, { jti: 'nuevo' });
const NEWER_SUPPORT_TOKEN = supportSessionToken('MasNuevo', false, { jti: 'mas-nuevo' });

const TICKET_DETAIL_URL = `${SUPPORT_TICKETS_URL}/${TICKET_ID}`;
const TICKET_DISCARD_URL = `${SUPPORT_TICKETS_URL}/${OTHER_TICKET_ID}/discard`;
const VEHICLES_URL = '/api/v1/vehicles/search?q=PB';

function supportSessionWithToken(token: string) {
  return {
    ...supportSessionResponse(),
    accessToken: token,
  };
}

describe('supportRefreshInterceptor (T037)', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let store: SupportSessionStore;
  let router: Router;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'support/login', component: StubPage },
          { path: 'support/change-password', component: StubPage },
          { path: '**', component: StubPage },
        ]),
        provideHttpClient(withInterceptors([authTokenInterceptor, supportRefreshInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    store = TestBed.inject(SupportSessionStore);
    router = TestBed.inject(Router);
    await router.navigateByUrl('/support');
    store.setSession(supportSessionWithToken(OLD_SUPPORT_TOKEN));
  });

  afterEach(() => {
    vi.useRealTimers();
    httpMock.verify();
    localStorage.clear();
  });

  function next(url: string): Promise<TestRequest> {
    return vi.waitFor(() => httpMock.expectOne(url));
  }

  function bearer(req: TestRequest): string | null {
    return req.request.headers.get('Authorization');
  }

  function fail(req: TestRequest, status: number, code: string): void {
    req.flush(supportProblem(status, code), problemFlush(status));
  }

  function path(): string {
    return router.url.split('?')[0];
  }

  function reason(): unknown {
    return router.parseUrl(router.url).queryParams['reason'];
  }

  interface Outcome {
    value?: unknown;
    error?: unknown;
  }

  function call(method: 'GET' | 'POST', url: string, body?: unknown): Outcome {
    const outcome: Outcome = {};
    const request = method === 'GET' ? http.get(url) : http.post(url, body);
    request.subscribe({
      next: (value) => (outcome.value = value),
      error: (error: unknown) => (outcome.error = error),
    });
    return outcome;
  }

  describe('401 TOKEN_EXPIRED en /api/v1/support/**: refresh único y reintento', () => {
    it('[US2-AC3] tres peticiones a /api/v1/support/** que fallan a la vez provocan UN solo POST /api/v1/support/auth/refresh y se reintentan con el token nuevo', async () => {
      const list = call('GET', SUPPORT_TICKETS_URL);
      const detail = call('GET', TICKET_DETAIL_URL);
      const discard = call('POST', TICKET_DISCARD_URL, { reason: 'Duplicado' });

      const first = [
        await next(SUPPORT_TICKETS_URL),
        await next(TICKET_DETAIL_URL),
        await next(TICKET_DISCARD_URL),
      ];
      for (const req of first) {
        expect(bearer(req)).toBe(`Bearer ${OLD_SUPPORT_TOKEN}`);
        fail(req, 401, 'TOKEN_EXPIRED');
      }

      const refresh = await next(SUPPORT_REFRESH_URL);
      expect(httpMock.match(SUPPORT_REFRESH_URL)).toHaveLength(0);
      expect(httpMock.match(REFRESH_URL)).toHaveLength(0);
      expect(refresh.request.method).toBe('POST');
      expect(refresh.request.withCredentials).toBe(true);
      expect(refresh.request.headers.get(REQUESTED_WITH_HEADER)).toBe(REQUESTED_WITH_VALUE);
      refresh.flush(supportSessionWithToken(NEW_SUPPORT_TOKEN));

      const retriedList = await next(SUPPORT_TICKETS_URL);
      const retriedDetail = await next(TICKET_DETAIL_URL);
      const retriedDiscard = await next(TICKET_DISCARD_URL);
      expect(bearer(retriedList)).toBe(`Bearer ${NEW_SUPPORT_TOKEN}`);
      expect(bearer(retriedDetail)).toBe(`Bearer ${NEW_SUPPORT_TOKEN}`);
      expect(bearer(retriedDiscard)).toBe(`Bearer ${NEW_SUPPORT_TOKEN}`);
      expect(retriedDiscard.request.body).toEqual({ reason: 'Duplicado' });

      retriedList.flush({ items: [] });
      retriedDetail.flush({ id: TICKET_ID });
      retriedDiscard.flush({ id: OTHER_TICKET_ID, status: 'discarded' });

      expect(list).toEqual({ value: { items: [] } });
      expect(detail).toEqual({ value: { id: TICKET_ID } });
      expect(discard).toEqual({ value: { id: OTHER_TICKET_ID, status: 'discarded' } });
      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBe(NEW_SUPPORT_TOKEN);
    });

    it('[US2-AC3] terminado un refresh de soporte, un TOKEN_EXPIRED posterior abre un refresh nuevo', async () => {
      call('GET', SUPPORT_TICKETS_URL);
      fail(await next(SUPPORT_TICKETS_URL), 401, 'TOKEN_EXPIRED');
      (await next(SUPPORT_REFRESH_URL)).flush(supportSessionWithToken(NEW_SUPPORT_TOKEN));
      (await next(SUPPORT_TICKETS_URL)).flush({ items: [] });

      const later = call('GET', TICKET_DETAIL_URL);
      const req = await next(TICKET_DETAIL_URL);
      expect(bearer(req)).toBe(`Bearer ${NEW_SUPPORT_TOKEN}`);
      fail(req, 401, 'TOKEN_EXPIRED');
      (await next(SUPPORT_REFRESH_URL)).flush(supportSessionWithToken(NEWER_SUPPORT_TOKEN));
      const retried = await next(TICKET_DETAIL_URL);
      expect(bearer(retried)).toBe(`Bearer ${NEWER_SUPPORT_TOKEN}`);
      retried.flush({ id: TICKET_ID });

      expect(later.value).toEqual({ id: TICKET_ID });
    });
  });

  describe('409 REFRESH_CONFLICT en /api/v1/support/auth/refresh', () => {
    it('[US2-AC3][R5] repite el refresh de soporte una vez y reintenta la petición con el token obtenido', async () => {
      const outcome = call('GET', SUPPORT_TICKETS_URL);
      fail(await next(SUPPORT_TICKETS_URL), 401, 'TOKEN_EXPIRED');

      fail(await next(SUPPORT_REFRESH_URL), 409, 'REFRESH_CONFLICT');
      const second = await next(SUPPORT_REFRESH_URL);
      second.flush(supportSessionWithToken(NEW_SUPPORT_TOKEN));

      const retried = await next(SUPPORT_TICKETS_URL);
      expect(bearer(retried)).toBe(`Bearer ${NEW_SUPPORT_TOKEN}`);
      retried.flush({ items: [] });

      expect(outcome).toEqual({ value: { items: [] } });
    });

    it('[R5] si el segundo refresh de soporte también da REFRESH_CONFLICT, no hay un tercero y la petición falla', async () => {
      const outcome = call('GET', SUPPORT_TICKETS_URL);
      fail(await next(SUPPORT_TICKETS_URL), 401, 'TOKEN_EXPIRED');
      fail(await next(SUPPORT_REFRESH_URL), 409, 'REFRESH_CONFLICT');
      fail(await next(SUPPORT_REFRESH_URL), 409, 'REFRESH_CONFLICT');

      await vi.waitFor(() => expect(outcome.error).toBeDefined());
      expect(httpMock.match(SUPPORT_REFRESH_URL)).toHaveLength(0);
      expect(httpMock.match(SUPPORT_TICKETS_URL)).toHaveLength(0);
    });
  });

  describe('sesión de soporte terminada', () => {
    it('[US2-AC3] refresh con 401 SESSION_EXPIRED: limpia SupportSessionStore (sin tocar motorsync.token) y navega a /support/login?reason=expired', async () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token.taller.intacto');
      const outcome = call('GET', SUPPORT_TICKETS_URL);
      fail(await next(SUPPORT_TICKETS_URL), 401, 'TOKEN_EXPIRED');
      fail(await next(SUPPORT_REFRESH_URL), 401, 'SESSION_EXPIRED');

      await vi.waitFor(() => expect(path()).toBe('/support/login'));
      expect(reason()).toBe('expired');
      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('token.taller.intacto');
      expect(store.isSignedIn()).toBe(false);
      expect(outcome.error).toBeDefined();
    });

    it('[US2-AC3] refresh con 401 SESSION_REVOKED: limpia SupportSessionStore y navega a /support/login?reason=revoked', async () => {
      const outcome = call('GET', SUPPORT_TICKETS_URL);
      fail(await next(SUPPORT_TICKETS_URL), 401, 'TOKEN_EXPIRED');
      fail(await next(SUPPORT_REFRESH_URL), 401, 'SESSION_REVOKED');

      await vi.waitFor(() => expect(path()).toBe('/support/login'));
      expect(reason()).toBe('revoked');
      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
      expect(store.isSignedIn()).toBe(false);
      expect(outcome.error).toBeDefined();
    });

    it('[US2-AC3] 401 SESSION_EXPIRED o SESSION_REVOKED directo en /api/v1/support/** navega a /support/login sin llamar al refresh', async () => {
      const outcome = call('GET', SUPPORT_TICKETS_URL);
      fail(await next(SUPPORT_TICKETS_URL), 401, 'SESSION_REVOKED');

      await vi.waitFor(() => expect(path()).toBe('/support/login'));
      expect(reason()).toBe('revoked');
      expect(store.isSignedIn()).toBe(false);
      expect(outcome.error).toBeDefined();
      httpMock.expectNone(SUPPORT_REFRESH_URL);
    });
  });

  describe('403 PASSWORD_CHANGE_REQUIRED en /api/v1/support/**', () => {
    it('[US2-AC4] navega a /support/change-password, la petición falla y conserva la sesión de soporte', async () => {
      const outcome = call('GET', SUPPORT_TICKETS_URL);
      fail(await next(SUPPORT_TICKETS_URL), 403, 'PASSWORD_CHANGE_REQUIRED');

      await vi.waitFor(() => expect(path()).toBe('/support/change-password'));
      expect(outcome.error).toBeInstanceOf(HttpErrorResponse);
      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBe(OLD_SUPPORT_TOKEN);
      httpMock.expectNone(SUPPORT_REFRESH_URL);
    });
  });

  describe('rutas ignoradas por supportRefreshInterceptor', () => {
    it('[US2-AC2] /api/v1/support/auth/* (login, password, refresh) pasa sin tocar', async () => {
      const loginOutcome = call('POST', SUPPORT_LOGIN_URL, { email: 'a@motorsync.ec', password: 'x' });
      fail(await next(SUPPORT_LOGIN_URL), 401, 'INVALID_CREDENTIALS');
      expect((loginOutcome.error as HttpErrorResponse).status).toBe(401);

      const pwdOutcome = call('POST', SUPPORT_PASSWORD_URL, { currentPassword: 'a', newPassword: 'b' });
      fail(await next(SUPPORT_PASSWORD_URL), 401, 'TEMPORARY_PASSWORD_EXPIRED');
      expect((pwdOutcome.error as HttpErrorResponse).status).toBe(401);

      httpMock.expectNone(SUPPORT_REFRESH_URL);
      expect(router.url).toBe('/support');
    });

    it('[US2-AC5][FR-008] un 401 en una ruta de taller (/api/v1/vehicles/**) es ignorado por supportRefreshInterceptor', async () => {
      const outcome = call('GET', VEHICLES_URL);
      fail(await next(VEHICLES_URL), 401, 'TOKEN_EXPIRED');

      expect(outcome.error).toBeInstanceOf(HttpErrorResponse);
      httpMock.expectNone(SUPPORT_REFRESH_URL);
      expect(router.url).toBe('/support');
      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBe(OLD_SUPPORT_TOKEN);
    });
  });
});
