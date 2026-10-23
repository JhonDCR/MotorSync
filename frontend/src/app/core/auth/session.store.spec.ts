// T039 (002, PR2, US3): estado de la sesión en el frontend (research R13).
//
// Contrato para el implementer-frontend (T040), archivo core/auth/session.store.ts:
//   @Injectable({ providedIn: 'root' }) export class SessionStore {
//     readonly user: Signal<SessionUser | null>;          // user del contrato (SessionUser)
//     readonly workshop: Signal<Workshop | null>;
//     readonly isSignedIn: Signal<boolean>;               // user() !== null
//     readonly mustChangePassword: Signal<boolean>;       // user()?.mustChangePassword ?? false
//     setSession(session: SessionResponse): void;         // login, register, refresh y POST /auth/password:
//                                                         //   guarda session.accessToken en localStorage
//                                                         //   'motorsync.token' (AUTH_TOKEN_STORAGE_KEY) y fija
//                                                         //   user y workshop con los de la respuesta.
//     setCurrent(current: CurrentSession /* GET /auth/me */): void;  // fija user y workshop; NO toca el token.
//     clear(): void;                                      // borra 'motorsync.token' y deja user y workshop en null.
//     restore(): Observable<boolean>;                     // lo usan los guards (auth.guards.ts):
//        - sin token en localStorage → emite false sin ninguna petición;
//        - con user ya cargado → emite true sin ninguna petición;
//        - con token y sin user (recarga de página) → GET /api/v1/auth/me (AuthApiService.me()); al 200 hace
//          setCurrent y emite true; ante un 401 (Problem) hace clear() y emite false.
//   }
//   - El usuario, el rol, el taller y mustChangePassword salen SIEMPRE de las respuestas (SessionResponse o
//     /auth/me), nunca del JWT: aunque el payload diga otra cosa, manda la respuesta.
//   - El store no programa nada en el tiempo (ningún setTimeout/setInterval para refrescar; US3-AC2, R5).
//
//   AuthApiService (core/api/auth-api.service.ts) suma: me(): Observable<CurrentSession> (GET /api/v1/auth/me).
//   Sus detalles HTTP están en core/api/auth-api.service.session.spec.ts.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  authProblem,
  currentSession,
  ME_URL,
  problemFlush,
  sessionResponse,
  sessionResponseWithToken,
} from '../../../testing/auth-fixtures';
import { fakeJwt, TENANT_A } from '../../../testing/fake-jwt';
import { AUTH_TOKEN_STORAGE_KEY } from './auth-token.interceptor';
import { SessionStore } from './session.store';

/** JWT cuyo payload contradice a la respuesta: el store no debe leerlo. */
const MISLEADING_TOKEN = fakeJwt({
  sub: '99999999-9999-4999-8999-999999999999',
  tenant_id: TENANT_A,
  role: 'admin',
  name: 'Nombre Del Token',
  sid: '55555555-5555-4555-8555-555555555555',
  pwd_change: true,
  exp: Math.floor(Date.now() / 1000) + 900,
});

