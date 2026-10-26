// T043 (002, PR2, US5): cambiar la propia contraseña, obligatorio con una contraseña temporal.
//
// Contrato para el implementer-frontend (T044), archivo features/auth/change-password.page.ts (+ .html y .scss):
//   export class ChangePasswordPage (standalone). Ruta `change-password` en app.routes.ts con canMatch [authGuard]
//   (title "Cambiar contraseña"). Usa AuthApiService.changePassword(body) y SessionStore (session.store.ts).
// Selectores (data-testid), cada <input type="password"> con su <label for> y texto visible:
//   must-change               aviso "Debe cambiar su contraseña antes de continuar" (US5-AC1), solo si
//                             SessionStore.mustChangePassword() es true; con cambio voluntario no aparece.
//   current-password          contraseña actual (autocomplete="current-password")
//   new-password              contraseña nueva (autocomplete="new-password")
//   confirm-password          confirmación de la nueva (autocomplete="new-password")
//   submit                    botón "Cambiar contraseña"
//   error-current-password, error-new-password, error-confirm-password   error del campo (el <input> lleva
//                             aria-invalid="true"). Validación en la pantalla ANTES de enviar (no llama a la API):
//       vacío                         → "Este campo es obligatorio" (la contraseña no se recorta: solo '' es vacío)
//       nueva < 8 caracteres Unicode  → "La contraseña debe tener al menos 8 caracteres"   (error-new-password)
//       nueva > 128                   → "La contraseña admite como máximo 128 caracteres"  (error-new-password)
//       nueva === actual              → "La nueva contraseña debe ser distinta de la actual" (error-new-password)
//       confirmación ≠ nueva          → "Las contraseñas no coinciden"                      (error-confirm-password)
//   form-error                mensaje general (role="alert").
// Envío: exactamente { currentPassword, newPassword } TAL CUAL (sin confirmación, sin recortar; FR-005, US5-AC8).
// Respuestas:
//   200 SessionResponse       → SessionStore.setSession(respuesta) (token nuevo en 'motorsync.token',
//                               mustChangePassword false) y navega a `/` (US5-AC2).
//   400 CURRENT_PASSWORD_INCORRECT → error-current-password "La contraseña actual no es correcta" (US5-AC4); no
//                               navega ni cambia el token.
//   400 VALIDATION_ERROR con errors[] (SAME_PASSWORD, PASSWORD_TOO_SHORT… en newPassword) → error del campo.
//   429 ACCOUNT_LOCKED        → form-error "Demasiados intentos fallidos. Intente de nuevo en unos minutos"; la sesión
//                               sigue (no borra el token ni navega).
//   401 TEMPORARY_PASSWORD_EXPIRED → SessionStore.clear() y navega a `/login?reason=temporary-expired`, donde la
//                               página de login muestra "Su contraseña temporal venció. Pida al administrador de su
//                               taller que la restablezca o use ¿Olvidaste tu contraseña?" (US5-AC9; FR-022 de la 003;
//                               lo prueba login.page.session.spec.ts).
//   fallo de red (status 0)   → form-error no vacío.
// Ninguna contraseña aparece en el texto ni en el HTML de la página (FR-006, US5-AC7).
// Mobile-first (FR-025): inputs y botón con min-height de al menos 44 px.
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { AuthApiService } from '../../core/api/auth-api.service';
import { AUTH_TOKEN_STORAGE_KEY } from '../../core/auth/auth-token.interceptor';
import { SessionStore } from '../../core/auth/session.store';
import {
  AUTH_MESSAGES,
  authProblem,
  CHANGE_PASSWORD_MESSAGES,
  NEW_PASSWORD,
  sessionResponse,
  sessionResponseWithToken,
  TEMPORARY_PASSWORD,
  touchSize,
  type ChangePasswordRequestFixture,
} from '../../../testing/auth-fixtures';
import { ChangePasswordPage } from './change-password.page';

@Component({ template: '' })
class StubPage {}

const TEMP_SESSION_TOKEN = 'token.de.sesion.temporal';
const CHANGED_TOKEN = 'token.tras.el.cambio';

