// T037 (003, PR1, US2): estado de la sesión de soporte en el frontend (research R4, R13).
//
// Contrato para el implementer-frontend (T038), archivo core/support/support-session.store.ts:
//   @Injectable({ providedIn: 'root' }) export class SupportSessionStore {
//     readonly agent: Signal<SupportAgent | null>;
//     readonly isSignedIn: Signal<boolean>;               // agent() !== null
//     readonly mustChangePassword: Signal<boolean>;       // agent()?.mustChangePassword ?? false
//     setSession(session: SupportSessionResponse): void;  // guarda session.accessToken en localStorage
//                                                         // 'motorsync.support.token' (SUPPORT_TOKEN_STORAGE_KEY)
//                                                         // y fija agent con el de la respuesta. NUNCA toca
//                                                         // 'motorsync.token' ni SessionStore.
//     setCurrent(current: CurrentSupportSessionResponse): void; // fija agent; NO toca el token.
//     clear(): void;                                      // borra 'motorsync.support.token' y deja agent en null.
//                                                         // NUNCA borra 'motorsync.token'.
//     restore(): Observable<boolean>;                     // lo usan los guards (support.guards.ts):
//        - sin 'motorsync.support.token' en localStorage → emite false sin ninguna petición (incluso si existe 'motorsync.token');
//        - con agent ya cargado → emite true sin ninguna petición;
//        - con 'motorsync.support.token' y sin agent → GET /api/v1/support/auth/me (SupportApiService.me());
//          al 200 hace setCurrent y emite true; ante un 401 hace clear() y emite false.
//   }
//   - El agente y mustChangePassword salen SIEMPRE de las respuestas (SupportSessionResponse o /support/auth/me),
//     nunca del JWT.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { problemFlush } from '../../../testing/auth-fixtures';
import { fakeJwt } from '../../../testing/fake-jwt';
import {
  currentSupportSession,
  SUPPORT_AGENT_ID,
  SUPPORT_JWT_AUDIENCE,
  SUPPORT_ME_URL,
  SUPPORT_SESSION_ID,
  SUPPORT_TOKEN_STORAGE_KEY,
  supportProblem,
  supportSessionResponse,
} from '../../../testing/support-fixtures';
import { AUTH_TOKEN_STORAGE_KEY } from '../auth/auth-token.interceptor';
import { SupportSessionStore } from './support-session.store';

/** JWT cuyo payload contradice a la respuesta: el store no debe leerlo. */
const MISLEADING_SUPPORT_TOKEN = fakeJwt({
  sub: '99999999-9999-4999-8999-999999999999',
  sid: SUPPORT_SESSION_ID,
  name: 'Nombre Falso Del Token',
  pwd_change: true,
  aud: SUPPORT_JWT_AUDIENCE,
  exp: Math.floor(Date.now() / 1000) + 900,
});

