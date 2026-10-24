// Revisión del PR3 (002, US4): enlace "Usuarios" de la barra de la app. Archivo nuevo: app.spec.ts y
// app.session.spec.ts no cambian.
//
// Contrato para el implementer-frontend:
//   app.html: el enlace "Usuarios" (a[href="/users"] dentro de nav[aria-label="Principal"]) solo existe con una
//   sesión de rol admin, según SessionStore (respuestas del servidor, nunca el JWT). Nunca para asesor ni sin sesión.
//   user-detail.page: si el administrador se quita a sí mismo el rol (PUT /users/{su id}/role → role asesor), el
//   rol de la sesión se actualiza sin recargar (por ejemplo con la cuenta devuelta o pidiendo GET /auth/me), de modo
//   que el enlace desaparece en esa misma pantalla (US4-AC5, US4-AC11, caso borde "Administrador que se quita el
//   rol a sí mismo"). Puede además navegar a / si lo cree oportuno.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';
import type { UserAccount } from './core/api/api.models';
import { adminGuard, authGuard } from './core/auth/auth.guards';
import { AUTH_TOKEN_STORAGE_KEY } from './core/auth/auth-token.interceptor';
import { SessionStore } from './core/auth/session.store';
import { UserDetailPage } from './features/users/user-detail.page';
import { ADMIN_USER_ID, currentSession, ME_URL, sessionResponse } from '../testing/auth-fixtures';
import { tokenFor } from '../testing/fake-jwt';

@Component({ template: '<p data-testid="workshop-data">Datos del taller</p>' })
class WorkshopDataPage {}

const USERS_URL = '/api/v1/users';

const OWN_ACCOUNT: UserAccount = {
  id: ADMIN_USER_ID,
  name: 'Ana Pérez',
  email: 'ana.perez@taller.ec',
  role: 'admin',
  status: 'active',
  mustChangePassword: false,
  temporaryPasswordExpiresAt: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
  updatedByName: 'Ana Pérez',
};

describe('App: enlace "Usuarios" (revisión PR3)', () => {
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
          { path: 'login', component: WorkshopDataPage },
          { path: 'users/:id', canMatch: [authGuard, adminGuard], component: UserDetailPage },
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

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function render(url: string): Promise<void> {
    fixture = TestBed.createComponent(App);
    await router.navigateByUrl(url);
    await settle();
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function usersLink(): HTMLAnchorElement | null {
    const links = Array.from(root().querySelectorAll<HTMLAnchorElement>('header a'));
    return links.find((a) => a.getAttribute('href') === '/users' || a.textContent?.trim() === 'Usuarios') ?? null;
  }

  function byTestId(testId: string): HTMLElement {
    const element = root().querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (element === null) throw new Error(`No existe [data-testid="${testId}"]`);
    return element;
  }

  it('[US4-AC16] con sesión de admin, la barra muestra "Usuarios" hacia /users', async () => {
    store.setSession(sessionResponse({ role: 'admin' }));
    await render('/clients');

    const link = usersLink();
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/users');
    expect(link?.textContent?.trim()).toBe('Usuarios');
  });

  it('[US4-AC16] con sesión de asesor, la barra no muestra "Usuarios"', async () => {
    store.setSession(sessionResponse({ role: 'asesor', name: 'Luis Mora' }));
    await render('/clients');

    expect(usersLink()).toBeNull();
  });

  it('[US4-AC16] sin sesión, la barra no muestra "Usuarios"', async () => {
    await render('/login');

    expect(usersLink()).toBeNull();
  });

  it('[US4-AC16] con un token de admin guardado pero /auth/me de asesor, no muestra "Usuarios"', async () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, tokenFor('admin'));
    fixture = TestBed.createComponent(App);
    const navigation = router.navigateByUrl('/clients');
    const req = await vi.waitFor(() => httpMock.expectOne(ME_URL));
    req.flush(currentSession({ role: 'asesor' }));
    await navigation;
    await settle();

    expect(usersLink()).toBeNull();
  });

  it('[US4-AC11][US4-AC5] si el admin se quita a sí mismo el rol, "Usuarios" desaparece sin recargar', async () => {
    store.setSession(sessionResponse({ role: 'admin', id: ADMIN_USER_ID }));
    await render(`/users/${ADMIN_USER_ID}`);

    httpMock.expectOne(`${USERS_URL}/${ADMIN_USER_ID}`).flush(OWN_ACCOUNT);
    await settle();
    httpMock.match(`${USERS_URL}/${ADMIN_USER_ID}/history`).forEach((r) => r.flush({ items: [] }));
    await settle();
    expect(usersLink()).not.toBeNull();

    byTestId('change-role-button').click();
    await settle();
    byTestId('confirm-change-role-button').click();
    await settle();

    const put = httpMock.expectOne(`${USERS_URL}/${ADMIN_USER_ID}/role`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ role: 'asesor' });
    put.flush({ ...OWN_ACCOUNT, role: 'asesor', updatedAt: '2026-10-24T12:00:00.000Z' });
    await settle();
    await drainFollowUps();

    expect(store.user()?.role).toBe('asesor');
    expect(usersLink()).toBeNull();
  });

  /**
   * Responde, como lo haría el servidor tras el cambio, las peticiones que la pantalla haga después: /auth/me de
   * asesor, historial vacío, la cuenta ya como asesor y 403 FORBIDDEN para el listado.
   */
  async function drainFollowUps(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      const pending: TestRequest[] = httpMock.match(() => true);
      if (pending.length === 0) {
        await settle();
        if (httpMock.match(() => true).length === 0) return;
        continue;
      }
      for (const req of pending) {
        const path = req.request.url;
        if (path === ME_URL) {
          req.flush(currentSession({ role: 'asesor', id: ADMIN_USER_ID }));
        } else if (path.endsWith('/history')) {
          req.flush({ items: [] });
        } else if (path === `${USERS_URL}/${ADMIN_USER_ID}`) {
          req.flush({ ...OWN_ACCOUNT, role: 'asesor' });
        } else {
          req.flush(
            { type: 'about:blank', title: 'Error', status: 403, code: 'FORBIDDEN' },
            { status: 403, statusText: 'Forbidden', headers: { 'Content-Type': 'application/problem+json' } },
          );
        }
      }
      await settle();
    }
  }
});