describe('ChangePasswordPage (T043)', () => {
  let fixture: ComponentFixture<ChangePasswordPage>;
  let api: { changePassword: ReturnType<typeof vi.fn>; me: ReturnType<typeof vi.fn> };
  let store: SessionStore;

  async function setup(mustChangePassword: boolean): Promise<void> {
    localStorage.clear();
    api = {
      changePassword: vi.fn(() =>
        of(sessionResponseWithToken(CHANGED_TOKEN, { role: 'asesor', name: 'Luis Mora', mustChangePassword: false })),
      ),
      me: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [ChangePasswordPage],
      providers: [
        provideRouter([
          { path: '', component: StubPage },
          { path: 'login', component: StubPage },
          { path: 'change-password', component: StubPage },
        ]),
        { provide: AuthApiService, useValue: api },
      ],
    }).compileComponents();
    store = TestBed.inject(SessionStore);
    store.setSession(
      sessionResponseWithToken(TEMP_SESSION_TOKEN, {
        role: 'asesor',
        name: 'Luis Mora',
        mustChangePassword,
        temporaryPasswordExpiresAt: mustChangePassword ? '2026-10-26T12:00:00Z' : null,
      }),
    );
    await TestBed.inject(Router).navigateByUrl('/change-password');
    fixture = TestBed.createComponent(ChangePasswordPage);
    await settle();
  }

  afterEach(() => {
    localStorage.clear();
  });

  // --- utilidades de interacción ---

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

  function storedToken(): string | null {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  }

  function rejectWith(error: unknown): void {
    api.changePassword.mockReturnValueOnce(throwError(() => error));
  }

  function expectPasswordsNotInDom(...passwords: string[]): void {
    for (const password of passwords) {
      expect(root().textContent ?? '').not.toContain(password.trim());
      expect(root().innerHTML).not.toContain(password.trim());
    }
  }

  describe('con contraseña temporal pendiente', () => {
    beforeEach(async () => {
      await setup(true);
    });

    it('[US5-AC1] muestra "Debe cambiar su contraseña antes de continuar"', () => {
      expect(text('must-change')).toBe(CHANGE_PASSWORD_MESSAGES.MUST_CHANGE);
    });

    it('[US5-AC1] tiene los tres campos de contraseña con su etiqueta', () => {
      for (const testId of ['current-password', 'new-password', 'confirm-password']) {
        const input = get<HTMLInputElement>(testId);
        expect(input.type).toBe('password');
        expect(input.id).not.toBe('');
        const label = root().querySelector(`label[for="${input.id}"]`);
        expect(label?.textContent?.trim()).toBeTruthy();
      }
    });

    it('[US5-AC2] envía { currentPassword, newPassword } tal cual, guarda el token nuevo y navega a /', async () => {
      await fill(TEMPORARY_PASSWORD, NEW_PASSWORD);
      await submit();

      expect(api.changePassword).toHaveBeenCalledTimes(1);
      const body = api.changePassword.mock.calls[0][0] as ChangePasswordRequestFixture;
      expect(body).toEqual({ currentPassword: TEMPORARY_PASSWORD, newPassword: NEW_PASSWORD });
      expect(Object.keys(body).sort()).toEqual(['currentPassword', 'newPassword']);
      await vi.waitFor(() => expect(url()).toBe('/'));
      expect(storedToken()).toBe(CHANGED_TOKEN);
      expect(store.mustChangePassword()).toBe(false);
    });

    it('[US5-AC4] contraseña actual incorrecta: "La contraseña actual no es correcta" en el campo, sin navegar', async () => {
      rejectWith(
        authProblem(400, 'CURRENT_PASSWORD_INCORRECT', {
          errors: [{ field: 'currentPassword', code: 'CURRENT_PASSWORD_INCORRECT', message: 'x' }],
        }),
      );
      await fill('Incorrecta 123', NEW_PASSWORD);
      await submit();

      expect(text('error-current-password')).toBe(CHANGE_PASSWORD_MESSAGES.CURRENT_PASSWORD_INCORRECT);
      expect(get('current-password').getAttribute('aria-invalid')).toBe('true');
      expect(url()).toBe('/change-password');
      expect(storedToken()).toBe(TEMP_SESSION_TOKEN);
    });

    it('[US5-AC4] 429 ACCOUNT_LOCKED: mensaje de bloqueo y la sesión sigue', async () => {
      rejectWith(authProblem(429, 'ACCOUNT_LOCKED'));
      await fill('Incorrecta 123', NEW_PASSWORD);
      await submit();

      expect(text('form-error')).toBe(AUTH_MESSAGES.ACCOUNT_LOCKED);
      expect(get('form-error').getAttribute('role')).toBe('alert');
      expect(url()).toBe('/change-password');
      expect(storedToken()).toBe(TEMP_SESSION_TOKEN);
      expect(store.isSignedIn()).toBe(true);
    });

    it('[US5-AC5] nueva de 7 caracteres: error en el campo y no se envía', async () => {
      await fill(TEMPORARY_PASSWORD, 'Abc 123');
      await submit();

      expect(text('error-new-password')).toBe(CHANGE_PASSWORD_MESSAGES.PASSWORD_TOO_SHORT);
      expect(get('new-password').getAttribute('aria-invalid')).toBe('true');
      expect(api.changePassword).not.toHaveBeenCalled();
    });

    it('[US5-AC5][FR-005] 8 caracteres contando espacios es válida: no se recorta', async () => {
      await fill(TEMPORARY_PASSWORD, '  Abc12 ');
      await submit();

      expect(query('error-new-password')).toBeNull();
      expect((api.changePassword.mock.calls[0][0] as ChangePasswordRequestFixture).newPassword).toBe('  Abc12 ');
    });

    it('[US5-AC5] nueva de más de 128 caracteres: error en el campo y no se envía', async () => {
      const tooLong = 'a'.repeat(129);
      await fill(TEMPORARY_PASSWORD, tooLong);
      await submit();

      expect(text('error-new-password')).toBe(CHANGE_PASSWORD_MESSAGES.PASSWORD_TOO_LONG);
      expect(api.changePassword).not.toHaveBeenCalled();
    });

    it('[US5-AC5] nueva igual a la actual: error en el campo y no se envía', async () => {
      await fill(TEMPORARY_PASSWORD, TEMPORARY_PASSWORD);
      await submit();

      expect(text('error-new-password')).toBe(CHANGE_PASSWORD_MESSAGES.SAME_PASSWORD);
      expect(api.changePassword).not.toHaveBeenCalled();
    });

    it('[US5-AC5][FR-005] distinguir mayúsculas: una nueva que solo cambia mayúsculas no es "igual"', async () => {
      await fill(TEMPORARY_PASSWORD, TEMPORARY_PASSWORD.toUpperCase());
      await submit();

      expect(query('error-new-password')).toBeNull();
      expect(api.changePassword).toHaveBeenCalledTimes(1);
    });

    it('[US5-AC5] confirmación distinta: error en la confirmación y no se envía', async () => {
      await fill(TEMPORARY_PASSWORD, NEW_PASSWORD, NEW_PASSWORD.trim());
      await submit();

      expect(text('error-confirm-password')).toBe(CHANGE_PASSWORD_MESSAGES.CONFIRMATION_MISMATCH);
      expect(get('confirm-password').getAttribute('aria-invalid')).toBe('true');
      expect(api.changePassword).not.toHaveBeenCalled();
    });

    it('[US5-AC5] campos vacíos: "Este campo es obligatorio" en cada uno y no se envía', async () => {
      await submit();

      expect(text('error-current-password')).toBe(CHANGE_PASSWORD_MESSAGES.REQUIRED);
      expect(text('error-new-password')).toBe(CHANGE_PASSWORD_MESSAGES.REQUIRED);
      expect(text('error-confirm-password')).toBe(CHANGE_PASSWORD_MESSAGES.REQUIRED);
      expect(api.changePassword).not.toHaveBeenCalled();
    });

    it('[US5-AC5] SAME_PASSWORD del servidor se muestra en el campo de la nueva', async () => {
      rejectWith(
        authProblem(400, 'VALIDATION_ERROR', {
          errors: [{ field: 'newPassword', code: 'SAME_PASSWORD', message: 'x' }],
        }),
      );
      await fill(TEMPORARY_PASSWORD, NEW_PASSWORD);
      await submit();

      expect(text('error-new-password')).toBe(CHANGE_PASSWORD_MESSAGES.SAME_PASSWORD);
      expect(url()).toBe('/change-password');
    });

    it('[US5-AC9] temporal vencida durante la sesión: limpia la sesión y vuelve a /login?reason=temporary-expired', async () => {
      rejectWith(authProblem(401, 'TEMPORARY_PASSWORD_EXPIRED'));
      await fill(TEMPORARY_PASSWORD, NEW_PASSWORD);
      await submit();

      await vi.waitFor(() => expect(url().split('?')[0]).toBe('/login'));
      expect(TestBed.inject(Router).parseUrl(url()).queryParams['reason']).toBe('temporary-expired');
      expect(storedToken()).toBeNull();
      expect(store.isSignedIn()).toBe(false);
    });

    it('[edge case conexión inestable] un fallo de red muestra un mensaje y no navega', async () => {
      rejectWith(new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' }));
      await fill(TEMPORARY_PASSWORD, NEW_PASSWORD);
      await submit();

      expect(text('form-error')).not.toBe('');
      expect(url()).toBe('/change-password');
    });

    it('[US5-AC7][FR-006] ninguna contraseña aparece en la página, tampoco tras un error', async () => {
      rejectWith(
        authProblem(400, 'CURRENT_PASSWORD_INCORRECT', {
          errors: [{ field: 'currentPassword', code: 'CURRENT_PASSWORD_INCORRECT', message: TEMPORARY_PASSWORD }],
        }),
      );
      await fill(TEMPORARY_PASSWORD, NEW_PASSWORD);
      await submit();

      expectPasswordsNotInDom(TEMPORARY_PASSWORD, NEW_PASSWORD);
    });

    it('[FR-025] campos y botón con objetivo táctil de al menos 44 px', () => {
      for (const testId of ['current-password', 'new-password', 'confirm-password', 'submit']) {
        expect(touchSize(get(testId))).toBeGreaterThanOrEqual(44);
      }
    });
  });

  describe('cambio voluntario', () => {
    beforeEach(async () => {
      await setup(false);
    });

    it('[US5-AC6] sin contraseña temporal no muestra el aviso de cambio obligatorio', () => {
      expect(query('must-change')).toBeNull();
    });

    it('[US5-AC3] cambia la contraseña y vuelve a / con el token nuevo', async () => {
      api.changePassword.mockReturnValueOnce(of(sessionResponseWithToken(CHANGED_TOKEN, sessionResponse().user)));
      await fill('Clave Actual 2026', NEW_PASSWORD);
      await submit();

      await vi.waitFor(() => expect(url()).toBe('/'));
      expect(storedToken()).toBe(CHANGED_TOKEN);
    });
  });
});
