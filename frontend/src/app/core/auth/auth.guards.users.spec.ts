// Revisión del PR3 (002, US4): adminGuard en carga directa. Archivo nuevo: auth.guards.spec.ts no cambia.
//
// Contrato para el implementer-frontend, archivo core/auth/auth.guards.ts:
//   adminGuard debe esperar a SessionStore.restore() antes de leer el rol, igual que authGuard. Al recargar la
//   página solo existe el token guardado (SessionStore vacío): el rol sale de la respuesta de GET /auth/me.
//     - /auth/me responde un admin → deja pasar (la URL termina en /users).
//     - /auth/me responde un asesor → UrlTree `/` (US4-AC16).
//   Las rutas reales (app.routes.ts) usan [authGuard, adminGuard] solo en canMatch. Las rutas de prueba de este
//   archivo los ponen también en canActivate para comprobar que varias llamadas a restore() comparten un único
//   GET /auth/me (single-flight).
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { currentSession, ME_URL } from '../../../testing/auth-fixtures';
import { tokenFor } from '../../../testing/fake-jwt';
import { adminGuard, authGuard } from './auth.guards';
import { AUTH_TOKEN_STORAGE_KEY } from './auth-token.interceptor';
import { SessionStore } from './session.store';

@Component({ template: '<p data-testid="users-page">Gestión de usuarios</p>' })
class UsersStubPage {}

@Component({ template: '<p data-testid="home">Inicio</p>' })
class HomeStubPage {}

const ROUTES: Routes = [
  { path: '', pathMatch: 'full', canMatch: [authGuard], component: HomeStubPage },
  { path: 'login', component: HomeStubPage },
  {
    path: 'users',
    canMatch: [authGuard, adminGuard],
    canActivate: [authGuard, adminGuard],
    component: UsersStubPage,
  },
  {
    path: 'users/:id',
    canMatch: [authGuard, adminGuard],
    canActivate: [authGuard, adminGuard],
    component: UsersStubPage,
  },
];

describe('adminGuard en carga directa (revisión PR3)', () => {
  let harness: RouterTestingHarness;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideRouter(ROUTES), provideHttpClient(), provideHttpClientTesting()],
    });
    httpMock = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  function url(): string {
    return TestBed.inject(Router).url;
  }

  function shows(testId: string): boolean {
    return (harness.routeNativeElement as HTMLElement | null)?.querySelector(`[data-testid="${testId}"]`) != null;
  }

  /** Recarga: solo el token guardado; el store está vacío y el rol llega por GET /auth/me. */
  async function reloadAt(target: string, role: 'admin' | 'asesor'): Promise<void> {
    // El rol del token es el contrario a propósito: el guard debe usar la respuesta del servidor, no el JWT.
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, tokenFor(role === 'admin' ? 'asesor' : 'admin'));
    expect(TestBed.inject(SessionStore).user()).toBeNull();

    const navigation = harness.navigateByUrl(target);
    const req = await vi.waitFor(() => httpMock.expectOne(ME_URL));
    req.flush(currentSession({ role }));
    await navigation;
    // Si el guard redirigió a /, authGuard de / ya tiene los datos y no repite /auth/me.
    httpMock.match(ME_URL).forEach((extra) => extra.flush(currentSession({ role })));
  }

  it('[US4-AC16] con solo el token guardado y /auth/me de un admin, /users se abre', async () => {
    await reloadAt('/users', 'admin');

    expect(url()).toBe('/users');
    expect(shows('users-page')).toBe(true);
  });

  it('[US4-AC16] con solo el token guardado y /auth/me de un admin, /users/:id se abre', async () => {
    await reloadAt('/users/abc', 'admin');

    expect(url()).toBe('/users/abc');
    expect(shows('users-page')).toBe(true);
  });

  it('[US4-AC16] con solo el token guardado y /auth/me de un asesor, /users vuelve a /', async () => {
    await reloadAt('/users', 'asesor');

    expect(url()).toBe('/');
    expect(shows('users-page')).toBe(false);
  });
});
