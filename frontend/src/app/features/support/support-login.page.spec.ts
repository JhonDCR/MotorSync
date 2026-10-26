// T039 (003, PR1, US2): página de inicio de sesión del panel de soporte (/support/login).
//
// Contrato para el implementer-frontend (T040), archivo features/support/support-login.page.ts (+ .html y .scss):
//   export class SupportLoginPage (standalone). Ruta `/support/login` con `canMatch: [supportGuestGuard]`,
//   title "Acceso de soporte".
//   Usa SupportApiService.login(body: SupportLoginRequest) y SupportSessionStore (support-session.store.ts).
//   Al entrar (200 SupportSessionResponse):
//     - llama a SupportSessionStore.setSession(respuesta) (guarda accessToken en 'motorsync.support.token',
//       NUNCA en 'motorsync.token' ni en SessionStore del taller);
//     - si respuesta.agent.mustChangePassword es true → navega a `/support/change-password` (US2-AC1, FR-009);
//     - si es false → navega a `returnUrl` cuando es una ruta interna de `/support` (empieza por "/support" y no por
//       "//"), o a `/support` por defecto (US2-AC3).
//   Selectores (data-testid), cada <input> con su <label for> y texto visible:
//     email                  <input type="email"> del correo
//     password               <input type="password"> de la contraseña
//     submit                 <button type="submit"> "Iniciar sesión"
//     error-email, error-password   "Este campo es obligatorio" si están vacíos al enviar (no llama a login);
//                                   el <input> con error lleva aria-invalid="true". El correo vacío o solo espacios
//                                   cuenta como vacío y se normaliza (trim + minúsculas) al enviar; la contraseña
//                                   NUNCA se recorta.
//     form-error             mensaje general (role="alert"):
//       401 INVALID_CREDENTIALS          "Correo o contraseña incorrectos" (US2-AC3)
//       429 ACCOUNT_LOCKED               "Demasiados intentos fallidos. Intente de nuevo en unos minutos" (US2-AC3, FR-009)
//       401 TEMPORARY_PASSWORD_EXPIRED   mensaje de AUTH_MESSAGES.TEMPORARY_PASSWORD_EXPIRED (FR-009)
//       fallo de red (status 0)          mensaje no vacío.
//     session-reason         aviso (role="status") cuando llega con `?reason=expired|revoked|logout|temporary-expired`
//                            (textos de SUPPORT_LOGIN_REASON_MESSAGES; US2-AC9). Sin reason o con valor desconocido
//                            no muestra nada.
//   US2-AC4 / FR-010 / FR-007: el formulario SOLO tiene los campos `email` y `password` (sin segundo factor, sin taller,
//   sin enlace de registro ni "¿Olvidaste tu contraseña?", porque las cuentas de soporte se gestionan por operaciones).
//   FR-026: campos y botón con min-height >= 44 px.
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import {
  AUTH_MESSAGES,
  touchSize,
} from '../../../testing/auth-fixtures';
import {
  SUPPORT_EMAIL,
  SUPPORT_LOGIN_REASON_MESSAGES,
  SUPPORT_PASSWORD,
  SUPPORT_TOKEN_STORAGE_KEY,
  supportProblem,
  supportSessionResponse,
  type SupportLoginReason,
  type SupportLoginRequestFixture,
} from '../../../testing/support-fixtures';
import { SupportApiService } from '../../core/api/support-api.service';
import { AUTH_TOKEN_STORAGE_KEY } from '../../core/auth/auth-token.interceptor';
import { SessionStore } from '../../core/auth/session.store';
import { SupportSessionStore } from '../../core/support/support-session.store';
import { SupportLoginPage } from './support-login.page';

@Component({ template: '' })
class StubPage {}

const REQUIRED_MESSAGE = 'Este campo es obligatorio';

