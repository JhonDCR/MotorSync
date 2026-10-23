// T028 (002, PR1, US2): página pública de inicio de sesión con correo y contraseña.
// Según research R13, el componente se prueba con AuthApiService simulado (contrato en
// core/api/auth-api.service.spec.ts y specs/002-autenticacion/contracts/openapi.yaml).
//
// Contrato para el implementer-frontend (T029), archivo features/auth/login.page.ts (+ .html y .scss):
//   export class LoginPage (standalone). Ruta PÚBLICA `login` en app.routes.ts (loadComponent, title
//   "Iniciar sesión"); en el PR1 no hay guards ni refresh: el token dura 15 min y luego se vuelve a entrar.
//   Usa AuthApiService.login(body: LoginRequest).
//   Al entrar (200): guarda session.accessToken en localStorage 'motorsync.token' (AUTH_TOKEN_STORAGE_KEY) y navega a
//   `/`, o a `/change-password` si session.user.mustChangePassword es true (la pantalla llega en el PR2; aquí la ruta
//   puede no existir todavía en app.routes.ts: la prueba la provee con un stub).
// Selectores (data-testid), cada <input> con su <label for> y texto visible:
//   email                    <input> del correo
//   password                 <input type="password">
//   submit                   botón "Iniciar sesión" (submit del formulario)
//   error-email, error-password   "Este campo es obligatorio" si están vacíos al enviar (no se llama a login);
//                                 el <input> con error lleva aria-invalid="true". El correo vacío o solo espacios
//                                 cuenta como vacío; la contraseña NUNCA se recorta.
//   form-error               mensaje general (role="alert"):
//     401 INVALID_CREDENTIALS          "Correo o contraseña incorrectos" (US2-AC3), sin marcar ningún campo:
//                                      el mismo mensaje sea cual sea la causa.
//     429 ACCOUNT_LOCKED               "Demasiados intentos fallidos. Intente de nuevo en unos minutos" (US2-AC5)
//     401 TEMPORARY_PASSWORD_EXPIRED   "Su contraseña temporal venció. Pida al administrador de su taller que la
//                                      restablezca" (US5-AC9)
//     fallo de red (status 0)          un mensaje no vacío.
//   En ningún error se guarda token ni se navega, y la contraseña no aparece en el texto de la página (FR-006).
// Cuerpo enviado: exactamente { email, password } (US2-AC10); email tal cual o normalizado; password tal cual.
// Mobile-first (FR-025): los <input> y el botón submit tienen min-height de al menos 44 px.
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { routes } from '../../app.routes';
import { AuthApiService } from '../../core/api/auth-api.service';
import { AUTH_TOKEN_STORAGE_KEY } from '../../core/auth/auth-token.interceptor';
import {
  AUTH_MESSAGES,
  authProblem,
  PASSWORD,
  sessionResponse,
  touchSize,
  type LoginRequestFixture,
} from '../../../testing/auth-fixtures';
import { LoginPage } from './login.page';

@Component({ template: '' })
class StubPage {}

const REQUIRED_MESSAGE = 'Este campo es obligatorio';

