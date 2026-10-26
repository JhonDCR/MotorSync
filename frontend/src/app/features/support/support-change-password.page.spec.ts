// T039 (003, PR1, US2): cambio de contraseña de soporte (/support/change-password).
//
// Contrato para el implementer-frontend (T040), archivo features/support/support-change-password.page.ts (+ .html y .scss):
//   export class SupportChangePasswordPage (standalone). Ruta `/support/change-password` con `canMatch: [supportAuthGuard]`,
//   title "Cambiar contraseña de soporte".
//   Usa SupportApiService.changePassword(body) y SupportSessionStore (support-session.store.ts).
//   Selectores (data-testid), idénticos a ChangePasswordPage de la 002:
//     must-change               aviso "Debe cambiar su contraseña antes de continuar" cuando
//                               SupportSessionStore.mustChangePassword() es true; ausente en cambio voluntario.
//     current-password          <input type="password"> con <label for>
//     new-password              <input type="password"> con <label for>
//     confirm-password          <input type="password"> con <label for>
//     submit                    <button type="submit"> "Cambiar contraseña"
//     error-current-password, error-new-password, error-confirm-password   errores de campo (aria-invalid="true"):
//       vacío (solo '')         → "Este campo es obligatorio"
//       nueva < 8 caracteres    → "La contraseña debe tener al menos 8 caracteres"
//       nueva > 128 caracteres  → "La contraseña admite como máximo 128 caracteres"
//       nueva === actual        → "La nueva contraseña debe ser distinta de la actual"
//       confirmación !== nueva  → "Las contraseñas no coinciden"
//     form-error                mensaje general (role="alert").
//   Respuestas:
//     200 SupportSessionResponse      → SupportSessionStore.setSession(respuesta) y navega a `/support` (US2-AC1, FR-009).
//     400 CURRENT_PASSWORD_INCORRECT  → error-current-password "La contraseña actual no es correcta".
//     400 VALIDATION_ERROR            → error en el campo correspondiente.
//     429 ACCOUNT_LOCKED              → form-error "Demasiados intentos fallidos. Intente de nuevo en unos minutos".
//     401 TEMPORARY_PASSWORD_EXPIRED  → SupportSessionStore.clear() y navega a `/support/login?reason=temporary-expired`.
//   FR-026: campos y botón con min-height >= 44 px.
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import {
  AUTH_MESSAGES,
  CHANGE_PASSWORD_MESSAGES,
  NEW_PASSWORD,
  touchSize,
  type ChangePasswordRequestFixture,
} from '../../../testing/auth-fixtures';
import {
  SUPPORT_TEMP_PASSWORD,
  SUPPORT_TOKEN_STORAGE_KEY,
  supportProblem,
  supportSessionResponse,
  supportSessionToken,
} from '../../../testing/support-fixtures';
import { SupportApiService } from '../../core/api/support-api.service';
import { SupportSessionStore } from '../../core/support/support-session.store';
import { SupportChangePasswordPage } from './support-change-password.page';

@Component({ template: '' })
class StubPage {}

const INITIAL_SUPPORT_TOKEN = supportSessionToken('Pedro Soporte', true, { jti: 'inicial' });
const CHANGED_SUPPORT_TOKEN = supportSessionToken('Pedro Soporte', false, { jti: 'cambiado' });