describe('SupportSessionStore (T037)', () => {
  let store: SupportSessionStore;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    store = TestBed.inject(SupportSessionStore);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  it('[US2-AC1] empieza sin sesión de soporte', () => {
    expect(store.agent()).toBeNull();
    expect(store.isSignedIn()).toBe(false);
    expect(store.mustChangePassword()).toBe(false);
  });

  describe('setSession (SupportSessionResponse de login, refresh o cambio de contraseña)', () => {
    it('[US2-AC1][FR-008] guarda el accessToken en motorsync.support.token, nunca en motorsync.token, y fija el agente', () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token.taller.intacto');
      const session = supportSessionResponse({ name: 'Pedro Soporte' });

      store.setSession(session);

      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBe(session.accessToken);
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('token.taller.intacto');
      expect(store.agent()).toEqual(session.agent);
      expect(store.isSignedIn()).toBe(true);
      expect(store.mustChangePassword()).toBe(false);
    });

    it('[US2-AC1] el agente y mustChangePassword salen de la respuesta, nunca del JWT', () => {
      const session = {
        ...supportSessionResponse({
          id: SUPPORT_AGENT_ID,
          name: 'Pedro Soporte',
          mustChangePassword: false,
        }),
        accessToken: MISLEADING_SUPPORT_TOKEN,
      };

      store.setSession(session);

      expect(store.agent()?.name).toBe('Pedro Soporte');
      expect(store.mustChangePassword()).toBe(false);
    });

    it('[US2-AC4] con mustChangePassword en la respuesta, mustChangePassword() es true', () => {
      store.setSession(
        supportSessionResponse({
          mustChangePassword: true,
          temporaryPasswordExpiresAt: '2026-10-26T14:00:00.000Z',
        }),
      );

      expect(store.mustChangePassword()).toBe(true);
    });
  });

  describe('setCurrent (GET /support/auth/me)', () => {
    it('[US2-AC1] fija el agente de /support/auth/me sin tocar el token guardado', () => {
      localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, MISLEADING_SUPPORT_TOKEN);
      const current = currentSupportSession({ name: 'Pedro Soporte' });

      store.setCurrent(current);

      expect(store.agent()).toEqual(current.agent);
      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBe(MISLEADING_SUPPORT_TOKEN);
    });
  });

  describe('clear', () => {
    it('[US2-AC1][US2-AC5] borra motorsync.support.token y deja la sesión de soporte vacía sin tocar motorsync.token', () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token.taller.intacto');
      store.setSession(supportSessionResponse());

      store.clear();

      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('token.taller.intacto');
      expect(store.agent()).toBeNull();
      expect(store.isSignedIn()).toBe(false);
      expect(store.mustChangePassword()).toBe(false);
    });
  });

  describe('restore (recarga de página)', () => {
    it('[US2-AC5][FR-008] sin motorsync.support.token emite false y no hace petición, aunque exista motorsync.token de taller', async () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token.taller.activo');

      await expect(firstValueFrom(store.restore())).resolves.toBe(false);
      httpMock.expectNone(SUPPORT_ME_URL);
    });

    it('[US2-AC1] con motorsync.support.token guardado y sin datos, el store NO lee el JWT: sigue vacío hasta /support/auth/me', () => {
      localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, MISLEADING_SUPPORT_TOKEN);

      expect(store.agent()).toBeNull();
      expect(store.isSignedIn()).toBe(false);
    });

    it('[US2-AC1] con motorsync.support.token guardado pide GET /api/v1/support/auth/me y se llena con su respuesta', async () => {
      localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, MISLEADING_SUPPORT_TOKEN);
      const current = currentSupportSession({ name: 'Pedro Soporte', mustChangePassword: false });

      const restored = firstValueFrom(store.restore());
      const req = httpMock.expectOne(SUPPORT_ME_URL);
      expect(req.request.method).toBe('GET');
      req.flush(current);

      await expect(restored).resolves.toBe(true);
      expect(store.agent()).toEqual(current.agent);
      expect(store.mustChangePassword()).toBe(false);
    });

    it('[US2-AC4] /support/auth/me con mustChangePassword deja mustChangePassword() en true', async () => {
      localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, MISLEADING_SUPPORT_TOKEN);

      const restored = firstValueFrom(store.restore());
      httpMock.expectOne(SUPPORT_ME_URL).flush(currentSupportSession({ mustChangePassword: true }));

      await expect(restored).resolves.toBe(true);
      expect(store.mustChangePassword()).toBe(true);
    });

    it('[US2-AC3] si /support/auth/me responde 401, limpia motorsync.support.token (conservando motorsync.token) y emite false', async () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'token.taller.intacto');
      localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, MISLEADING_SUPPORT_TOKEN);

      const restored = firstValueFrom(store.restore());
      httpMock.expectOne(SUPPORT_ME_URL).flush(supportProblem(401, 'SESSION_REVOKED'), problemFlush(401));

      await expect(restored).resolves.toBe(false);
      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe('token.taller.intacto');
      expect(store.isSignedIn()).toBe(false);
    });

    it('[US2-AC1] con la sesión de soporte ya cargada emite true sin volver a pedir /support/auth/me', async () => {
      store.setSession(supportSessionResponse());

      await expect(firstValueFrom(store.restore())).resolves.toBe(true);
      httpMock.expectNone(SUPPORT_ME_URL);
    });
  });
});