describe('LoginPage (T028)', () => {
  let fixture: ComponentFixture<LoginPage>;
  let api: { login: ReturnType<typeof vi.fn<AuthApiService['login']>> };

  beforeEach(async () => {
    localStorage.clear();
    api = { login: vi.fn<AuthApiService['login']>(() => of(sessionResponse({ role: 'asesor' }))) };
    await TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [
        provideRouter([
          { path: '', component: StubPage },
          { path: 'login', component: StubPage },
          { path: 'change-password', component: StubPage },
        ]),
        { provide: AuthApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(LoginPage);
    await TestBed.inject(Router).navigateByUrl('/login');
    await settle();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // --- utilidades de interacción (comportamiento observable en el DOM) ---

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

  async function signIn(email = ' ANA.Perez@taller.ec ', password = PASSWORD): Promise<void> {
    await type('email', email);
    await type('password', password);
    get('submit').click();
    await settle();
  }

  function sentBody(call = 0): LoginRequestFixture {
    return api.login.mock.calls[call][0] as LoginRequestFixture;
  }

  function currentUrl(): string {
    return TestBed.inject(Router).url;
  }

  function storedToken(): string | null {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  }

  function expectNoFieldMarked(): void {
    expect(query('error-email')).toBeNull();
    expect(query('error-password')).toBeNull();
    expect(get('email').getAttribute('aria-invalid')).not.toBe('true');
    expect(get('password').getAttribute('aria-invalid')).not.toBe('true');
  }

  // --- pruebas ---

  it('[FR-007][FR-025] correo y contraseña con label visible; la contraseña es type="password"', () => {
    for (const testId of ['email', 'password']) {
      const input = get<HTMLInputElement>(testId);
      expect(input.tagName).toBe('INPUT');
      expect(input.labels?.length ?? 0).toBeGreaterThan(0);
      expect(input.labels?.[0].textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
    expect(get<HTMLInputElement>('password').type).toBe('password');
  });

  it('[FR-007] no pide el taller: el formulario solo tiene correo y contraseña', () => {
    const inputs = Array.from(root().querySelectorAll('input, select, textarea'));
    expect(inputs.map((input) => input.getAttribute('data-testid')).sort()).toEqual(['email', 'password']);
  });

  it('[US2-AC1] guarda el accessToken en localStorage "motorsync.token" y navega a /', async () => {
    const session = sessionResponse({ role: 'asesor' });
    api.login.mockReturnValue(of(session));

    await signIn();

    expect(api.login).toHaveBeenCalledTimes(1);
    expect(storedToken()).toBe(session.accessToken);
    expect(currentUrl()).toBe('/');
  });

  it('[US2-AC1][US5-AC1] con user.mustChangePassword navega a /change-password', async () => {
    const session = sessionResponse({ role: 'asesor', mustChangePassword: true });
    api.login.mockReturnValue(of(session));

    await signIn();

    expect(storedToken()).toBe(session.accessToken);
    expect(currentUrl()).toBe('/change-password');
  });

  it('[US2-AC2][FR-005] envía la contraseña exactamente como se escribió (espacios y mayúsculas)', async () => {
    await signIn();

    expect(sentBody().password).toBe(PASSWORD);
    expect(sentBody().email.trim().toLowerCase()).toBe('ana.perez@taller.ec');
  });

  it('[US2-AC10] el cuerpo solo lleva email y password: nunca tenantId ni role', async () => {
    await signIn();

    expect(Object.keys(sentBody()).sort()).toEqual(['email', 'password']);
  });

  it('[US2-AC3][FR-008] 401 INVALID_CREDENTIALS → "Correo o contraseña incorrectos" sin marcar ningún campo', async () => {
    api.login.mockReturnValue(throwError(() => authProblem(401, 'INVALID_CREDENTIALS')));

    await signIn();

    expect(text('form-error')).toBe(AUTH_MESSAGES.INVALID_CREDENTIALS);
    expect(get('form-error').getAttribute('role')).toBe('alert');
    expectNoFieldMarked();
    expect(storedToken()).toBeNull();
    expect(currentUrl()).toBe('/login');
  });

  it('[US2-AC3][US2-AC4] el mensaje es el mismo para correo inexistente, contraseña incorrecta o cuenta desactivada', async () => {
    // El backend responde lo mismo en los tres casos; la página no debe distinguir por detail ni title.
    const variants = [
      authProblem(401, 'INVALID_CREDENTIALS', { detail: 'El correo no existe' }),
      authProblem(401, 'INVALID_CREDENTIALS', { detail: 'Contraseña incorrecta', title: 'Unauthorized' }),
      authProblem(401, 'INVALID_CREDENTIALS', { detail: 'Cuenta desactivada' }),
    ];
    for (const problem of variants) {
      api.login.mockReturnValueOnce(throwError(() => problem));
      await signIn();
      expect(text('form-error')).toBe(AUTH_MESSAGES.INVALID_CREDENTIALS);
    }
  });

  it('[US2-AC5][US2-AC8] 429 ACCOUNT_LOCKED → "Demasiados intentos fallidos. Intente de nuevo en unos minutos"', async () => {
    api.login.mockReturnValue(throwError(() => authProblem(429, 'ACCOUNT_LOCKED')));

    await signIn();

    expect(text('form-error')).toBe(AUTH_MESSAGES.ACCOUNT_LOCKED);
    expectNoFieldMarked();
    expect(storedToken()).toBeNull();
  });

  it('[US5-AC9] 401 TEMPORARY_PASSWORD_EXPIRED → mensaje de contraseña temporal vencida', async () => {
    api.login.mockReturnValue(throwError(() => authProblem(401, 'TEMPORARY_PASSWORD_EXPIRED')));

    await signIn();

    expect(text('form-error')).toBe(AUTH_MESSAGES.TEMPORARY_PASSWORD_EXPIRED);
    expect(storedToken()).toBeNull();
    expect(currentUrl()).toBe('/login');
  });

  it('[FR-006] la contraseña no aparece en el texto de la página tras un error', async () => {
    api.login.mockReturnValue(throwError(() => authProblem(401, 'INVALID_CREDENTIALS')));

    await signIn();

    expect(root().textContent ?? '').not.toContain(PASSWORD.trim());
  });

  it('[contrato LoginRequest] con correo o contraseña vacíos marca los campos y no envía', async () => {
    await signIn('   ', '');

    expect(text('error-email')).toBe(REQUIRED_MESSAGE);
    expect(text('error-password')).toBe(REQUIRED_MESSAGE);
    expect(get('email').getAttribute('aria-invalid')).toBe('true');
    expect(get('password').getAttribute('aria-invalid')).toBe('true');
    expect(api.login).not.toHaveBeenCalled();
  });

  it('[FR-005] una contraseña de solo espacios no se recorta: se envía tal cual', async () => {
    await signIn('ana.perez@taller.ec', '   ');

    expect(query('error-password')).toBeNull();
    expect(sentBody().password).toBe('   ');
  });

  it('[edge case conexión inestable] un fallo de red muestra form-error y no navega', async () => {
    api.login.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: '/api/v1/auth/login' })),
    );

    await signIn();

    expect(text('form-error').length).toBeGreaterThan(0);
    expect(storedToken()).toBeNull();
    expect(currentUrl()).toBe('/login');
  });

  it('[FR-025] campos y botón con objetivo táctil de al menos 44 px', () => {
    for (const testId of ['email', 'password', 'submit']) {
      expect(touchSize(get(testId))).toBeGreaterThanOrEqual(44);
    }
  });
});

describe('LoginPage: ruta pública (T028)', () => {
  it('[FR-010] /login abre LoginPage sin sesión', async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: AuthApiService, useValue: { login: vi.fn(() => of(sessionResponse())) } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/login');

    expect(TestBed.inject(Router).url).toBe('/login');
    expect(page).toBeInstanceOf(LoginPage);
  });
});
