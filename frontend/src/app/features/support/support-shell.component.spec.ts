// T039 (003, PR1, US2): cabecera y contenedor del panel de soporte (SupportShellComponent).
//
// Contrato para el implementer-frontend (T040), archivo features/support/support-shell.component.ts (+ .html y .scss):
//   export class SupportShellComponent (standalone).
//   Selectores (data-testid):
//     support-header         <header> propio del panel con el título "Soporte MotorSync" (SUPPORT_MESSAGES.PANEL_HEADER)
//     support-agent-name     nombre del agente en sesión (SupportSessionStore.agent()?.name)
//     support-logout         <button type="button"> "Cerrar sesión" (min-height >= 44 px, FR-026)
//   Incluye <router-outlet /> para las páginas hijas del panel.
//   US2-AC9: al pulsar `support-logout`:
//     - llama a SupportApiService.logout() (POST /api/v1/support/auth/logout con withCredentials y X-Requested-With: motorsync);
//     - al completarse o fallar (idempotente), ejecuta SupportSessionStore.clear() (sin tocar SessionStore ni
//       'motorsync.token' del taller) y navega a `/support/login` (o `/support/login?reason=logout`).
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  REQUESTED_WITH_HEADER,
  REQUESTED_WITH_VALUE,
  sessionResponse,
  touchSize,
} from '../../../testing/auth-fixtures';
import {
  SUPPORT_LOGOUT_URL,
  SUPPORT_MESSAGES,
  SUPPORT_TOKEN_STORAGE_KEY,
  supportSessionResponse,
} from '../../../testing/support-fixtures';
import { AUTH_TOKEN_STORAGE_KEY } from '../../core/auth/auth-token.interceptor';
import { SessionStore } from '../../core/auth/session.store';
import { SupportSessionStore } from '../../core/support/support-session.store';
import { SupportShellComponent } from './support-shell.component';

@Component({ template: '<p data-testid="child-view">Contenido del panel</p>' })
class StubChildPage {}

@Component({ template: '<p data-testid="login-view">Login de soporte</p>' })
class StubLoginPage {}

describe('SupportShellComponent (T039)', () => {
  let fixture: ComponentFixture<SupportShellComponent>;
  let httpMock: HttpTestingController;
  let supportStore: SupportSessionStore;
  let workshopStore: SessionStore;
  let router: Router;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [SupportShellComponent],
      providers: [
        provideRouter([
          {
            path: 'support',
            component: SupportShellComponent,
            children: [{ path: '', component: StubChildPage }],
          },
          { path: 'support/login', component: StubLoginPage },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    supportStore = TestBed.inject(SupportSessionStore);
    workshopStore = TestBed.inject(SessionStore);
    router = TestBed.inject(Router);
    supportStore.setSession(supportSessionResponse({ name: 'Pedro Soporte' }));
    fixture = TestBed.createComponent(SupportShellComponent);
    await router.navigateByUrl('/support');
    await settle();
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

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return root().querySelector<T>(`[data-testid="${testId}"]`);
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = query<T>(testId);
    if (element === null) throw new Error(`No existe [data-testid="${testId}"]`);
    return element;
  }

  function path(): string {
    return router.url.split('?')[0];
  }

  it('[US2-AC3][FR-026] muestra la cabecera "Soporte MotorSync", el nombre del agente y el botón "Cerrar sesión" (>= 44 px)', () => {
    const header = get('support-header');
    expect(header.textContent).toContain(SUPPORT_MESSAGES.PANEL_HEADER);
    expect(get('support-agent-name').textContent?.trim()).toBe('Pedro Soporte');

    const logoutBtn = get<HTMLButtonElement>('support-logout');
    expect(logoutBtn.textContent?.trim()).toBe('Cerrar sesión');
    expect(touchSize(logoutBtn)).toBeGreaterThanOrEqual(44);
    expect(root().querySelector('router-outlet')).not.toBeNull();
  });

  it('[US2-AC9] al pulsar "Cerrar sesión" llama a POST /api/v1/support/auth/logout, limpia SupportSessionStore (sin tocar la sesión del taller) y navega a /support/login', async () => {
    workshopStore.setSession(sessionResponse({ role: 'admin', name: 'Ana Pérez' }));

    get('support-logout').click();
    await settle();

    const req = httpMock.expectOne(SUPPORT_LOGOUT_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.headers.get(REQUESTED_WITH_HEADER)).toBe(REQUESTED_WITH_VALUE);
    req.flush(null, { status: 204, statusText: 'No Content' });

    await vi.waitFor(() => expect(path()).toBe('/support/login'));
    expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
    expect(supportStore.isSignedIn()).toBe(false);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).not.toBeNull();
    expect(workshopStore.isSignedIn()).toBe(true);
  });

  it('[US2-AC9] si POST /support/auth/logout falla en la red, igualmente limpia la sesión de soporte y navega a /support/login', async () => {
    get('support-logout').click();
    await settle();

    httpMock.expectOne(SUPPORT_LOGOUT_URL).error(new ProgressEvent('error'), {
      status: 0,
      statusText: 'Unknown Error',
    });

    await vi.waitFor(() => expect(path()).toBe('/support/login'));
    expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
    expect(supportStore.isSignedIn()).toBe(false);
  });
});
