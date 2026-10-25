// T037 (003, PR1, US2): guards de las rutas de soporte (/support/**) (research R4, R13).
//
// Contrato para el implementer-frontend (T038), archivo core/support/support.guards.ts:
//   export const SUPPORT_LOGIN_PATH = '/support/login';
//   export const SUPPORT_CHANGE_PASSWORD_PATH = '/support/change-password';
//   export const supportAuthGuard: CanMatchFn & CanActivateFn
//     - usa SupportSessionStore.restore() (support-session.store.ts).
//     - sin sesión de soporte → UrlTree `/support/login` (con `returnUrl` si procede), aunque exista una sesión
//       activa de taller en SessionStore (US2-AC5, FR-008).
//     - con sesión de soporte y mustChangePassword() === true → solo deja pasar `/support/change-password`;
//       cualquier otra ruta `/support/**` redirige a `/support/change-password` (US2-AC4).
//     - con sesión de soporte normal → true.
//   export const supportGuestGuard: CanMatchFn & CanActivateFn
//     - para `/support/login`: con sesión de soporte → UrlTree `/support`; sin sesión de soporte → true (aunque
//       exista sesión de taller).
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ME_URL, problemFlush, sessionResponse } from '../../../testing/auth-fixtures';
import {
  currentSupportSession,
  SUPPORT_ME_URL,
  SUPPORT_TOKEN_STORAGE_KEY,
  supportProblem,
  supportSessionResponse,
  supportSessionToken,
  TICKET_ID,
} from '../../../testing/support-fixtures';
import { AUTH_TOKEN_STORAGE_KEY } from '../auth/auth-token.interceptor';
import { SessionStore } from '../auth/session.store';
import { SupportSessionStore } from './support-session.store';
import { supportAuthGuard, supportGuestGuard } from './support.guards';

@Component({ template: '<p data-testid="support-login">Acceso de soporte</p>' })
class StubSupportLoginPage {}

@Component({ template: '<p data-testid="support-change-password">Cambio obligatorio soporte</p>' })
class StubSupportChangePasswordPage {}

@Component({ template: '<p data-testid="support-panel">Bandeja de soporte</p>' })
class StubSupportPanelPage {}

const ROUTES: Routes = [
  { path: 'support/login', canMatch: [supportGuestGuard], component: StubSupportLoginPage },
  { path: 'support/change-password', canMatch: [supportAuthGuard], component: StubSupportChangePasswordPage },
  { path: 'support', canMatch: [supportAuthGuard], component: StubSupportPanelPage },
  { path: 'support/tickets/:id', canMatch: [supportAuthGuard], component: StubSupportPanelPage },
];

