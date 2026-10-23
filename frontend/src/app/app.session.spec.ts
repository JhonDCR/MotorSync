// T045 (002, PR2, US3, US5): barra de sesión de la app y rutas protegidas. Archivo nuevo: app.spec.ts no cambia.
//
// Contrato para el implementer-frontend (T046):
//   app.ts / app.html (barra superior, dentro del <header> existente):
//     Con sesión (SessionStore.isSignedIn()):
//       data-testid="session-user"       nombre del usuario (user.name)
//       data-testid="session-role"       "Administrador" (admin) o "Asesor" (asesor)
//       data-testid="session-workshop"   nombre del taller (workshop.name)
//       data-testid="logout"             <button> "Cerrar sesión", min-height ≥ 44 px (FR-025). Visible directamente
//                                        (1 toque) o dentro de un menú que se abre con
//       data-testid="session-menu-toggle" (opcional; 2 toques en total como máximo).
//     Sin sesión: no existe ninguno de esos elementos (la navegación "Principal" de la 001 no cambia).
//     Con contraseña temporal pendiente (mustChangePassword): NO se muestra nav[aria-label="Principal"] (solo puede
//       cambiar la contraseña o cerrar sesión, FR-026); "Cerrar sesión" sí.
//     Al pulsar "Cerrar sesión": AuthApiService.logout() (POST /api/v1/auth/logout con withCredentials y
//       X-Requested-With: motorsync); al terminar, con éxito O con error (logout idempotente, US3-AC6), hace
//       SessionStore.clear() y navega a /login?reason=logout.
//   app.routes.ts:
//     export function buildRoutes(devMode: boolean): Routes   // la tabla completa
//     export const routes: Routes = buildRoutes(isDevMode());
//       - `dev-token` solo existe con devMode true (research R13: fuera de desarrollo no hay /dev-token).
//       - `login` y `register` con canMatch [guestGuard]; `change-password` (ChangePasswordPage) con [authGuard];
//         '', clients, clients/new, clients/:id, clients/:id/edit, vehicles/new, vehicles/:id y vehicles/:id/edit con
//         canMatch [authGuard] (core/auth/auth.guards.ts).
//
// Nota: con authGuard, los casos de rutas de la 001 que navegan sin sesión (app.spec.ts "Rutas raíz",
// client-search.page.spec.ts "Rutas de clientes" y vehicle-search.page.spec.ts "Ruta de búsqueda") pasan a /login.
import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Route, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { App } from './app';
import { buildRoutes, routes } from './app.routes';
import { authGuard } from './core/auth/auth.guards';
import { AUTH_TOKEN_STORAGE_KEY } from './core/auth/auth-token.interceptor';
import { DevTokenPage } from './core/auth/dev-token.page';
import { SessionStore } from './core/auth/session.store';
import { LoginPage } from './features/auth/login.page';
import { RegisterPage } from './features/auth/register.page';
import {
  LOGOUT_URL,
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  sessionResponse,
  touchSize,
} from '../testing/auth-fixtures';

@Component({ template: '' })
class StubPage {}

@Component({ template: '<p data-testid="workshop-data">Cliente José Núñez, placa PBA1234</p>' })
class WorkshopDataPage {}

