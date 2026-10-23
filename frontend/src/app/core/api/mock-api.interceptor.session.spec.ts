// T047 (002, PR2, US3, US5): rutas de sesión y contraseña del mockApiInterceptor (research R13), con las reglas de
// specs/002-autenticacion/contracts/openapi.yaml. Archivo nuevo: los specs del mock de la 001 y del PR1 no cambian.
//
// Contrato para el implementer-frontend (T048), archivos core/api/mock-api.interceptor.ts, mock-auth.store.ts y
// mock-api.store.ts:
//   MockAuthStore.addAccount(input: {
//     workshopId: string; name: string; email: string; role: Role; password: string;
//     mustChangePassword?: boolean;              // por defecto false
//     temporaryPasswordExpiresAt?: string | null // ISO 8601; obligatorio si mustChangePassword (como el CHECK de R7)
//   }): void
//     Alta directa de una cuenta en el mock (la usan estas pruebas; en el PR3 la reutiliza POST /users). El correo se
//     guarda normalizado.
//   "Cookie" ms_refresh simulada EN MEMORIA (una por MockAuthStore = un navegador): login y register abren una sesión
//     nueva (sid nuevo en el token) y dejan la cookie apuntando a ella. Nunca aparece en un body.
//   POST /api/v1/auth/refresh
//     - sin `X-Requested-With: motorsync` → 400 VALIDATION_ERROR;
//     - sin cookie (nunca hubo login, o tras logout) → 401 SESSION_EXPIRED;
//     - cookie de una sesión revocada → 401 SESSION_REVOKED (y borra la cookie);
//     - si no → 200 SessionResponse con los datos vigentes de la cuenta y un token con el MISMO sid.
//   POST /api/v1/auth/logout
//     - sin `X-Requested-With: motorsync` → 400 VALIDATION_ERROR;
//     - siempre 204 (idempotente, US3-AC6): revoca la sesión de la cookie si la hay y borra la cookie.
//   GET /api/v1/auth/me (Bearer)
//     - token con un sid vivo → 200 { user, workshop } vigentes (CurrentSession), también con temporal pendiente;
//     - sid revocado → 401 SESSION_REVOKED; sin token legible → 401 UNAUTHORIZED.
//   POST /api/v1/auth/password (Bearer) con { currentPassword, newPassword }:
//     - campos extra → 400 VALIDATION_ERROR con UNKNOWN_FIELD (US5-AC8);
//     - actual incorrecta → 400 CURRENT_PASSWORD_INCORRECT con errors[{ field: 'currentPassword' }]; cuenta para el
//       bloqueo del correo: tras 5 seguidas, 429 ACCOUNT_LOCKED aquí y en el login (US5-AC4), sin revocar la sesión;
//     - nueva < 8 → 400 VALIDATION_ERROR PASSWORD_TOO_SHORT en newPassword; igual a la actual → SAME_PASSWORD;
//     - temporal vencida → 401 TEMPORARY_PASSWORD_EXPIRED y revoca la sesión (US5-AC9);
//     - éxito → 200 SessionResponse con mustChangePassword false y token pwd_change false (mismo sid); revoca las
//       OTRAS sesiones de la cuenta (US5-AC3); la contraseña anterior deja de servir.
//   POST /api/v1/auth/login con cuentas temporales:
//     - vigente → 200 con user.mustChangePassword true y token con pwd_change true;
//     - vencida y contraseña correcta → 401 TEMPORARY_PASSWORD_EXPIRED (no cuenta como fallo); incorrecta →
//       INVALID_CREDENTIALS.
//   Rutas de la 001 (/clients, /vehicles…):
//     - token con sid de una cuenta con temporal pendiente → 403 PASSWORD_CHANGE_REQUIRED (US5-AC1);
//     - token con sid revocado → 401 SESSION_REVOKED (US3-AC4);
//     - token SIN sid (dev-token, fake-jwt de las pruebas de la 001) → como hasta ahora.
//   Ningún body de respuesta contiene una contraseña (FR-006, US5-AC7).
import { HttpClient, HttpErrorResponse, HttpHeaders, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  decodeClaims,
  LOGIN_URL,
  LOGOUT_URL,
  ME_URL,
  NEW_PASSWORD,
  PASSWORD,
  PASSWORD_URL,
  REFRESH_URL,
  REGISTER_BODY,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  TEMPORARY_PASSWORD,
  type CurrentSessionFixture,
  type SessionResponseFixture,
} from '../../../testing/auth-fixtures';
import { tokenFor } from '../../../testing/fake-jwt';
import type { Problem } from './api.models';
import { mockApiInterceptor } from './mock-api.interceptor';
import { MockAuthStore } from './mock-auth.store';
import { USE_MOCK_API } from './use-mock-api';

