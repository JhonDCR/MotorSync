// T035 (003, PR1, US1): página pública "¿Olvidaste tu contraseña?" (ForgotPasswordPage).
//
// Contrato para el implementer-frontend (T036), archivos features/auth/forgot-password.page.ts (+ .html y .scss) y
// app.routes.ts:
//   export class ForgotPasswordPage (standalone). Ruta `forgot-password` en app.routes.ts con canMatch: [guestGuard].
//   Usa AuthApiService.forgotPassword(email).
// Selectores (data-testid):
//   email          <input type="email"> con su <label for> visible. Si la ruta trae `?email=...`, precarga ese valor
//                  (US1-AC11).
//   submit         botón submit del formulario.
//   error-email    mensaje de error del campo ("Este campo es obligatorio" si está vacío o solo espacios;
//                  "Correo electrónico inválido" si el formato no es válido tras normalizar). El <input> lleva
//                  aria-invalid="true" y NO se llama a AuthApiService.forgotPassword (US1-AC8).
//   form-error     mensaje general (role="alert"):
//                    429 HELP_RATE_LIMITED → "Demasiadas solicitudes. Intente de nuevo más tarde" (US1-AC6)
//                    fallo de red (status 0) → mensaje no vacío.
//   confirmation   mensaje de confirmación (role="status") que reemplaza al formulario tras recibir 202:
//                  muestra exactamente el texto literal de FR-003 (SUPPORT_MESSAGES.FORGOT_PASSWORD_ACCEPTED), sin
//                  prometer canal concreto ni decir que se envió un correo (US1-AC1, FR-003).
//   back-to-login  enlace (<a routerLink="/login">) para volver a /login (FR-026).
// Envío: normaliza el correo (trim + minúsculas, FR-001) y envía solo `email` a AuthApiService.forgotPassword
//   (US1-AC9).
// Mobile-first (FR-026): layout desde 360 px (.auth-page) y controles (email, submit, back-to-login) con min-height
//   de al menos 44 px (touchSize >= 44).
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { sessionResponse, touchSize } from '../../../testing/auth-fixtures';
import { SUPPORT_MESSAGES, supportProblem } from '../../../testing/support-fixtures';
import { routes } from '../../app.routes';
import { AuthApiService } from '../../core/api/auth-api.service';
import { SessionStore } from '../../core/auth/session.store';
import { ForgotPasswordPage } from './forgot-password.page';

@Component({ template: '<p data-testid="stub">stub</p>' })
class StubPage {}

const REQUIRED_MESSAGE = 'Este campo es obligatorio';
const INVALID_EMAIL_MESSAGE = 'Correo electrónico inválido';