describe('App: barra de sesión (T045)', () => {
  let fixture: ComponentFixture<App>;
  let store: SessionStore;
  let httpMock: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([
          { path: '', pathMatch: 'full', canMatch: [authGuard], component: WorkshopDataPage },
          { path: 'clients', canMatch: [authGuard], component: WorkshopDataPage },
          { path: 'clients/new', canMatch: [authGuard], component: WorkshopDataPage },
          { path: 'change-password', canMatch: [authGuard], component: StubPage },
          { path: 'login', component: StubPage },
        ]),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    store = TestBed.inject(SessionStore);
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  async function render(url = '/clients'): Promise<void> {
    fixture = TestBed.createComponent(App);
    await router.navigateByUrl(url);
    await settle();
  }

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function query(testId: string): HTMLElement | null {
    return root().querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  function text(testId: string): string {
    return query(testId)?.textContent?.trim() ?? '';
  }

  /** Pulsa "Cerrar sesión" (abriendo el menú si hace falta) y devuelve cuántos toques hicieron falta. */
  async function tapLogout(): Promise<number> {
    let taps = 0;
    const toggle = query('session-menu-toggle');
    if (query('logout') === null && toggle !== null) {
      toggle.click();
      taps += 1;
      await settle();
    }
    const button = query('logout');
    if (button === null) throw new Error('No existe [data-testid="logout"]');
    button.click();
    taps += 1;
    await settle();
    return taps;
  }

  function path(): string {
    return router.url.split('?')[0];
  }

  describe('sin sesión', () => {
    it('[FR-010] no muestra usuario, rol, taller ni "Cerrar sesión"', async () => {
      await render('/login');

      for (const testId of ['session-user', 'session-role', 'session-workshop', 'logout', 'session-menu-toggle']) {
        expect(query(testId)).toBeNull();
      }
    });
  });

  describe('con sesión', () => {
    beforeEach(() => {
      store.setSession(sessionResponse({ role: 'admin', name: 'Ana Pérez' }));
    });

    it('[US3-AC3] muestra el nombre, el rol y el taller de la sesión', async () => {
      await render();

      expect(text('session-user')).toBe('Ana Pérez');
      expect(text('session-role')).toBe('Administrador');
      expect(text('session-workshop')).toBe('Taller Andrade');
    });

    it('[US3-AC3] el rol asesor se muestra como "Asesor"', async () => {
      store.setSession(sessionResponse({ role: 'asesor', name: 'Luis Mora' }));
      await render();

      expect(text('session-user')).toBe('Luis Mora');
      expect(text('session-role')).toBe('Asesor');
    });

    it('[US3-AC3][FR-025] "Cerrar sesión" se alcanza en uno o dos toques y mide al menos 44 px', async () => {
      await render();

      const taps = await tapLogout();
      expect(taps).toBeLessThanOrEqual(2);
      httpMock.expectOne(LOGOUT_URL).flush(null, { status: 204, statusText: 'No Content' });
      await settle();
    });

    it('[FR-025] el botón "Cerrar sesión" tiene objetivo táctil de al menos 44 px', async () => {
      await render();
      const toggle = query('session-menu-toggle');
      if (query('logout') === null && toggle !== null) {
        expect(touchSize(toggle)).toBeGreaterThanOrEqual(44);
        toggle.click();
        await settle();
      }

      const button = query('logout');
      expect(button?.textContent?.trim()).toBe('Cerrar sesión');
      expect(touchSize(button as HTMLElement)).toBeGreaterThanOrEqual(44);
    });

    it('[US3-AC3] al cerrar sesión llama a POST /auth/logout, limpia la sesión y va a /login sin datos del taller', async () => {
      await render();
      expect(query('workshop-data')).not.toBeNull();

      await tapLogout();
      const req = httpMock.expectOne(LOGOUT_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.withCredentials).toBe(true);
      expect(req.request.headers.get(REQUESTED_WITH_HEADER)).toBe(REQUESTED_WITH_VALUE);
      req.flush(null, { status: 204, statusText: 'No Content' });
      await vi.waitFor(() => expect(path()).toBe('/login'));
      await settle();

      expect(router.parseUrl(router.url).queryParams['reason']).toBe('logout');
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
      expect(store.isSignedIn()).toBe(false);
      expect(query('session-user')).toBeNull();
      expect(query('session-workshop')).toBeNull();
      expect(query('workshop-data')).toBeNull();
    });

    it('[US3-AC6] si el logout falla (red), igual limpia la sesión y va a /login', async () => {
      await render();

      await tapLogout();
      httpMock.expectOne(LOGOUT_URL).error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
      await vi.waitFor(() => expect(path()).toBe('/login'));

      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
      expect(store.isSignedIn()).toBe(false);
    });

    it('[US3-AC4] tras cerrar sesión, "atrás" a una pantalla del taller lleva a /login sin mostrar datos', async () => {
      await render('/clients');
      await tapLogout();
      httpMock.expectOne(LOGOUT_URL).flush(null, { status: 204, statusText: 'No Content' });
      await vi.waitFor(() => expect(path()).toBe('/login'));

      TestBed.inject(Location).back();
      await settle();
      await vi.waitFor(() => expect(path()).toBe('/login'));
      await settle();

      expect(query('workshop-data')).toBeNull();
      expect(query('session-user')).toBeNull();
    });
  });

  describe('con contraseña temporal pendiente', () => {
    it('[US5-AC1][FR-026] oculta la navegación del taller y deja "Cerrar sesión"', async () => {
      store.setSession(sessionResponse({ role: 'asesor', mustChangePassword: true }));
      await render('/change-password');

      expect(path()).toBe('/change-password');
      expect(root().querySelector('nav[aria-label="Principal"]')).toBeNull();
      expect(query('logout') ?? query('session-menu-toggle')).not.toBeNull();
    });
  });
});

describe('app.routes con sesión (T045)', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    localStorage.clear();
  });

  const WORKSHOP_URLS = [
    '/',
    '/clients',
    '/clients/new',
    '/clients/abc',
    '/clients/abc/edit',
    '/vehicles/new',
    '/vehicles/abc',
    '/vehicles/abc/edit',
    '/change-password',
  ];

  for (const target of WORKSHOP_URLS) {
    it(`[FR-010][US3-AC4] sin sesión, ${target} lleva a /login`, async () => {
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl(target);

      expect(TestBed.inject(Router).url.split('?')[0]).toBe('/login');
    });
  }

  it('[FR-010] /login y /register siguen abiertos sin sesión', async () => {
    const harness = await RouterTestingHarness.create();

    expect(await harness.navigateByUrl('/login')).toBeInstanceOf(LoginPage);
    expect(await harness.navigateByUrl('/register')).toBeInstanceOf(RegisterPage);
  });

  it('[US3] con sesión, /login lleva a /', async () => {
    TestBed.inject(SessionStore).setSession(sessionResponse({ role: 'asesor' }));
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/login');

    expect(TestBed.inject(Router).url).toBe('/');
  });
});