describe('SupportLoginPage (T039)', () => {
  let harness: RouterTestingHarness;
  let api: { login: ReturnType<typeof vi.fn<SupportApiService['login']>> };

  beforeEach(async () => {
    localStorage.clear();
    api = {
      login: vi.fn<SupportApiService['login']>(() => of(supportSessionResponse())),
    };
    await TestBed.configureTestingModule({
      imports: [SupportLoginPage],
      providers: [
        provideRouter([
          { path: 'support/login', component: SupportLoginPage },
          { path: 'support/change-password', component: StubPage },
          { path: 'support/tickets/:id', component: StubPage },
          { path: 'support', component: StubPage },
        ]),
        { provide: SupportApiService, useValue: api },
      ],
    }).compileComponents();
    harness = await RouterTestingHarness.create();
    await open('/support/login');
  });

  afterEach(() => {
    localStorage.clear();
  });

  async function settle(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  async function open(url: string): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
  }

  function root(): HTMLElement {
    return harness.routeNativeElement as HTMLElement;
  }

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return root().querySelector<T>(`[data-testid="${testId}"]`);
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = query<T>(testId);
    if (element === null) {
      throw new Error(`No existe [data-testid="${testId}"]`);
    }
    return element;
  }

  function text(testId: string): string {
    return get(testId).textContent?.trim() ?? '';
  }

  async function type(testId: string, value: string): Promise<void> {
    const input = get<HTMLInputElement>(testId);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function signIn(email = `  ${SUPPORT_EMAIL.toUpperCase()} `, password = SUPPORT_PASSWORD): Promise<void> {
    await type('email', email);
    await type('password', password);
    get('submit').click();
    await settle();
  }

  function sentBody(call = 0): SupportLoginRequestFixture {
    return api.login.mock.calls[call][0] as SupportLoginRequestFixture;
  }

  function currentUrl(): string {
    return TestBed.inject(Router).url;
  }

  it('[US2-AC4][FR-010][FR-007] solo exige correo y contraseña con label visible, sin segundo factor ni enlace de autoregistro', () => {
    const inputs = Array.from(root().querySelectorAll('input, select, textarea'));
    expect(inputs.map((input) => input.getAttribute('data-testid')).sort()).toEqual(['email', 'password']);

    for (const testId of ['email', 'password']) {
      const input = get<HTMLInputElement>(testId);
      expect(input.labels?.length ?? 0).toBeGreaterThan(0);
      expect(input.labels?.[0].textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
    expect(get<HTMLInputElement>('password').type).toBe('password');
    expect(root().querySelector('a[href="/register"]')).toBeNull();
  });

  it('[US2-AC3][FR-008] al iniciar sesión guarda la sesión en SupportSessionStore (motorsync.support.token), nunca en SessionStore, y navega a /support', async () => {
    const session = supportSessionResponse({ name: 'Pedro Soporte', mustChangePassword: false });
    api.login.mockReturnValueOnce(of(session));

    await signIn();

    expect(api.login).toHaveBeenCalledTimes(1);
    expect(sentBody()).toEqual({ email: SUPPORT_EMAIL, password: SUPPORT_PASSWORD });
    expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBe(session.accessToken);
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBeNull();
    expect(TestBed.inject(SupportSessionStore).agent()?.name).toBe('Pedro Soporte');
    expect(TestBed.inject(SessionStore).isSignedIn()).toBe(false);
    expect(currentUrl()).toBe('/support');
  });

  it('[US2-AC1][FR-009] si la cuenta tiene contraseña temporal pendiente (mustChangePassword: true), navega a /support/change-password', async () => {
    const session = supportSessionResponse({ mustChangePassword: true });
    api.login.mockReturnValueOnce(of(session));

    await signIn();

    expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBe(session.accessToken);
    expect(currentUrl()).toBe('/support/change-password');
  });

  it('[US2-AC3][FR-009] 401 INVALID_CREDENTIALS muestra "Correo o contraseña incorrectos" sin distinguir correo inexistente, clave errónea o cuenta desactivada', async () => {
    const variants = [
      supportProblem(401, 'INVALID_CREDENTIALS', { detail: 'El correo no existe' }),
      supportProblem(401, 'INVALID_CREDENTIALS', { detail: 'Contraseña incorrecta' }),
      supportProblem(401, 'INVALID_CREDENTIALS', { detail: 'Cuenta desactivada' }),
    ];

    for (const problem of variants) {
      api.login.mockReturnValueOnce(throwError(() => problem));
      await signIn();

      expect(text('form-error')).toBe(AUTH_MESSAGES.INVALID_CREDENTIALS);
      expect(get('form-error').getAttribute('role')).toBe('alert');
      expect(query('error-email')).toBeNull();
      expect(query('error-password')).toBeNull();
      expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
      expect(currentUrl()).toBe('/support/login');
    }
  });

  it('[US2-AC3][FR-009] 429 ACCOUNT_LOCKED muestra "Demasiados intentos fallidos. Intente de nuevo en unos minutos"', async () => {
    api.login.mockReturnValueOnce(throwError(() => supportProblem(429, 'ACCOUNT_LOCKED')));

    await signIn();

    expect(text('form-error')).toBe(AUTH_MESSAGES.ACCOUNT_LOCKED);
    expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
    expect(currentUrl()).toBe('/support/login');
  });

  it('[US2-AC1][FR-009] 401 TEMPORARY_PASSWORD_EXPIRED muestra el mensaje de contraseña temporal vencida', async () => {
    api.login.mockReturnValueOnce(throwError(() => supportProblem(401, 'TEMPORARY_PASSWORD_EXPIRED')));

    await signIn();

    expect(text('form-error')).toBe(AUTH_MESSAGES.TEMPORARY_PASSWORD_EXPIRED);
    expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('[FR-009] con correo o contraseña vacíos marca error en los campos y no envía la petición', async () => {
    await signIn('   ', '');

    expect(text('error-email')).toBe(REQUIRED_MESSAGE);
    expect(text('error-password')).toBe(REQUIRED_MESSAGE);
    expect(get('email').getAttribute('aria-invalid')).toBe('true');
    expect(get('password').getAttribute('aria-invalid')).toBe('true');
    expect(api.login).not.toHaveBeenCalled();
  });

  it('[FR-009] un fallo de red muestra form-error y no navega', async () => {
    api.login.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' })),
    );

    await signIn();

    expect(text('form-error').length).toBeGreaterThan(0);
    expect(currentUrl()).toBe('/support/login');
  });

  describe('motivo de llegada (?reason)', () => {
    const reasons: SupportLoginReason[] = ['expired', 'revoked', 'logout', 'temporary-expired'];

    for (const reason of reasons) {
      it(`[US2-AC9][FR-009] /support/login?reason=${reason} muestra "${SUPPORT_LOGIN_REASON_MESSAGES[reason]}"`, async () => {
        await open(`/support/login?reason=${reason}`);

        const banner = get('session-reason');
        expect(banner.textContent?.trim()).toBe(SUPPORT_LOGIN_REASON_MESSAGES[reason]);
        expect(banner.getAttribute('role')).toBe('status');
      });
    }
  });

  it('[FR-026] los campos y el botón de envío tienen objetivo táctil de al menos 44 px', () => {
    for (const testId of ['email', 'password', 'submit']) {
      expect(touchSize(get(testId))).toBeGreaterThanOrEqual(44);
    }
  });
});
