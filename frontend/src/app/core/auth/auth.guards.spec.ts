// T039 (002, PR2, US3, US5): guards de rutas (research R13: authGuard en canMatch).
//
// Contrato para el implementer-frontend (T040), archivo core/auth/auth.guards.ts:
//   export const authGuard: CanMatchFn
//     - sesión = SessionStore.restore() (session.store.ts): sin token → false sin HTTP; con token y sin datos →
//       GET /auth/me.
//     - sin sesión → UrlTree `/login?returnUrl=<url pedida>` (FR-010). La url pedida es la ruta completa, con su
//       query, por ejemplo `/clients/abc` o `/vehicles/search?q=PB`.
//     - con sesión y mustChangePassword → solo deja pasar `/change-password`; cualquier otra ruta protegida
//       redirige a `/change-password` (US5-AC1, FR-026).
//     - con sesión normal → true.
//   export const adminGuard: CanMatchFn
//     - se usa DESPUÉS de authGuard ([authGuard, adminGuard]); rol vigente del store distinto de 'admin' → UrlTree
//       `/` (US4-AC16, interfaz). Admin → true.
//   export const guestGuard: CanMatchFn
//     - para `/login` y `/register`: con sesión → UrlTree `/`; sin sesión → true.
//   Los tres son funciones (CanMatchFn) y leen el estado de SessionStore, nunca el payload del JWT.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import {
  authProblem,
  currentSession,
  ME_URL,
  problemFlush,
  sessionResponse,
} from '../../../testing/auth-fixtures';
import { tokenFor } from '../../../testing/fake-jwt';
import { adminGuard, authGuard, guestGuard } from './auth.guards';
import { AUTH_TOKEN_STORAGE_KEY } from './auth-token.interceptor';
import { SessionStore } from './session.store';

@Component({ template: '<p data-testid="page">pagina</p>' })
class StubPage {}

@Component({ template: '<p data-testid="workshop-data">Datos del taller</p>' })
class WorkshopPage {}

const ROUTES: Routes = [
  { path: 'login', canMatch: [guestGuard], component: StubPage },
  { path: 'register', canMatch: [guestGuard], component: StubPage },
  { path: 'change-password', canMatch: [authGuard], component: StubPage },
  { path: 'users', canMatch: [authGuard, adminGuard], component: WorkshopPage },
  { path: '', pathMatch: 'full', canMatch: [authGuard], component: WorkshopPage },
  { path: 'clients', canMatch: [authGuard], component: WorkshopPage },
  { path: 'clients/:id', canMatch: [authGuard], component: WorkshopPage },
  { path: 'vehicles/search', canMatch: [authGuard], component: WorkshopPage },
];