describe('buildRoutes y /dev-token (T045)', () => {
  function find(table: Routes, target: string): Route | undefined {
    return table.find((route) => route.path === target);
  }

  it('[R13] con isDevMode() = false no existe la ruta dev-token', () => {
    expect(find(buildRoutes(false), 'dev-token')).toBeUndefined();
  });

  it('[R13] en desarrollo /dev-token sigue existiendo', () => {
    expect(find(buildRoutes(true), 'dev-token')).toBeDefined();
  });

  it('[US3] las rutas del taller llevan authGuard en canMatch, también fuera de desarrollo', () => {
    const table = buildRoutes(false);
    for (const target of [
      '',
      'clients',
      'clients/new',
      'clients/:id',
      'clients/:id/edit',
      'vehicles/new',
      'vehicles/:id',
      'vehicles/:id/edit',
      'change-password',
    ]) {
      expect(find(table, target)?.canMatch, `ruta "${target}"`).toContain(authGuard);
    }
  });

  it('[FR-010] fuera de desarrollo, /dev-token no abre ninguna pantalla', async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideRouter(buildRoutes(false)), provideHttpClient(), provideHttpClientTesting()],
    });
    const harness = await RouterTestingHarness.create();

    // Sin la ruta, la navegación falla (o una ruta comodín lleva a otra pantalla): nunca abre DevTokenPage.
    const page: unknown = await harness.navigateByUrl('/dev-token').catch(() => null);
    expect(page).not.toBeInstanceOf(DevTokenPage);
    expect(TestBed.inject(Router).url).not.toBe('/dev-token');
  });
});