const REGISTER_URL = '/api/v1/auth/register';
const VEHICLES_SEARCH_URL = '/api/v1/vehicles/search?q=PB';
const CLIENTS_SEARCH_URL = '/api/v1/clients/search?q=an';
const CSRF = { [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE };
const TEMP_EMAIL = 'luis.mora@taller.ec';

describe('mockApiInterceptor: sesión y contraseña (T047)', () => {
  let http: HttpClient;
  let auth: MockAuthStore;

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
    auth = TestBed.inject(MockAuthStore);
  });

  afterEach(() => {
    // Nada llega al backend: el mock responde todas las rutas de estas pruebas.
    TestBed.inject(HttpTestingController).verify();
  });

  // --- utilidades ---

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

  async function register(): Promise<SessionResponseFixture> {
    const response = await firstValueFrom(
      http.post<SessionResponseFixture>(REGISTER_URL, REGISTER_BODY, { withCredentials: true }),
    );
    return response;
  }

  function login(email: string, password: string) {
    return firstValueFrom(http.post<SessionResponseFixture>(LOGIN_URL, { email, password }, { withCredentials: true }));
  }

  function refresh(withCsrf = true) {
    return firstValueFrom(
      http.post<SessionResponseFixture>(REFRESH_URL, null, {
        withCredentials: true,
        headers: withCsrf ? CSRF : {},
        observe: 'response',
      }),
    );
  }

  function logout(withCsrf = true) {
    return firstValueFrom(
      http.post(LOGOUT_URL, null, { withCredentials: true, headers: withCsrf ? CSRF : {}, observe: 'response' }),
    );
  }

  function me(token: string) {
    return firstValueFrom(http.get<CurrentSessionFixture>(ME_URL, { headers: bearer(token) }));
  }

  function changePassword(token: string, body: unknown) {
    return firstValueFrom(http.post<SessionResponseFixture>(PASSWORD_URL, body, { headers: bearer(token) }));
  }

  function search(token: string, url = VEHICLES_SEARCH_URL) {
    return firstValueFrom(http.get(url, { headers: bearer(token), observe: 'response' }));
  }

  /** Taller registrado por el dueño (US1) y una cuenta temporal de Luis en ese taller. */
  async function withTemporaryAccount(expiresInHours = 72): Promise<SessionResponseFixture> {
    const owner = await register();
    auth.addAccount({
      workshopId: owner.workshop.id,
      name: 'Luis Mora',
      email: TEMP_EMAIL,
      role: 'asesor',
      password: TEMPORARY_PASSWORD,
      mustChangePassword: true,
      temporaryPasswordExpiresAt: new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString(),
    });
    return owner;
  }

  describe('POST /auth/refresh (cookie simulada)', () => {
    it('[US3-AC1] tras el login, refresh da 200 con usuario vigente y un token de la MISMA sesión', async () => {
      const session = await register();

      const response = await refresh();

      expect(response.status).toBe(200);
      const body = response.body as SessionResponseFixture;
      expect(body.user).toEqual(session.user);
      expect(body.workshop).toEqual(session.workshop);
      expect(body.expiresIn).toBe(900);
      expect(decodeClaims(body.accessToken)?.['sid']).toBe(decodeClaims(session.accessToken)?.['sid']);
      expect(JSON.stringify(body)).not.toContain(REGISTER_BODY.password.trim());
    });

    it('[US3-AC2] sin cookie (nunca hubo login) da 401 SESSION_EXPIRED', async () => {
      const error = await failure(refresh());

      expect(error.status).toBe(401);
      expect(problemOf(error).code).toBe('SESSION_EXPIRED');
    });

    it('[R11] sin X-Requested-With: motorsync da 400 VALIDATION_ERROR', async () => {
      await register();

      const error = await failure(refresh(false));

      expect(error.status).toBe(400);
      expect(problemOf(error).code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /auth/logout', () => {
    it('[US3-AC3][US3-AC4] da 204; después el refresh falla y el token anterior da SESSION_REVOKED', async () => {
      const session = await register();

      const response = await logout();
      expect(response.status).toBe(204);

      const refreshError = await failure(refresh());
      expect(refreshError.status).toBe(401);
      expect(problemOf(refreshError).code).toBe('SESSION_EXPIRED');

      const meError = await failure(me(session.accessToken));
      expect(meError.status).toBe(401);
      expect(problemOf(meError).code).toBe('SESSION_REVOKED');

      const searchError = await failure(search(session.accessToken));
      expect(problemOf(searchError).code).toBe('SESSION_REVOKED');
    });

    it('[US3-AC6] un segundo logout, o uno sin sesión, también da 204', async () => {
      expect((await logout()).status).toBe(204);

      await register();
      expect((await logout()).status).toBe(204);
      expect((await logout()).status).toBe(204);
    });

    it('[R11] sin X-Requested-With: motorsync da 400 VALIDATION_ERROR y no cierra la sesión', async () => {
      const session = await register();

      const error = await failure(logout(false));

      expect(error.status).toBe(400);
      expect(problemOf(error).code).toBe('VALIDATION_ERROR');
      expect((await me(session.accessToken)).user.id).toBe(session.user.id);
    });

    it('[US3-AC5] el logout de un equipo no afecta la sesión del otro', async () => {
      const session = await register();
      const first = await login(REGISTER_BODY.email, REGISTER_BODY.password);
      const second = await login(REGISTER_BODY.email, REGISTER_BODY.password);
      expect(decodeClaims(first.accessToken)?.['sid']).not.toBe(decodeClaims(second.accessToken)?.['sid']);

      // La cookie es la del último login (second): el logout cierra solo esa sesión.
      await logout();

      expect((await me(first.accessToken)).user.id).toBe(session.user.id);
      expect(problemOf(await failure(me(second.accessToken))).code).toBe('SESSION_REVOKED');
    });
  });

  describe('GET /auth/me', () => {
    it('[US3] devuelve usuario y taller de la sesión', async () => {
      const session = await register();

      const current = await me(session.accessToken);

      expect(current).toEqual({ user: session.user, workshop: session.workshop });
    });

    it('[US3] sin token da 401 UNAUTHORIZED', async () => {
      const error = await failure(firstValueFrom(http.get(ME_URL)));

      expect(error.status).toBe(401);
      expect(problemOf(error).code).toBe('UNAUTHORIZED');
    });
  });

  describe('contraseña temporal', () => {
    it('[US5-AC1] el login con la temporal vigente da mustChangePassword y pwd_change true', async () => {
      await withTemporaryAccount();

      const session = await login(TEMP_EMAIL, TEMPORARY_PASSWORD);

      expect(session.user.mustChangePassword).toBe(true);
      expect(session.user.temporaryPasswordExpiresAt).not.toBeNull();
      expect(decodeClaims(session.accessToken)?.['pwd_change']).toBe(true);
    });

    it('[US5-AC1] con la sesión temporal, las rutas del taller dan 403 PASSWORD_CHANGE_REQUIRED y /auth/me 200', async () => {
      await withTemporaryAccount();
      const session = await login(TEMP_EMAIL, TEMPORARY_PASSWORD);

      for (const url of [VEHICLES_SEARCH_URL, CLIENTS_SEARCH_URL]) {
        const error = await failure(search(session.accessToken, url));
        expect(error.status).toBe(403);
        expect(problemOf(error).code).toBe('PASSWORD_CHANGE_REQUIRED');
      }
      const current = await me(session.accessToken);
      expect(current.user.mustChangePassword).toBe(true);
    });

    it('[US5-AC2] al cambiarla da un token con pwd_change false que ya accede, y la temporal deja de servir', async () => {
      await withTemporaryAccount();
      const session = await login(TEMP_EMAIL, TEMPORARY_PASSWORD);

      const changed = await changePassword(session.accessToken, {
        currentPassword: TEMPORARY_PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      expect(changed.user.mustChangePassword).toBe(false);
      expect(changed.user.temporaryPasswordExpiresAt).toBeNull();
      expect(decodeClaims(changed.accessToken)?.['pwd_change']).toBe(false);
      expect(decodeClaims(changed.accessToken)?.['sid']).toBe(decodeClaims(session.accessToken)?.['sid']);
      expect((await search(changed.accessToken)).status).toBe(200);
      expect(problemOf(await failure(login(TEMP_EMAIL, TEMPORARY_PASSWORD))).code).toBe('INVALID_CREDENTIALS');
      expect((await login(TEMP_EMAIL, NEW_PASSWORD)).user.mustChangePassword).toBe(false);
    });

    it('[US5-AC9] temporal vencida: con la correcta 401 TEMPORARY_PASSWORD_EXPIRED, con otra INVALID_CREDENTIALS', async () => {
      await withTemporaryAccount(-1);

      const expired = await failure(login(TEMP_EMAIL, TEMPORARY_PASSWORD));
      expect(expired.status).toBe(401);
      expect(problemOf(expired).code).toBe('TEMPORARY_PASSWORD_EXPIRED');

      const wrong = await failure(login(TEMP_EMAIL, 'Otra Clave 123'));
      expect(problemOf(wrong).code).toBe('INVALID_CREDENTIALS');
    });

    it('[US5-AC9] el vencimiento no cuenta como intento fallido para el bloqueo', async () => {
      await withTemporaryAccount(-1);

      for (let attempt = 0; attempt < 6; attempt += 1) {
        expect(problemOf(await failure(login(TEMP_EMAIL, TEMPORARY_PASSWORD))).code).toBe(
          'TEMPORARY_PASSWORD_EXPIRED',
        );
      }
    });
  });

  describe('POST /auth/password', () => {
    it('[US5-AC4] actual incorrecta: 400 CURRENT_PASSWORD_INCORRECT en currentPassword, sin cerrar la sesión', async () => {
      const session = await register();

      const error = await failure(
        changePassword(session.accessToken, { currentPassword: 'Incorrecta 123', newPassword: NEW_PASSWORD }),
      );

      expect(error.status).toBe(400);
      expect(problemOf(error).code).toBe('CURRENT_PASSWORD_INCORRECT');
      expect(fieldCodes(error)).toEqual([{ field: 'currentPassword', code: 'CURRENT_PASSWORD_INCORRECT' }]);
      expect(JSON.stringify(problemOf(error))).not.toContain('Incorrecta 123');
      expect((await me(session.accessToken)).user.id).toBe(session.user.id);
    });

    it('[US5-AC4] 5 fallos seguidos: 429 ACCOUNT_LOCKED en el cambio y en el login, y la sesión sigue', async () => {
      const session = await register();
      const wrong = { currentPassword: 'Incorrecta 123', newPassword: NEW_PASSWORD };
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await failure(changePassword(session.accessToken, wrong));
      }

      const locked = await failure(
        changePassword(session.accessToken, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }),
      );
      expect(locked.status).toBe(429);
      expect(problemOf(locked).code).toBe('ACCOUNT_LOCKED');
      expect(problemOf(await failure(login(REGISTER_BODY.email, PASSWORD))).code).toBe('ACCOUNT_LOCKED');
      expect((await me(session.accessToken)).user.id).toBe(session.user.id);
    });

    it('[US5-AC5] nueva igual a la actual: 400 VALIDATION_ERROR con SAME_PASSWORD en newPassword', async () => {
      const session = await register();

      const error = await failure(changePassword(session.accessToken, { currentPassword: PASSWORD, newPassword: PASSWORD }));

      expect(error.status).toBe(400);
      expect(problemOf(error).code).toBe('VALIDATION_ERROR');
      expect(fieldCodes(error)).toContainEqual({ field: 'newPassword', code: 'SAME_PASSWORD' });
    });

    it('[US5-AC5] nueva de 7 caracteres: PASSWORD_TOO_SHORT en newPassword', async () => {
      const session = await register();

      const error = await failure(changePassword(session.accessToken, { currentPassword: PASSWORD, newPassword: 'Abc 123' }));

      expect(fieldCodes(error)).toContainEqual({ field: 'newPassword', code: 'PASSWORD_TOO_SHORT' });
    });

    it('[US5-AC8] un userId en el body da UNKNOWN_FIELD', async () => {
      const session = await register();

      const error = await failure(
        changePassword(session.accessToken, {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
          userId: '99999999-9999-4999-8999-999999999999',
        }),
      );

      expect(error.status).toBe(400);
      expect(fieldCodes(error)).toContainEqual({ field: 'userId', code: 'UNKNOWN_FIELD' });
    });

    it('[US5-AC3] cambio voluntario: la otra sesión queda SESSION_REVOKED, esta sigue y la anterior no sirve', async () => {
      await register();
      const tablet = await login(REGISTER_BODY.email, PASSWORD);
      const phone = await login(REGISTER_BODY.email, PASSWORD);

      const changed = await changePassword(tablet.accessToken, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

      expect(JSON.stringify(changed)).not.toContain(NEW_PASSWORD.trim());
      expect((await me(changed.accessToken)).user.id).toBe(tablet.user.id);
      expect(problemOf(await failure(me(phone.accessToken))).code).toBe('SESSION_REVOKED');
      expect(problemOf(await failure(login(REGISTER_BODY.email, PASSWORD))).code).toBe('INVALID_CREDENTIALS');
    });

    it('[US5-AC9] si la temporal venció durante la sesión: 401 TEMPORARY_PASSWORD_EXPIRED y la sesión se revoca', async () => {
      const owner = await register();
      auth.addAccount({
        workshopId: owner.workshop.id,
        name: 'Luis Mora',
        email: TEMP_EMAIL,
        role: 'asesor',
        password: TEMPORARY_PASSWORD,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 400).toISOString(),
      });
      const session = await login(TEMP_EMAIL, TEMPORARY_PASSWORD);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const error = await failure(
        changePassword(session.accessToken, { currentPassword: TEMPORARY_PASSWORD, newPassword: NEW_PASSWORD }),
      );

      expect(error.status).toBe(401);
      expect(problemOf(error).code).toBe('TEMPORARY_PASSWORD_EXPIRED');
      expect(problemOf(await failure(me(session.accessToken))).code).toBe('SESSION_REVOKED');
    });
  });

  describe('compatibilidad con la 001', () => {
    it('[R9] un token sin sid (dev-token) sigue accediendo a las rutas del taller', async () => {
      const response = await search(tokenFor('asesor'));

      expect(response.status).toBe(200);
    });
  });
});
