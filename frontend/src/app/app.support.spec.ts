// T039 (003, PR1, US2): separación de zonas en App y rutas diferidas de /support/** (research R13, US2-AC5, US2-AC6, FR-026).
//
// Contrato para el implementer-frontend (T040):
//   1. `app.ts` / `app.html`:
//      - En cualquier ruta bajo `/support` (`/support`, `/support/login`, `/support/change-password`, `/support/tickets/:id`, etc.),
//        NO se muestra el `<header class="app-header">` del taller (`nav[aria-label="Principal"]`, `session-user`,
//        `session-workshop`, `logout` del taller), aunque exista una sesión de taller en SessionStore.
//      - El panel renderiza su propio encabezado a través de `SupportShellComponent`.
//   2. `app.routes.ts` (`buildRoutes`):
//      - Las rutas de `/support/**` se cargan de forma diferida (`loadComponent` o `loadChildren`).
//      - `/support/login` usa `supportGuestGuard` (carga diferida de `SupportLoginPage`).
//      - `/support/change-password` usa `supportAuthGuard` (carga diferida de `SupportChangePasswordPage`).
//      - `/support` y `/support/tickets/:id` usan `supportAuthGuard` bajo `SupportShellComponent` (carga diferida de
//        `TicketsInboxPage` y `TicketDetailPage`).
//      - US2-AC5: con sesión activa de taller (`SessionStore`), navegar a `/support` redirige a `/support/login`.
//      - US2-AC6: con sesión activa de soporte (`SupportSessionStore`), navegar a `/` redirige a `/login`.
//      - FR-026: objetivos táctiles de al menos 44 px en el panel.
import { provideLocationMocks } from '@angular/common/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Route } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { sessionResponse, touchSize } from '../testing/auth-fixtures';
import {
  SUPPORT_TICKETS_URL,
  supportSessionResponse,
  TICKET_ID,
} from '../testing/support-fixtures';
import { App } from './app';
import { buildRoutes, routes } from './app.routes';
import { SessionStore } from './core/auth/session.store';
import { SupportSessionStore } from './core/support/support-session.store';

describe('App y rutas de /support/** (T039)', () => {
  let httpMock: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter(routes),
        provideLocationMocks(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  async function renderAppAt(url: string): Promise<ComponentFixture<App>> {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    await router.navigateByUrl(url);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  function path(): string {
    return TestBed.inject(Router).url.split('?')[0];
  }

  it('[US2-AC5][R13] en /support/** NO se muestra la cabecera ni la navegación del taller, aunque exista sesión de taller', async () => {
    TestBed.inject(SessionStore).setSession(sessionResponse({ role: 'admin', name: 'Ana Pérez' }));
    TestBed.inject(SupportSessionStore).setSession(supportSessionResponse({ name: 'Pedro Soporte' }));

    const fixture = await renderAppAt('/support');
    const pendingTickets = httpMock.match(SUPPORT_TICKETS_URL);
    for (const req of pendingTickets) {
      req.flush({ items: [] });
    }
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('header.app-header')).toBeNull();
    expect(root.querySelector('nav[aria-label="Principal"]')).toBeNull();
    expect(root.querySelector('[data-testid="session-workshop"]')).toBeNull();
    expect(root.querySelector('[data-testid="support-header"]')).not.toBeNull();
  });

  it('[US2-AC5] con sesión de taller (y sin sesión de soporte), navegar a /support o /support/tickets/:id redirige a /support/login', async () => {
    TestBed.inject(SessionStore).setSession(sessionResponse({ role: 'admin', name: 'Ana Pérez' }));
    const harness = await RouterTestingHarness.create();

    await harness.navigateByUrl('/support');
    expect(path()).toBe('/support/login');

    await harness.navigateByUrl(`/support/tickets/${TICKET_ID}`);
    expect(path()).toBe('/support/login');
  });

  it('[US2-AC6] con sesión de soporte (y sin sesión de taller), navegar a /, /clients o /users redirige a /login', async () => {
    TestBed.inject(SupportSessionStore).setSession(supportSessionResponse({ name: 'Pedro Soporte' }));
    const harness = await RouterTestingHarness.create();

    for (const target of ['/', '/clients', '/users']) {
      await harness.navigateByUrl(target);
      expect(path()).toBe('/login');
    }
  });

  it('[R13] las rutas de /support en buildRoutes se cargan de forma diferida (loadComponent o loadChildren)', () => {
    const table = buildRoutes(false);
    const supportEntries = table.filter((r: Route) => r.path === 'support' || r.path?.startsWith('support/'));
    expect(supportEntries.length).toBeGreaterThan(0);

    for (const entry of supportEntries) {
      const isLazy =
        typeof entry.loadComponent === 'function' ||
        typeof entry.loadChildren === 'function' ||
        (Array.isArray(entry.children) &&
          entry.children.every((child) => typeof child.loadComponent === 'function' || typeof child.loadChildren === 'function'));
      expect(isLazy, `ruta "${entry.path}" debe ser diferida`).toBe(true);
    }
  });

  it('[FR-026] en /support con sesión de soporte los controles interactivos de la cabecera miden al menos 44 px', async () => {
    TestBed.inject(SupportSessionStore).setSession(supportSessionResponse({ name: 'Pedro Soporte' }));

    const fixture = await renderAppAt('/support');
    for (const req of httpMock.match(SUPPORT_TICKETS_URL)) {
      req.flush({ items: [] });
    }
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const logoutBtn = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '[data-testid="support-logout"]',
    );
    expect(logoutBtn).not.toBeNull();
    expect(touchSize(logoutBtn!)).toBeGreaterThanOrEqual(44);
  });
});
