// T041 (002, PR2, US3): renovación de la sesión en el frontend (research R5, R11, R13).
//
// Contrato para el implementer-frontend (T042), archivo core/auth/auth-refresh.interceptor.ts:
//   export const authRefreshInterceptor: HttpInterceptorFn
//   Se registra en app.config.ts DESPUÉS de authTokenInterceptor y ANTES de mockApiInterceptor:
//     withInterceptors([authTokenInterceptor, authRefreshInterceptor, mockApiInterceptor])
//   Comportamiento (solo reacciona a respuestas; nunca actúa por su cuenta):
//   - 401 TOKEN_EXPIRED en cualquier petición que no sea /api/v1/auth/*:
//       hace UN solo POST /api/v1/auth/refresh compartido por todas las peticiones que fallen mientras está en curso
//       (single-flight). Al 200 llama a SessionStore.setSession(respuesta) (token nuevo en 'motorsync.token' y rol
//       vigente) y reintenta cada petición original (mismo método, url y cuerpo) con `Authorization: Bearer <nuevo>`.
//       El que llamó recibe la respuesta del reintento, nunca el 401. Terminado ese refresh, un TOKEN_EXPIRED
//       posterior abre un refresh nuevo (no se cachea para siempre).
//   - El refresh responde 409 REFRESH_CONFLICT: repite el refresh UNA vez (R5: dos pestañas a la vez). Si el
//       segundo también falla, la petición original falla y no hay un tercer refresh.
//   - El refresh responde 401 SESSION_EXPIRED → SessionStore.clear() y navega a /login?reason=expired.
//       401 SESSION_REVOKED (incluida la reutilización de un token rotado) → clear() y /login?reason=revoked.
//       La petición original falla (el componente no recibe datos) y no se reintenta.
//   - 401 SESSION_EXPIRED o SESSION_REVOKED directamente en una petición (sin pasar por el refresh): lo mismo, sin
//       llamar al refresh.
//   - 403 PASSWORD_CHANGE_REQUIRED → navega a /change-password; la petición falla; no borra la sesión.
//   - Las rutas /api/v1/auth/* (login, register, refresh, logout, password, me) pasan sin tocar: un 401
//       INVALID_CREDENTIALS del login o TEMPORARY_PASSWORD_EXPIRED del cambio de contraseña llegan tal cual a la
//       pantalla, sin refresh ni navegación.
//   - El refresh usa AuthApiService.refresh() (o HttpClient) con `withCredentials: true` y
//       `X-Requested-With: motorsync`; así también lo atiende el mock (USE_MOCK_API).
//   - NINGÚN temporizador: nunca refresca en segundo plano ni "antes de que venza" (US3-AC2, R5).
//   Las navegaciones a /login pueden llevar más query params (por ejemplo returnUrl), pero `reason` es exacto.
import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  authProblem,
  LOGIN_URL,
  PASSWORD_URL,
  problemFlush,
  REFRESH_URL,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  sessionResponseWithToken,
} from '../../../testing/auth-fixtures';
import { fakeJwt, TENANT_A } from '../../../testing/fake-jwt';
import { authRefreshInterceptor } from './auth-refresh.interceptor';
import { AUTH_TOKEN_STORAGE_KEY, authTokenInterceptor } from './auth-token.interceptor';
import { SessionStore } from './session.store';

@Component({ template: '' })
class StubPage {}

function accessToken(label: string): string {
  return fakeJwt({ sub: label, tenant_id: TENANT_A, role: 'asesor', name: label, exp: 4102444800 }, label);
}

const OLD_TOKEN = accessToken('viejo');
const NEW_TOKEN = accessToken('nuevo');
const NEWER_TOKEN = accessToken('mas-nuevo');

const VEHICLES_URL = '/api/v1/vehicles/search?q=PB';
const CLIENTS_URL = '/api/v1/clients/search?q=an';
const CLIENT_CREATE_URL = '/api/v1/clients';

