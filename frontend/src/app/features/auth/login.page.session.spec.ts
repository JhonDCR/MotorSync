// T045 (002, PR2, US3, US5): la página de login con la sesión real. Archivo nuevo: login.page.spec.ts del PR1 no cambia.
//
// Contrato para el implementer-frontend (T046), archivo features/auth/login.page.ts (+ .html):
//   - Motivo de llegada: query `reason` de /login. La página muestra el mensaje en
//       data-testid="session-reason" (role="status"):
//         expired            "Su sesión expiró por inactividad"                       (US3-AC2, literal de spec.md)
//         revoked            "Su sesión fue cerrada. Vuelva a iniciar sesión"          (US3-AC4)
//         logout             "Cerró su sesión"                                         (US3-AC3)
//         temporary-expired  "Su contraseña temporal venció. Pida al administrador de su taller que la restablezca o use
//                             ¿Olvidaste tu contraseña?"
//                                                                                     (US5-AC9; FR-022 de la 003)
//       Sin `reason` o con un valor desconocido no se muestra nada (el texto del query nunca se pinta tal cual).
//   - Al entrar (200): SessionStore.setSession(respuesta) (session.store.ts), que guarda el token y llena el store.
//   - Destino tras entrar: `/change-password` si user.mustChangePassword; si no, `returnUrl` del query cuando es una
//       ruta interna (empieza por "/" y no por "//" ni contiene "://"); en otro caso `/`.
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of } from 'rxjs';
import { AuthApiService } from '../../core/api/auth-api.service';
import { AUTH_TOKEN_STORAGE_KEY } from '../../core/auth/auth-token.interceptor';
import { SessionStore } from '../../core/auth/session.store';
import { LOGIN_REASON_MESSAGES, PASSWORD, sessionResponse, type LoginReason } from '../../../testing/auth-fixtures';
import { LoginPage } from './login.page';

@Component({ template: '' })
class StubPage {}

describe('LoginPage con sesión (T045)', () => {
  let harness: RouterTestingHarness;
  let api: { login: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    localStorage.clear();
    api = { login: vi.fn(() => of(sessionResponse({ role: 'asesor', name: 'Luis Mora' }))) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: StubPage },
          { path: 'login', component: LoginPage },
          { path: 'clients', component: StubPage },
          { path: 'change-password', component: StubPage },
        ]),
        { provide: AuthApiService, useValue: api },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    localStorage.clear();
  });

  function root(): HTMLElement {
    return harness.routeNativeElement as HTMLElement;
  }

  function query(testId: string): HTMLElement | null {
    return root().querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  function get(testId: string): HTMLElement {
    const element = query(testId);
    if (element === null) throw new Error(`No existe [data-testid="${testId}"]`);
    return element;
  }

  async function open(url: string): Promise<void> {
    await harness.navigateByUrl(url);
    harness.detectChanges();
    await harness.fixture.whenStable();
  }

  async function signIn(): Promise<void> {
    const type = (testId: string, value: string): void => {
      const input = get(testId) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    type('email', 'luis.mora@taller.ec');
    type('password', PASSWORD);
    harness.detectChanges();
    get('submit').click();
    harness.detectChanges();
    await harness.fixture.whenStable();
  }

  function url(): string {
    return TestBed.inject(Router).url;
  }

  describe('motivo de llegada', () => {
    const cases: [LoginReason, string][] = [
      ['expired', '[US3-AC2]'],
      ['revoked', '[US3-AC4]'],
      ['logout', '[US3-AC3]'],
      ['temporary-expired', '[US5-AC9]'],
    ];

    for (const [reason, id] of cases) {
      it(`${id} /login?reason=${reason} muestra "${LOGIN_REASON_MESSAGES[reason]}"`, async () => {
        await open(`/login?reason=${reason}`);

        const message = get('session-reason');
        expect(message.textContent?.trim()).toBe(LOGIN_REASON_MESSAGES[reason]);
        expect(message.getAttribute('role')).toBe('status');
      });
    }

    it('[US3] sin reason no muestra ningún aviso de sesión', async () => {
      await open('/login');

      expect(query('session-reason')).toBeNull();
    });

    it('[US3] un reason desconocido no muestra nada ni pinta el texto del query', async () => {
      await open('/login?reason=%3Cb%3Ehola%3C%2Fb%3E');

      expect(query('session-reason')).toBeNull();
      expect(root().textContent).not.toContain('hola');
    });
  });

  describe('al entrar', () => {
    it('[US3] llena el SessionStore con la respuesta del login y guarda el token', async () => {
      await open('/login');
      await signIn();

      const store = TestBed.inject(SessionStore);
      await vi.waitFor(() => expect(store.isSignedIn()).toBe(true));
      expect(store.user()?.name).toBe('Luis Mora');
      expect(store.user()?.role).toBe('asesor');
      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).not.toBeNull();
    });

    it('[FR-010] vuelve a la ruta interna de returnUrl', async () => {
      await open('/login?returnUrl=%2Fclients');
      await signIn();

      await vi.waitFor(() => expect(url()).toBe('/clients'));
    });

    it('[FR-010] un returnUrl externo se ignora y va a /', async () => {
      for (const target of ['//evil.example/x', 'https://evil.example/x']) {
        TestBed.inject(SessionStore).clear();
        await open(`/login?returnUrl=${encodeURIComponent(target)}`);
        await signIn();

        await vi.waitFor(() => expect(url()).toBe('/'));
      }
    });

    it('[US5-AC1] con contraseña temporal va a /change-password aunque haya returnUrl', async () => {
      api.login.mockReturnValueOnce(of(sessionResponse({ role: 'asesor', mustChangePassword: true })));
      await open('/login?returnUrl=%2Fclients');
      await signIn();

      await vi.waitFor(() => expect(url()).toBe('/change-password'));
      expect(TestBed.inject(SessionStore).mustChangePassword()).toBe(true);
    });
  });
});