describe('support.guards (T037)', () => {
  let harness: RouterTestingHarness;
  let httpMock: HttpTestingController;
  let supportStore: SupportSessionStore;
  let workshopStore: SessionStore;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideRouter(ROUTES), provideHttpClient(), provideHttpClientTesting()],
    });
    httpMock = TestBed.inject(HttpTestingController);
    supportStore = TestBed.inject(SupportSessionStore);
    workshopStore = TestBed.inject(SessionStore);
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

  function shows(testId: string): boolean {
    return (harness.routeNativeElement as HTMLElement | null)?.querySelector(`[data-testid="${testId}"]`) != null;
  }

  describe('supportAuthGuard', () => {
    it('[US2-AC5][FR-008] sin sesión de soporte, /support lleva a /support/login y no muestra el panel', async () => {
      await harness.navigateByUrl('/support');

      expect(path()).toBe('/support/login');
      expect(shows('support-panel')).toBe(false);
    });

    it('[US2-AC5][FR-008] una sesión activa de taller (admin o asesor) NO permite entrar a /support ni /support/tickets/:id: redirige a /support/login', async () => {
      workshopStore.setSession(sessionResponse({ role: 'admin', name: 'Ana Pérez' }));
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).not.toBeNull();

      await harness.navigateByUrl(`/support/tickets/${TICKET_ID}`);

      expect(path()).toBe('/support/login');
      expect(shows('support-panel')).toBe(false);
      httpMock.expectNone(SUPPORT_ME_URL);
      httpMock.expectNone(ME_URL);
    });

    it('[US2-AC1] con sesión de soporte en el store deja abrir /support y /support/tickets/:id sin pedir /support/auth/me', async () => {
      supportStore.setSession(supportSessionResponse());

      await harness.navigateByUrl(`/support/tickets/${TICKET_ID}`);

      expect(url()).toBe(`/support/tickets/${TICKET_ID}`);
      expect(shows('support-panel')).toBe(true);
      httpMock.expectNone(SUPPORT_ME_URL);
    });

    it('[US2-AC1] con motorsync.support.token guardado y sin datos (recarga) pide /support/auth/me y deja pasar', async () => {
      localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, supportSessionToken('Nombre Del Token'));

      const navigation = harness.navigateByUrl('/support');
      const req = await vi.waitFor(() => httpMock.expectOne(SUPPORT_ME_URL));
      req.flush(currentSupportSession({ name: 'Pedro Soporte' }));
      await navigation;

      expect(url()).toBe('/support');
      expect(supportStore.agent()?.name).toBe('Pedro Soporte');
      expect(shows('support-panel')).toBe(true);
    });

    it('[US2-AC3] si /support/auth/me rechaza el token guardado (401), lleva a /support/login y lo borra', async () => {
      localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, supportSessionToken());

      const navigation = harness.navigateByUrl('/support');
      const req = await vi.waitFor(() => httpMock.expectOne(SUPPORT_ME_URL));
      req.flush(supportProblem(401, 'SESSION_REVOKED'), problemFlush(401));
      await navigation;

      expect(path()).toBe('/support/login');
      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
      expect(shows('support-panel')).toBe(false);
    });

    describe('con contraseña temporal pendiente (mustChangePassword)', () => {
      beforeEach(() => {
        supportStore.setSession(supportSessionResponse({ mustChangePassword: true }));
      });

      it('[US2-AC4] /support redirige a /support/change-password sin mostrar el panel', async () => {
        await harness.navigateByUrl('/support');

        expect(path()).toBe('/support/change-password');
        expect(shows('support-panel')).toBe(false);
      });

      it('[US2-AC4] /support/tickets/:id redirige a /support/change-password', async () => {
        await harness.navigateByUrl(`/support/tickets/${TICKET_ID}`);

        expect(path()).toBe('/support/change-password');
        expect(shows('support-panel')).toBe(false);
      });

      it('[US2-AC4] /support/change-password sí se puede abrir', async () => {
        await harness.navigateByUrl('/support/change-password');

        expect(url()).toBe('/support/change-password');
        expect(shows('support-change-password')).toBe(true);
      });

      it('[US2-AC4] mustChangePassword que llega por /support/auth/me también obliga a /support/change-password', async () => {
        supportStore.clear();
        localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, supportSessionToken());

        const navigation = harness.navigateByUrl('/support');
        const req = await vi.waitFor(() => httpMock.expectOne(SUPPORT_ME_URL));
        req.flush(currentSupportSession({ mustChangePassword: true }));
        await navigation;

        expect(path()).toBe('/support/change-password');
      });
    });

    it('[US2-AC5] sin sesión de soporte, /support/change-password lleva a /support/login', async () => {
      await harness.navigateByUrl('/support/change-password');

      expect(path()).toBe('/support/login');
    });
  });

  describe('supportGuestGuard', () => {
    it('[US2-AC1] sin sesión de soporte, /support/login se abre (aunque haya sesión de taller)', async () => {
      workshopStore.setSession(sessionResponse({ role: 'admin' }));

      await harness.navigateByUrl('/support/login');

      expect(url()).toBe('/support/login');
      expect(shows('support-login')).toBe(true);
    });

    it('[US2-AC1] con sesión de soporte, /support/login redirige a /support', async () => {
      supportStore.setSession(supportSessionResponse());

      await harness.navigateByUrl('/support/login');

      expect(url()).toBe('/support');
      expect(shows('support-panel')).toBe(true);
    });
  });
});