describe('authRefreshInterceptor (T041)', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let store: SessionStore;
  let router: Router;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'login', component: StubPage },
          { path: 'change-password', component: StubPage },
          { path: '**', component: StubPage },
        ]),
        provideHttpClient(withInterceptors([authTokenInterceptor, authRefreshInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    store = TestBed.inject(SessionStore);
    router = TestBed.inject(Router);
    await router.navigateByUrl('/clients');
    store.setSession(sessionResponseWithToken(OLD_TOKEN, { role: 'admin', name: 'Ana Pérez' }));
  });

  afterEach(() => {
    vi.useRealTimers();
    httpMock.verify();
    localStorage.clear();
  });

  // --- utilidades ---

  /** La siguiente petición a `url` (tolera que el interceptor la emita en un microtask). */
  function next(url: string): Promise<TestRequest> {
    return vi.waitFor(() => httpMock.expectOne(url));
  }

  function bearer(req: TestRequest): string | null {
    return req.request.headers.get('Authorization');
  }

  function fail(req: TestRequest, status: number, code: string): void {
    req.flush(authProblem(status, code), problemFlush(status));
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
    request.subscribe({ next: (value) => (outcome.value = value), error: (error: unknown) => (outcome.error = error) });
    return outcome;
  }

  describe('401 TOKEN_EXPIRED: refresh único y reintento', () => {
    it('[US3-AC1] tres peticiones que fallan a la vez provocan UN solo refresh y se reintentan con el token nuevo', async () => {
      const vehicles = call('GET', VEHICLES_URL);
      const clients = call('GET', CLIENTS_URL);
      const created = call('POST', CLIENT_CREATE_URL, { name: 'Cliente Uno' });

      const first = [await next(VEHICLES_URL), await next(CLIENTS_URL), await next(CLIENT_CREATE_URL)];
      for (const req of first) {
        expect(bearer(req)).toBe(`Bearer ${OLD_TOKEN}`);
        fail(req, 401, 'TOKEN_EXPIRED');
      }

      const refresh = await next(REFRESH_URL);
      expect(httpMock.match(REFRESH_URL)).toHaveLength(0);
      refresh.flush(sessionResponseWithToken(NEW_TOKEN, { role: 'asesor', name: 'Ana Pérez' }));

      const retriedVehicles = await next(VEHICLES_URL);
      const retriedClients = await next(CLIENTS_URL);
      const retriedCreate = await next(CLIENT_CREATE_URL);
      expect(bearer(retriedVehicles)).toBe(`Bearer ${NEW_TOKEN}`);
      expect(bearer(retriedClients)).toBe(`Bearer ${NEW_TOKEN}`);
      expect(bearer(retriedCreate)).toBe(`Bearer ${NEW_TOKEN}`);
      expect(retriedCreate.request.method).toBe('POST');
      expect(retriedCreate.request.body).toEqual({ name: 'Cliente Uno' });

      retriedVehicles.flush({ items: ['v'], hasMore: false });
      retriedClients.flush({ items: ['c'], hasMore: false });
      retriedCreate.flush({ id: 'nuevo' }, { status: 201, statusText: 'Created' });

      expect(vehicles).toEqual({ value: { items: ['v'], hasMore: false } });
      expect(clients).toEqual({ value: { items: ['c'], hasMore: false } });
      expect(created).toEqual({ value: { id: 'nuevo' } });
      expect(httpMock.match(REFRESH_URL)).toHaveLength(0);
    });

    it('[US3-AC1] guarda el token nuevo y toma el rol vigente de la respuesta del refresh (FR-014)', async () => {
      call('GET', VEHICLES_URL);
      fail(await next(VEHICLES_URL), 401, 'TOKEN_EXPIRED');
      (await next(REFRESH_URL)).flush(sessionResponseWithToken(NEW_TOKEN, { role: 'asesor', name: 'Ana Pérez' }));
      (await next(VEHICLES_URL)).flush({ items: [], hasMore: false });

      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(NEW_TOKEN);
      expect(store.user()?.role).toBe('asesor');
    });

    it('[R11] el refresh lleva withCredentials y X-Requested-With: motorsync', async () => {
      call('GET', VEHICLES_URL);
      fail(await next(VEHICLES_URL), 401, 'TOKEN_EXPIRED');

      const refresh = await next(REFRESH_URL);
      expect(refresh.request.method).toBe('POST');
      expect(refresh.request.withCredentials).toBe(true);
      expect(refresh.request.headers.get(REQUESTED_WITH_HEADER)).toBe(REQUESTED_WITH_VALUE);
      refresh.flush(sessionResponseWithToken(NEW_TOKEN));
      (await next(VEHICLES_URL)).flush({ items: [], hasMore: false });
    });

    it('[R5] terminado un refresh, un TOKEN_EXPIRED posterior abre un refresh nuevo', async () => {
      call('GET', VEHICLES_URL);
      fail(await next(VEHICLES_URL), 401, 'TOKEN_EXPIRED');
      (await next(REFRESH_URL)).flush(sessionResponseWithToken(NEW_TOKEN));
      (await next(VEHICLES_URL)).flush({ items: [], hasMore: false });

      const later = call('GET', CLIENTS_URL);
      const req = await next(CLIENTS_URL);
      expect(bearer(req)).toBe(`Bearer ${NEW_TOKEN}`);
      fail(req, 401, 'TOKEN_EXPIRED');
      (await next(REFRESH_URL)).flush(sessionResponseWithToken(NEWER_TOKEN));
      const retried = await next(CLIENTS_URL);
      expect(bearer(retried)).toBe(`Bearer ${NEWER_TOKEN}`);
      retried.flush({ items: [], hasMore: false });

      expect(later.value).toEqual({ items: [], hasMore: false });
    });
  });

  describe('409 REFRESH_CONFLICT', () => {
    it('[US3-AC4][R5] repite el refresh una vez y reintenta la petición con el token obtenido', async () => {
      const outcome = call('GET', VEHICLES_URL);
      fail(await next(VEHICLES_URL), 401, 'TOKEN_EXPIRED');

      fail(await next(REFRESH_URL), 409, 'REFRESH_CONFLICT');
      const second = await next(REFRESH_URL);
      expect(second.request.headers.get(REQUESTED_WITH_HEADER)).toBe(REQUESTED_WITH_VALUE);
      second.flush(sessionResponseWithToken(NEW_TOKEN));

      const retried = await next(VEHICLES_URL);
      expect(bearer(retried)).toBe(`Bearer ${NEW_TOKEN}`);
      retried.flush({ items: [], hasMore: false });

      expect(outcome).toEqual({ value: { items: [], hasMore: false } });
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(NEW_TOKEN);
    });

    it('[R5] si el segundo refresh también da REFRESH_CONFLICT, no hay un tercero y la petición falla', async () => {
      const outcome = call('GET', VEHICLES_URL);
      fail(await next(VEHICLES_URL), 401, 'TOKEN_EXPIRED');
      fail(await next(REFRESH_URL), 409, 'REFRESH_CONFLICT');
      fail(await next(REFRESH_URL), 409, 'REFRESH_CONFLICT');

      await vi.waitFor(() => expect(outcome.error).toBeDefined());
      expect(httpMock.match(REFRESH_URL)).toHaveLength(0);
      expect(httpMock.match(VEHICLES_URL)).toHaveLength(0);
      expect(outcome.value).toBeUndefined();
    });
  });

  describe('sesión terminada', () => {
    it('[US3-AC2] refresh con 401 SESSION_EXPIRED: limpia la sesión y va a /login?reason=expired sin reintentar', async () => {
      const outcome = call('GET', VEHICLES_URL);
      fail(await next(VEHICLES_URL), 401, 'TOKEN_EXPIRED');
      fail(await next(REFRESH_URL), 401, 'SESSION_EXPIRED');

      await vi.waitFor(() => expect(path()).toBe('/login'));
      expect(reason()).toBe('expired');
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
      expect(store.isSignedIn()).toBe(false);
      expect(outcome.value).toBeUndefined();
      expect(outcome.error).toBeDefined();
      expect(httpMock.match(VEHICLES_URL)).toHaveLength(0);
    });

    it('[US3-AC4] refresh con 401 SESSION_REVOKED (cookie reutilizada o sesión cerrada): /login?reason=revoked', async () => {
      const outcome = call('GET', VEHICLES_URL);
      fail(await next(VEHICLES_URL), 401, 'TOKEN_EXPIRED');
      fail(await next(REFRESH_URL), 401, 'SESSION_REVOKED');

      await vi.waitFor(() => expect(path()).toBe('/login'));
      expect(reason()).toBe('revoked');
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
      expect(store.isSignedIn()).toBe(false);
      expect(outcome.value).toBeUndefined();
      expect(outcome.error).toBeDefined();
    });

    it('[US3-AC2] 401 SESSION_EXPIRED directo en una petición: /login?reason=expired sin llamar al refresh', async () => {
      const outcome = call('GET', CLIENTS_URL);
      fail(await next(CLIENTS_URL), 401, 'SESSION_EXPIRED');

      await vi.waitFor(() => expect(path()).toBe('/login'));
      expect(reason()).toBe('expired');
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
      expect(outcome.error).toBeDefined();
      httpMock.expectNone(REFRESH_URL);
    });

    it('[US3-AC4] 401 SESSION_REVOKED directo en una petición: /login?reason=revoked sin llamar al refresh', async () => {
      const outcome = call('GET', CLIENTS_URL);
      fail(await next(CLIENTS_URL), 401, 'SESSION_REVOKED');

      await vi.waitFor(() => expect(path()).toBe('/login'));
      expect(reason()).toBe('revoked');
      expect(store.isSignedIn()).toBe(false);
      expect(outcome.error).toBeDefined();
      httpMock.expectNone(REFRESH_URL);
    });
  });

  describe('403 PASSWORD_CHANGE_REQUIRED', () => {
    it('[US5-AC1] lleva a /change-password, la petición falla y la sesión se conserva', async () => {
      const outcome = call('GET', VEHICLES_URL);
      fail(await next(VEHICLES_URL), 403, 'PASSWORD_CHANGE_REQUIRED');

      await vi.waitFor(() => expect(path()).toBe('/change-password'));
      expect(outcome.value).toBeUndefined();
      expect(outcome.error).toBeInstanceOf(HttpErrorResponse);
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(OLD_TOKEN);
      httpMock.expectNone(REFRESH_URL);
    });
  });

  describe('rutas /auth/* sin tocar', () => {
    it('[US2-AC3] un 401 INVALID_CREDENTIALS del login llega tal cual: sin refresh ni navegación', async () => {
      const outcome = call('POST', LOGIN_URL, { email: 'a@taller.ec', password: 'x' });
      fail(await next(LOGIN_URL), 401, 'INVALID_CREDENTIALS');

      expect((outcome.error as HttpErrorResponse).status).toBe(401);
      expect((outcome.error as HttpErrorResponse).error).toEqual(authProblem(401, 'INVALID_CREDENTIALS'));
      httpMock.expectNone(REFRESH_URL);
      expect(router.url).toBe('/clients');
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(OLD_TOKEN);
    });

    it('[US5-AC9] un 401 TEMPORARY_PASSWORD_EXPIRED de /auth/password llega tal cual a la pantalla', async () => {
      const outcome = call('POST', PASSWORD_URL, { currentPassword: 'a', newPassword: 'b' });
      fail(await next(PASSWORD_URL), 401, 'TEMPORARY_PASSWORD_EXPIRED');

      expect((outcome.error as HttpErrorResponse).error).toEqual(authProblem(401, 'TEMPORARY_PASSWORD_EXPIRED'));
      httpMock.expectNone(REFRESH_URL);
      expect(router.url).toBe('/clients');
    });

    it('[R5] un 401 TOKEN_EXPIRED del propio /auth/refresh no abre otro refresh (sin bucles)', async () => {
      const outcome = call('POST', REFRESH_URL);
      fail(await next(REFRESH_URL), 401, 'TOKEN_EXPIRED');

      expect(outcome.error).toBeInstanceOf(HttpErrorResponse);
      httpMock.expectNone(REFRESH_URL);
    });
  });

  describe('sin temporizadores', () => {
    it('[US3-AC2][R5] sin peticiones del usuario no hay ningún refresh, aunque pasen más de 30 minutos', async () => {
      vi.useFakeTimers();
      call('GET', VEHICLES_URL);
      httpMock.expectOne(VEHICLES_URL).flush({ items: [], hasMore: false });
      store.setSession(sessionResponseWithToken(NEW_TOKEN));

      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

      httpMock.expectNone(REFRESH_URL);
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(NEW_TOKEN);
      expect(router.url).toBe('/clients');
    });

    it('[US3-AC2] una respuesta correcta no provoca ningún refresh', async () => {
      const outcome = call('GET', VEHICLES_URL);
      (await next(VEHICLES_URL)).flush({ items: [], hasMore: false });

      expect(outcome.value).toEqual({ items: [], hasMore: false });
      httpMock.expectNone(REFRESH_URL);
    });
  });
});