describe('SessionStore (T039)', () => {
  let store: SessionStore;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    store = TestBed.inject(SessionStore);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  it('[US3] empieza sin sesión', () => {
    expect(store.user()).toBeNull();
    expect(store.workshop()).toBeNull();
    expect(store.isSignedIn()).toBe(false);
    expect(store.mustChangePassword()).toBe(false);
  });

  describe('setSession (SessionResponse de login, register, refresh o cambio de contraseña)', () => {
    it('[US3] guarda el accessToken en motorsync.token y fija usuario y taller', () => {
      const session = sessionResponse({ role: 'asesor', name: 'Luis Mora' });

      store.setSession(session);

      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(session.accessToken);
      expect(store.user()).toEqual(session.user);
      expect(store.workshop()).toEqual(session.workshop);
      expect(store.isSignedIn()).toBe(true);
      expect(store.mustChangePassword()).toBe(false);
    });

    it('[US3] usuario, rol y mustChangePassword salen de la respuesta, no del JWT', () => {
      const session = sessionResponseWithToken(MISLEADING_TOKEN, {
        role: 'asesor',
        name: 'Luis Mora',
        mustChangePassword: false,
      });

      store.setSession(session);

      expect(store.user()?.role).toBe('asesor');
      expect(store.user()?.name).toBe('Luis Mora');
      expect(store.mustChangePassword()).toBe(false);
    });

    it('[US5-AC1] con mustChangePassword en la respuesta, mustChangePassword() es true', () => {
      store.setSession(sessionResponse({ mustChangePassword: true, temporaryPasswordExpiresAt: '2026-10-26T12:00:00Z' }));

      expect(store.mustChangePassword()).toBe(true);
    });

    it('[US4-AC5] un setSession posterior (refresh) reemplaza el rol por el vigente', () => {
      store.setSession(sessionResponse({ role: 'admin' }));
      store.setSession(sessionResponseWithToken('nuevo.token.acceso', { role: 'asesor' }));

      expect(store.user()?.role).toBe('asesor');
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('nuevo.token.acceso');
    });
  });

  describe('setCurrent (GET /auth/me)', () => {
    it('[US3] fija usuario y taller de /auth/me sin tocar el token guardado', () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, MISLEADING_TOKEN);
      const current = currentSession({ role: 'asesor', name: 'Luis Mora' });

      store.setCurrent(current);

      expect(store.user()).toEqual(current.user);
      expect(store.workshop()).toEqual(current.workshop);
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe(MISLEADING_TOKEN);
    });
  });

  describe('clear', () => {
    it('[US3-AC3] borra motorsync.token y deja la sesión vacía', () => {
      store.setSession(sessionResponse());

      store.clear();

      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
      expect(store.user()).toBeNull();
      expect(store.workshop()).toBeNull();
      expect(store.isSignedIn()).toBe(false);
      expect(store.mustChangePassword()).toBe(false);
    });
  });

  describe('restore (recarga de página)', () => {
    it('[FR-010] sin token emite false y no hace ninguna petición', async () => {
      await expect(firstValueFrom(store.restore())).resolves.toBe(false);
      httpMock.expectNone(ME_URL);
    });

    it('[US3] con un token guardado y sin datos, el store NO lee el JWT: sigue vacío hasta /auth/me', () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, MISLEADING_TOKEN);

      expect(store.user()).toBeNull();
      expect(store.isSignedIn()).toBe(false);
    });

    it('[US3] con un token guardado pide GET /auth/me y se llena con su respuesta, no con el JWT', async () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, MISLEADING_TOKEN);
      const current = currentSession({ role: 'asesor', name: 'Luis Mora', mustChangePassword: false });

      const restored = firstValueFrom(store.restore());
      const req = httpMock.expectOne(ME_URL);
      expect(req.request.method).toBe('GET');
      req.flush(current);

      await expect(restored).resolves.toBe(true);
      expect(store.user()).toEqual(current.user);
      expect(store.workshop()).toEqual(current.workshop);
      expect(store.mustChangePassword()).toBe(false);
    });

    it('[US5-AC1] /auth/me con mustChangePassword deja mustChangePassword() en true', async () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, MISLEADING_TOKEN);

      const restored = firstValueFrom(store.restore());
      httpMock.expectOne(ME_URL).flush(currentSession({ mustChangePassword: true }));

      await expect(restored).resolves.toBe(true);
      expect(store.mustChangePassword()).toBe(true);
    });

    it('[US3-AC4] si /auth/me responde 401, limpia el token y emite false', async () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, MISLEADING_TOKEN);

      const restored = firstValueFrom(store.restore());
      httpMock.expectOne(ME_URL).flush(authProblem(401, 'SESSION_REVOKED'), problemFlush(401));

      await expect(restored).resolves.toBe(false);
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
      expect(store.isSignedIn()).toBe(false);
    });

    it('[US3] con la sesión ya cargada emite true sin volver a pedir /auth/me', async () => {
      store.setSession(sessionResponse());

      await expect(firstValueFrom(store.restore())).resolves.toBe(true);
      httpMock.expectNone(ME_URL);
    });
  });
});
