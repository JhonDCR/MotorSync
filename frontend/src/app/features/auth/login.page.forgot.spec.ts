// T035 (003, PR1, US1): enlace "¿Olvidaste tu contraseña?" en LoginPage y navegación con precarga del correo.
// Archivo nuevo: login.page.spec.ts y login.page.session.spec.ts de la 002 no se modifican.
//
// Contrato para el implementer-frontend (T036), archivos features/auth/login.page.html, login.page.ts y
// forgot-password.page.ts:
//   - Debajo del botón [data-testid="submit"] en /login se muestra un enlace <a data-testid="forgot-password-link">
//     con el texto exacto "¿Olvidaste tu contraseña?" (SUPPORT_MESSAGES.FORGOT_PASSWORD_LINK), sin sesión (US1-AC11,
//     FR-001).
//   - Objetivo táctil de al menos 44 px (touchSize >= 44; FR-026, US1-AC11).
//   - Un toque en [data-testid="forgot-password-link"] navega a `/forgot-password`. Si el usuario ya escribió algo
//     en [data-testid="email"], lo pasa en el query param `email` (`/forgot-password?email=...`) y ForgotPasswordPage
//     precarga su <input data-testid="email"> con ese valor (US1-AC11).
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of } from 'rxjs';
import { sessionResponse, touchSize } from '../../../testing/auth-fixtures';
import { SUPPORT_MESSAGES } from '../../../testing/support-fixtures';
import { AuthApiService } from '../../core/api/auth-api.service';
import { ForgotPasswordPage } from './forgot-password.page';
import { LoginPage } from './login.page';

describe('LoginPage: enlace "¿Olvidaste tu contraseña?" (T035)', () => {
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'login', component: LoginPage },
          { path: 'forgot-password', component: ForgotPasswordPage },
        ]),
        {
          provide: AuthApiService,
          useValue: {
            login: vi.fn(() => of(sessionResponse())),
            forgotPassword: vi.fn(() => of(undefined)),
          },
        },
      ],
    });
    harness = await RouterTestingHarness.create('/login');
    harness.detectChanges();
    await harness.fixture.whenStable();
  });

  afterEach(() => {
    localStorage.clear();
  });

  function root(): HTMLElement {
    return harness.routeNativeElement as HTMLElement;
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const el = root().querySelector<T>(`[data-testid="${testId}"]`);
    if (el === null) {
      throw new Error(`No existe [data-testid="${testId}"]`);
    }
    return el;
  }

  it('[US1-AC11][FR-001][FR-026] muestra "¿Olvidaste tu contraseña?" debajo del botón de entrar, sin sesión y con objetivo táctil >= 44 px', () => {
    const submit = get('submit');
    const link = get<HTMLAnchorElement>('forgot-password-link');

    expect(link.tagName).toBe('A');
    expect(link.textContent?.trim()).toBe(SUPPORT_MESSAGES.FORGOT_PASSWORD_LINK);
    expect(Boolean(submit.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(touchSize(link)).toBeGreaterThanOrEqual(44);
  });

  it('[US1-AC11][FR-001] un toque en el enlace navega a /forgot-password y precarga el correo ya escrito en /login', async () => {
    const emailInput = get<HTMLInputElement>('email');
    emailInput.value = 'ana.perez@taller.ec';
    emailInput.dispatchEvent(new Event('input'));
    harness.detectChanges();
    await harness.fixture.whenStable();

    get('forgot-password-link').click();
    harness.detectChanges();
    await harness.fixture.whenStable();

    const router = TestBed.inject(Router);
    expect(router.url.split('?')[0]).toBe('/forgot-password');

    const forgotEmailInput = get<HTMLInputElement>('email');
    expect(forgotEmailInput.value).toBe('ana.perez@taller.ec');
  });
});