describe('ForgotPasswordPage (T035)', () => {
  let harness: RouterTestingHarness;
  let api: { forgotPassword: ReturnType<typeof vi.fn<AuthApiService['forgotPassword']>> };

  beforeEach(async () => {
    localStorage.clear();
    api = { forgotPassword: vi.fn<AuthApiService['forgotPassword']>(() => of(undefined)) };
    await TestBed.configureTestingModule({
      imports: [ForgotPasswordPage],
      providers: [
        provideRouter([
          { path: '', component: StubPage },
          { path: 'login', component: StubPage },
          { path: 'forgot-password', component: ForgotPasswordPage },
        ]),
        { provide: AuthApiService, useValue: api },
      ],
    }).compileComponents();
    harness = await RouterTestingHarness.create('/forgot-password');
    await settle();
  });

  afterEach(() => {
    localStorage.clear();
  });

  async function settle(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
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

  async function typeEmail(value: string): Promise<void> {
    const input = get<HTMLInputElement>('email');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function submitEmail(value: string): Promise<void> {
    await typeEmail(value);
    get('submit').click();
    await settle();
  }

  it('[FR-001][US1-AC9] el formulario pide únicamente el correo electrónico con label visible', () => {
    const inputs = Array.from(root().querySelectorAll('input, select, textarea'));
    expect(inputs.map((el) => el.getAttribute('data-testid'))).toEqual(['email']);

    const emailInput = get<HTMLInputElement>('email');
    expect(emailInput.labels?.length ?? 0).toBeGreaterThan(0);
    expect(emailInput.labels?.[0].textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('[US1-AC11] precarga el correo cuando se llega con ?email=...', async () => {
    await harness.navigateByUrl('/forgot-password?email=ana.perez%40taller.ec');
    await settle();

    expect(get<HTMLInputElement>('email').value).toBe('ana.perez@taller.ec');
  });

  it('[US1-AC8] correo vacío o solo espacios marca error-email "Este campo es obligatorio" y no envía petición', async () => {
    await submitEmail('   ');

    expect(text('error-email')).toBe(REQUIRED_MESSAGE);
    expect(get('email').getAttribute('aria-invalid')).toBe('true');
    expect(api.forgotPassword).not.toHaveBeenCalled();
    expect(query('confirmation')).toBeNull();
  });

  it('[US1-AC8] correo con formato inválido marca error-email "Correo electrónico inválido" y no envía petición', async () => {
    await submitEmail('ana@taller');

    expect(text('error-email')).toBe(INVALID_EMAIL_MESSAGE);
    expect(get('email').getAttribute('aria-invalid')).toBe('true');
    expect(api.forgotPassword).not.toHaveBeenCalled();
    expect(query('confirmation')).toBeNull();
  });

  it('[US1-AC1][FR-003][US1-AC9] tras 202 normaliza y envía solo el correo y reemplaza el formulario por el texto literal de FR-003', async () => {
    await submitEmail(' Ana.Perez@Taller.EC ');

    expect(api.forgotPassword).toHaveBeenCalledTimes(1);
    const arg = api.forgotPassword.mock.calls[0][0];
    const sentEmail = typeof arg === 'string' ? arg : arg.email;
    expect(sentEmail).toBe('ana.perez@taller.ec');
    if (typeof arg === 'object' && arg !== null) {
      expect(Object.keys(arg)).toEqual(['email']);
    }

    expect(query('email')).toBeNull();
    expect(query('submit')).toBeNull();
    const confirmation = get('confirmation');
    expect(confirmation.textContent?.trim()).toBe(SUPPORT_MESSAGES.FORGOT_PASSWORD_ACCEPTED);
    expect(confirmation.textContent).not.toMatch(/enviamos un correo|enlace enviado/i);
  });

  it('[US1-AC6][FR-004] ante 429 HELP_RATE_LIMITED muestra "Demasiadas solicitudes. Intente de nuevo más tarde"', async () => {
    api.forgotPassword.mockReturnValueOnce(throwError(() => supportProblem(429, 'HELP_RATE_LIMITED')));

    await submitEmail('ana.perez@taller.ec');

    expect(text('form-error')).toBe(SUPPORT_MESSAGES.HELP_RATE_LIMITED);
    expect(get('form-error').getAttribute('role')).toBe('alert');
    expect(query('confirmation')).toBeNull();
  });

  it('[US1-AC2] ante un fallo de red (status 0) muestra form-error no vacío y mantiene el formulario', async () => {
    api.forgotPassword.mockReturnValueOnce(
      throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: '/api/v1/auth/forgot-password' })),
    );

    await submitEmail('ana.perez@taller.ec');

    expect(text('form-error').length).toBeGreaterThan(0);
    expect(query('email')).not.toBeNull();
  });

  it('[FR-026] controles con objetivo táctil >= 44 px, layout mobile-first desde 360 px y enlace de vuelta a /login', async () => {
    expect(root().querySelector('.auth-page')).not.toBeNull();
    for (const testId of ['email', 'submit', 'back-to-login']) {
      expect(touchSize(get(testId))).toBeGreaterThanOrEqual(44);
    }

    get('back-to-login').click();
    await settle();
    expect(TestBed.inject(Router).url).toBe('/login');
  });
});

describe('ForgotPasswordPage: ruta con guestGuard (T035)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('[FR-026][FR-001] /forgot-password abre ForgotPasswordPage sin sesión y redirige a / con sesión de taller activa', async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        {
          provide: AuthApiService,
          useValue: {
            forgotPassword: vi.fn(() => of(undefined)),
            me: vi.fn(),
          },
        },
      ],
    });
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/forgot-password');

    expect(TestBed.inject(Router).url).toBe('/forgot-password');
    expect(page).toBeInstanceOf(ForgotPasswordPage);

    TestBed.inject(SessionStore).setSession(sessionResponse());
    await harness.navigateByUrl('/forgot-password');

    expect(TestBed.inject(Router).url).toBe('/');
  });
});