describe('auth.guards (T039)', () => {
  let harness: RouterTestingHarness;
  let httpMock: HttpTestingController;
  let store: SessionStore;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideRouter(ROUTES), provideHttpClient(), provideHttpClientTesting()],
    });
    httpMock = TestBed.inject(HttpTestingController);
    store = TestBed.inject(SessionStore);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  function url(): string {
    return TestBed.inject(Router).url;
  }

  function path(): string {
    return url().split('?')[0];
  }

  function query(name: string): string | undefined {
    const value: unknown = TestBed.inject(Router).parseUrl(url()).queryParams[name];
    return typeof value === 'string' ? value : undefined;
  }

  function shows(testId: string): boolean {
    return (harness.routeNativeElement as HTMLElement | null)?.querySelector(`[data-testid="${testId}"]`) != null;
  }

  describe('authGuard', () => {
    it('[FR-010] sin sesión, /clients lleva a /login con returnUrl=/clients y no muestra datos', async () => {
      await harness.navigateByUrl('/clients');

      expect(path()).toBe('/login');
      expect(query('returnUrl')).toBe('/clients');
      expect(shows('workshop-data')).toBe(false);
    });

    it('[FR-010] returnUrl conserva la ruta completa con su query', async () => {
      await harness.navigateByUrl('/vehicles/search?q=PB');

      expect(path()).toBe('/login');
      expect(query('returnUrl')).toBe('/vehicles/search?q=PB');
    });

    it('[FR-010] sin sesión, la raíz "" también lleva a /login', async () => {
      await harness.navigateByUrl('/');

      expect(path()).toBe('/login');
      expect(shows('workshop-data')).toBe(false);
    });

    it('[US3] con sesión en el store deja pasar sin pedir /auth/me', async () => {
      store.setSession(sessionResponse({ role: 'asesor' }));

      await harness.navigateByUrl('/clients/abc');

      expect(url()).toBe('/clients/abc');
      expect(shows('workshop-data')).toBe(true);
      httpMock.expectNone(ME_URL);
    });

    it('[US3] con token guardado y sin datos (recarga) pide /auth/me y deja pasar con su respuesta', async () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, tokenFor('admin', 'Nombre Del Token'));

      const navigation = harness.navigateByUrl('/clients');
      const req = await vi.waitFor(() => httpMock.expectOne(ME_URL));
      req.flush(currentSession({ role: 'asesor', name: 'Luis Mora' }));
      await navigation;

      expect(url()).toBe('/clients');
      expect(store.user()?.name).toBe('Luis Mora');
      expect(store.user()?.role).toBe('asesor');
    });

    it('[US3-AC4] si /auth/me rechaza el token guardado (401), lleva a /login y lo borra', async () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, tokenFor('asesor'));

      const navigation = harness.navigateByUrl('/clients');
      const req = await vi.waitFor(() => httpMock.expectOne(ME_URL));
      req.flush(authProblem(401, 'SESSION_REVOKED'), problemFlush(401));
      await navigation;

      expect(path()).toBe('/login');
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
      expect(shows('workshop-data')).toBe(false);
    });

    describe('con contraseña temporal pendiente (mustChangePassword)', () => {
      beforeEach(() => {
        store.setSession(sessionResponse({ role: 'asesor', mustChangePassword: true }));
      });

      it('[US5-AC1] /clients redirige a /change-password sin mostrar datos', async () => {
        await harness.navigateByUrl('/clients');

        expect(path()).toBe('/change-password');
        expect(shows('workshop-data')).toBe(false);
      });

      it('[US5-AC1] la raíz "" redirige a /change-password', async () => {
        await harness.navigateByUrl('/');

        expect(path()).toBe('/change-password');
      });

      it('[US5-AC1] /change-password sí se puede abrir', async () => {
        await harness.navigateByUrl('/change-password');

        expect(url()).toBe('/change-password');
        expect(shows('page')).toBe(true);
      });

      it('[US5-AC1] mustChangePassword que llega por /auth/me también obliga a /change-password', async () => {
        store.clear();
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, tokenFor('asesor'));

        const navigation = harness.navigateByUrl('/clients');
        const req = await vi.waitFor(() => httpMock.expectOne(ME_URL));
        req.flush(currentSession({ mustChangePassword: true }));
        await navigation;

        expect(path()).toBe('/change-password');
      });
    });

    it('[FR-010] sin sesión, /change-password también lleva a /login', async () => {
      await harness.navigateByUrl('/change-password');

      expect(path()).toBe('/login');
    });
  });

  describe('adminGuard', () => {
    it('[US4-AC16] un asesor que abre /users vuelve a / sin ver la gestión', async () => {
      store.setSession(sessionResponse({ role: 'asesor' }));

      await harness.navigateByUrl('/users');

      expect(url()).toBe('/');
    });

    it('[US4-AC16] un administrador abre /users', async () => {
      store.setSession(sessionResponse({ role: 'admin' }));

      await harness.navigateByUrl('/users');

      expect(url()).toBe('/users');
      expect(shows('workshop-data')).toBe(true);
    });

    it('[FR-010] sin sesión, /users lleva a /login', async () => {
      await harness.navigateByUrl('/users');

      expect(path()).toBe('/login');
    });
  });

  describe('guestGuard', () => {
    it('[FR-010] sin sesión, /login y /register se abren', async () => {
      await harness.navigateByUrl('/login');
      expect(url()).toBe('/login');

      await harness.navigateByUrl('/register');
      expect(url()).toBe('/register');
    });

    it('[US3] con sesión, /login lleva a /', async () => {
      store.setSession(sessionResponse({ role: 'asesor' }));

      await harness.navigateByUrl('/login');

      expect(url()).toBe('/');
    });

    it('[US3] con sesión, /register lleva a /', async () => {
      store.setSession(sessionResponse({ role: 'admin' }));

      await harness.navigateByUrl('/register');

      expect(url()).toBe('/');
    });
  });
});