describe('SupportChangePasswordPage (T039)', () => {
  let fixture: ComponentFixture<SupportChangePasswordPage>;
  let api: { changePassword: ReturnType<typeof vi.fn<SupportApiService['changePassword']>> };
  let store: SupportSessionStore;

  async function setup(mustChangePassword = true): Promise<void> {
    localStorage.clear();
    const updatedSession = {
      ...supportSessionResponse({ mustChangePassword: false }),
      accessToken: CHANGED_SUPPORT_TOKEN,
    };
    api = {
      changePassword: vi.fn<SupportApiService['changePassword']>(() => of(updatedSession)),
    };
    await TestBed.configureTestingModule({
      imports: [SupportChangePasswordPage],
      providers: [
        provideRouter([
          { path: 'support', component: StubPage },
          { path: 'support/login', component: StubPage },
          { path: 'support/change-password', component: StubPage },
        ]),
        { provide: SupportApiService, useValue: api },
      ],
    }).compileComponents();
    store = TestBed.inject(SupportSessionStore);
    store.setSession({
      ...supportSessionResponse({
        mustChangePassword,
        temporaryPasswordExpiresAt: mustChangePassword ? '2026-10-26T14:00:00.000Z' : null,
      }),
      accessToken: INITIAL_SUPPORT_TOKEN,
    });
    await TestBed.inject(Router).navigateByUrl('/support/change-password');
    fixture = TestBed.createComponent(SupportChangePasswordPage);
    await settle();
  }

  afterEach(() => {
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

  function text(testId: string): string {
    return get(testId).textContent?.trim() ?? '';
  }

  async function type(testId: string, value: string): Promise<void> {
    const input = get<HTMLInputElement>(testId);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function fill(current: string, next: string, confirmation = next): Promise<void> {
    await type('current-password', current);
    await type('new-password', next);
    await type('confirm-password', confirmation);
  }

  async function submit(): Promise<void> {
    get('submit').click();
    await settle();
  }

  function url(): string {
    return TestBed.inject(Router).url;
  }

  beforeEach(async () => {
    await setup(true);
  });

  it('[US2-AC1][FR-009] con contraseña temporal pendiente muestra "Debe cambiar su contraseña antes de continuar" y los tres campos con label', () => {
    expect(text('must-change')).toBe(CHANGE_PASSWORD_MESSAGES.MUST_CHANGE);
    for (const testId of ['current-password', 'new-password', 'confirm-password']) {
      const input = get<HTMLInputElement>(testId);
      expect(input.type).toBe('password');
      expect(input.labels?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('[US2-AC1][FR-009] envía { currentPassword, newPassword } tal cual, actualiza SupportSessionStore y vuelve a la bandeja (/support)', async () => {
    await fill(SUPPORT_TEMP_PASSWORD, NEW_PASSWORD);
    await submit();

    expect(api.changePassword).toHaveBeenCalledTimes(1);
    const body = api.changePassword.mock.calls[0][0] as ChangePasswordRequestFixture;
    expect(body).toEqual({ currentPassword: SUPPORT_TEMP_PASSWORD, newPassword: NEW_PASSWORD });
    await vi.waitFor(() => expect(url()).toBe('/support'));
    expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBe(CHANGED_SUPPORT_TOKEN);
    expect(store.mustChangePassword()).toBe(false);
  });

  it('[FR-009] contraseña actual incorrecta (400 CURRENT_PASSWORD_INCORRECT) muestra error en current-password y no navega', async () => {
    api.changePassword.mockReturnValueOnce(
      throwError(() =>
        supportProblem(400, 'CURRENT_PASSWORD_INCORRECT', {
          errors: [{ field: 'currentPassword', code: 'CURRENT_PASSWORD_INCORRECT', message: 'x' }],
        }),
      ),
    );
    await fill('Incorrecta 123', NEW_PASSWORD);
    await submit();

    expect(text('error-current-password')).toBe(CHANGE_PASSWORD_MESSAGES.CURRENT_PASSWORD_INCORRECT);
    expect(get('current-password').getAttribute('aria-invalid')).toBe('true');
    expect(url()).toBe('/support/change-password');
    expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBe(INITIAL_SUPPORT_TOKEN);
  });

  it('[FR-009] valida localmente: nueva < 8 caracteres, > 128 caracteres, igual a la actual y confirmación distinta sin llamar a la API', async () => {
    await fill(SUPPORT_TEMP_PASSWORD, 'Abc 123');
    await submit();
    expect(text('error-new-password')).toBe(CHANGE_PASSWORD_MESSAGES.PASSWORD_TOO_SHORT);
    expect(api.changePassword).not.toHaveBeenCalled();

    await fill(SUPPORT_TEMP_PASSWORD, 'a'.repeat(129));
    await submit();
    expect(text('error-new-password')).toBe(CHANGE_PASSWORD_MESSAGES.PASSWORD_TOO_LONG);
    expect(api.changePassword).not.toHaveBeenCalled();

    await fill(SUPPORT_TEMP_PASSWORD, SUPPORT_TEMP_PASSWORD);
    await submit();
    expect(text('error-new-password')).toBe(CHANGE_PASSWORD_MESSAGES.SAME_PASSWORD);
    expect(api.changePassword).not.toHaveBeenCalled();

    await fill(SUPPORT_TEMP_PASSWORD, NEW_PASSWORD, NEW_PASSWORD.trim());
    await submit();
    expect(text('error-confirm-password')).toBe(CHANGE_PASSWORD_MESSAGES.CONFIRMATION_MISMATCH);
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it('[FR-009] 429 ACCOUNT_LOCKED muestra el mensaje de bloqueo y conserva la sesión', async () => {
    api.changePassword.mockReturnValueOnce(throwError(() => supportProblem(429, 'ACCOUNT_LOCKED')));
    await fill('Incorrecta 123', NEW_PASSWORD);
    await submit();

    expect(text('form-error')).toBe(AUTH_MESSAGES.ACCOUNT_LOCKED);
    expect(store.isSignedIn()).toBe(true);
  });

  it('[US2-AC1][FR-009] 401 TEMPORARY_PASSWORD_EXPIRED limpia SupportSessionStore y redirige a /support/login?reason=temporary-expired', async () => {
    api.changePassword.mockReturnValueOnce(throwError(() => supportProblem(401, 'TEMPORARY_PASSWORD_EXPIRED')));
    await fill(SUPPORT_TEMP_PASSWORD, NEW_PASSWORD);
    await submit();

    await vi.waitFor(() => expect(url().split('?')[0]).toBe('/support/login'));
    expect(TestBed.inject(Router).parseUrl(url()).queryParams['reason']).toBe('temporary-expired');
    expect(localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)).toBeNull();
    expect(store.isSignedIn()).toBe(false);
  });

  it('[FR-026] los campos y el botón tienen objetivo táctil de al menos 44 px', () => {
    for (const testId of ['current-password', 'new-password', 'confirm-password', 'submit']) {
      expect(touchSize(get(testId))).toBeGreaterThanOrEqual(44);
    }
  });
});
