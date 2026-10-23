// T026 (002, PR1, US1): página pública de registro del taller y su primer administrador.
// Según research R13, el componente se prueba con AuthApiService simulado (contrato en
// core/api/auth-api.service.spec.ts y specs/002-autenticacion/contracts/openapi.yaml).
//
// Contrato para el implementer-frontend (T027), archivo features/auth/register.page.ts (+ .html y .scss):
//   export class RegisterPage (standalone). Ruta PÚBLICA `register` en app.routes.ts (loadComponent, title
//   "Registrar taller"); en el PR1 no hay guards: basta con que la ruta exista y no exija sesión.
//   Usa AuthApiService.register(body: RegisterRequest).
//   Al registrarse (201): guarda session.accessToken en localStorage 'motorsync.token' (AUTH_TOKEN_STORAGE_KEY de
//   core/auth/auth-token.interceptor.ts) y navega a `/`. En el PR1 no hay refresh: el token dura 15 min.
// Selectores (data-testid), cada <input> con su <label for> y texto visible:
//   workshop-name, ruc, name, email          <input> (nombre comercial, RUC del taller, su nombre, correo)
//   password                                 <input type="password">
//   submit                                   botón "Registrar" (submit del formulario)
//   error-<campo>                            mensaje junto al campo, con el nombre del contrato:
//                                            error-workshopName, error-ruc, error-name, error-email, error-password.
//                                            El <input> con error lleva aria-invalid="true".
//   form-error                               mensaje general (role="alert") para errores que no son de un campo.
// Validación antes de enviar (si falla, NO se llama a register y se marcan TODOS los campos con error):
//   - vacío o solo espacios → "Este campo es obligatorio" (en password, vacío; la contraseña no se recorta).
//   - ruc: normalizeDocument + isValidRuc de shared/identifiers → "RUC inválido".
//   - email: normalizeEmail + isValidEmail → "Correo electrónico inválido".
//   - password: de 8 a 128 caracteres Unicode contados con [...password].length, SIN recortar → menos de 8:
//     fieldErrorMessage({ code: 'PASSWORD_TOO_SHORT' }) de core/api/problem.ts (menciona "8 caracteres").
// Cuerpo enviado: exactamente { workshopName, ruc, name, email, password }, nunca tenantId ni role (US1-AC9).
//   workshopName y name recortados; ruc puede ir normalizado o tal cual; email puede ir normalizado o tal cual;
//   password EXACTAMENTE como se escribió (FR-005).
// Respuestas de error:
//   409 RUC_ALREADY_REGISTERED → error-ruc "Este RUC ya tiene un taller registrado en MotorSync" (US1-AC4).
//   409 REGISTRATION_FAILED    → form-error "No se pudo completar el registro con estos datos; si ya tiene una
//                                cuenta, inicie sesión", SIN error-email ni aria-invalid en email (US1-AC5).
//   400 VALIDATION_ERROR       → errors[] en error-<campo> con fieldErrorMessages() de core/api/problem.ts.
//   Fallo de red (status 0)    → form-error con un mensaje no vacío. En ningún error se navega ni se guarda token.
//   La contraseña no aparece nunca en el texto de la página (FR-006).
// Mobile-first (FR-025): los <input> y el botón submit tienen min-height de al menos 44 px (mixin touch-target de
//   shared/styles/_touch.scss).
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { routes } from '../../app.routes';
import { AuthApiService } from '../../core/api/auth-api.service';
import { fieldErrorMessage } from '../../core/api/problem';
import { AUTH_TOKEN_STORAGE_KEY } from '../../core/auth/auth-token.interceptor';
import {
  AUTH_MESSAGES,
  authProblem,
  INVALID_RUCS,
  PASSWORD,
  sessionResponse,
  touchSize,
  VALID_RUC,
  type RegisterRequestFixture,
} from '../../../testing/auth-fixtures';
import { RegisterPage } from './register.page';

@Component({ template: '' })
class StubPage {}

const FIELDS = [
  ['workshop-name', 'workshopName'],
  ['ruc', 'ruc'],
  ['name', 'name'],
  ['email', 'email'],
  ['password', 'password'],
] as const;

const REQUIRED_MESSAGE = 'Este campo es obligatorio';

describe('RegisterPage (T026)', () => {
  let fixture: ComponentFixture<RegisterPage>;
  let api: { register: ReturnType<typeof vi.fn<AuthApiService['register']>> };

  beforeEach(async () => {
    localStorage.clear();
    api = { register: vi.fn<AuthApiService['register']>(() => of(sessionResponse())) };
    await TestBed.configureTestingModule({
      imports: [RegisterPage],
      providers: [
        provideRouter([
          { path: '', component: StubPage },
          { path: 'login', component: StubPage },
          { path: 'register', component: StubPage },
        ]),
        { provide: AuthApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(RegisterPage);
    // Parte de /register: así "no navega" se distingue de "navega a /".
    await TestBed.inject(Router).navigateByUrl('/register');
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

  async function submit(): Promise<void> {
    get('submit').click();
    await settle();
  }

  async function fillValid(overrides: Partial<Record<(typeof FIELDS)[number][0], string>> = {}): Promise<void> {
    const values = {
      'workshop-name': '  Taller Andrade ',
      ruc: '1790012345-001',
      name: 'Ana Pérez',
      email: ' Ana.Perez@Taller.EC ',
      password: PASSWORD,
      ...overrides,
    };
    for (const [testId] of FIELDS) {
      await type(testId, values[testId]);
    }
  }

  function sentBody(call = 0): RegisterRequestFixture {
    return api.register.mock.calls[call][0] as RegisterRequestFixture;
  }

  function currentUrl(): string {
    return TestBed.inject(Router).url;
  }

  function storedToken(): string | null {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  }

  // --- pruebas ---

  it('[FR-001][FR-025] cada campo tiene su label visible y la contraseña es type="password"', () => {
    for (const [testId] of FIELDS) {
      const input = get<HTMLInputElement>(testId);
      expect(input.tagName).toBe('INPUT');
      expect(input.labels?.length ?? 0).toBeGreaterThan(0);
      expect(input.labels?.[0].textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
    expect(get<HTMLInputElement>('password').type).toBe('password');
  });

  it('[US1-AC1] al registrarse guarda el accessToken en localStorage "motorsync.token" y navega a /', async () => {
    const session = sessionResponse();
    api.register.mockReturnValue(of(session));

    await fillValid();
    await submit();

    expect(api.register).toHaveBeenCalledTimes(1);
    expect(storedToken()).toBe(session.accessToken);
    expect(currentUrl()).toBe('/');
  });

  it('[US1-AC1][US1-AC2][FR-005] envía los 5 campos; la contraseña exactamente como se escribió', async () => {
    await fillValid();
    await submit();

    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(['email', 'name', 'password', 'ruc', 'workshopName']);
    expect(body.workshopName).toBe('Taller Andrade');
    expect(body.name).toBe('Ana Pérez');
    expect(body.ruc.replace(/[\s-]/g, '')).toBe(VALID_RUC);
    expect(body.email.trim().toLowerCase()).toBe('ana.perez@taller.ec');
    expect(body.password).toBe(PASSWORD);
  });

  it('[US1-AC9] el cuerpo nunca lleva tenantId ni role', async () => {
    await fillValid();
    await submit();

    const keys = Object.keys(sentBody());
    expect(keys).not.toContain('tenantId');
    expect(keys).not.toContain('tenant_id');
    expect(keys).not.toContain('role');
  });

  it.each(INVALID_RUCS)('[US1-AC3] RUC inválido %s → "RUC inválido" junto al campo y no envía', async (ruc) => {
    await fillValid({ ruc });
    await submit();

    expect(text('error-ruc')).toBe('RUC inválido');
    expect(get('ruc').getAttribute('aria-invalid')).toBe('true');
    expect(api.register).not.toHaveBeenCalled();
  });

  it('[US1-AC3] un 400 INVALID_RUC del servidor también se muestra junto al RUC', async () => {
    api.register.mockReturnValue(
      throwError(() =>
        authProblem(400, 'VALIDATION_ERROR', { errors: [{ field: 'ruc', code: 'INVALID_RUC', message: 'x' }] }),
      ),
    );
    await fillValid();
    await submit();

    expect(text('error-ruc')).toBe('RUC inválido');
    expect(storedToken()).toBeNull();
  });

  it('[US1-AC4][FR-023] 409 RUC_ALREADY_REGISTERED → "Este RUC ya tiene un taller registrado en MotorSync" junto al RUC', async () => {
    api.register.mockReturnValue(throwError(() => authProblem(409, 'RUC_ALREADY_REGISTERED')));
    await fillValid();
    await submit();

    expect(text('error-ruc')).toBe(AUTH_MESSAGES.RUC_ALREADY_REGISTERED);
    expect(get('ruc').getAttribute('aria-invalid')).toBe('true');
    expect(storedToken()).toBeNull();
    expect(currentUrl()).toBe('/register');
  });

  it('[US1-AC5][FR-023] 409 REGISTRATION_FAILED → mensaje genérico, sin marcar el correo', async () => {
    api.register.mockReturnValue(throwError(() => authProblem(409, 'REGISTRATION_FAILED')));
    await fillValid();
    await submit();

    expect(text('form-error')).toBe(AUTH_MESSAGES.REGISTRATION_FAILED);
    expect(get('form-error').getAttribute('role')).toBe('alert');
    expect(query('error-email')).toBeNull();
    expect(get('email').getAttribute('aria-invalid')).not.toBe('true');
    expect(storedToken()).toBeNull();
    expect(currentUrl()).toBe('/register');
  });

  it('[FR-006] la contraseña no aparece en el texto de la página tras un error', async () => {
    api.register.mockReturnValue(throwError(() => authProblem(409, 'REGISTRATION_FAILED')));
    await fillValid();
    await submit();

    expect(root().textContent ?? '').not.toContain(PASSWORD.trim());
  });

  it('[US1-AC6] con el formulario vacío marca cada campo obligatorio y no envía', async () => {
    await submit();

    for (const [testId, field] of FIELDS) {
      expect(text(`error-${field}`)).toBe(REQUIRED_MESSAGE);
      expect(get(testId).getAttribute('aria-invalid')).toBe('true');
    }
    expect(api.register).not.toHaveBeenCalled();
  });

  it('[US1-AC6] nombre comercial y nombre con solo espacios cuentan como vacíos', async () => {
    await fillValid({ 'workshop-name': '   ', name: '  ' });
    await submit();

    expect(text('error-workshopName')).toBe(REQUIRED_MESSAGE);
    expect(text('error-name')).toBe(REQUIRED_MESSAGE);
    expect(api.register).not.toHaveBeenCalled();
  });

  it('[US1-AC6][FR-005] contraseña de menos de 8 caracteres → error en el campo y no envía', async () => {
    const expected = fieldErrorMessage({ field: 'password', code: 'PASSWORD_TOO_SHORT', message: 'x' });
    expect(expected).toMatch(/8 caracteres/);

    for (const password of ['Abc1234', '😀'.repeat(7)]) {
      await fillValid({ password });
      await submit();
      expect(text('error-password')).toBe(expected);
      expect(get('password').getAttribute('aria-invalid')).toBe('true');
    }
    expect(api.register).not.toHaveBeenCalled();
  });

  it('[FR-005] 8 caracteres Unicode bastan y los espacios cuentan (no se recorta)', async () => {
    await fillValid({ password: ' abcdef ' });
    await submit();

    expect(query('error-password')).toBeNull();
    expect(sentBody().password).toBe(' abcdef ');
  });

  it('[US1-AC6] correo con formato inválido → "Correo electrónico inválido" y no envía', async () => {
    await fillValid({ email: 'ana@taller' });
    await submit();

    expect(text('error-email')).toBe('Correo electrónico inválido');
    expect(get('email').getAttribute('aria-invalid')).toBe('true');
    expect(api.register).not.toHaveBeenCalled();
  });

  it('[US1-AC6] los errors[] de un 400 del servidor se muestran junto a cada campo', async () => {
    api.register.mockReturnValue(
      throwError(() =>
        authProblem(400, 'VALIDATION_ERROR', {
          errors: [
            { field: 'password', code: 'PASSWORD_TOO_SHORT', message: 'x' },
            { field: 'email', code: 'INVALID_EMAIL', message: 'x' },
          ],
        }),
      ),
    );
    await fillValid();
    await submit();

    expect(text('error-password')).toBe(
      fieldErrorMessage({ field: 'password', code: 'PASSWORD_TOO_SHORT', message: 'x' }),
    );
    expect(text('error-email')).toBe('Correo electrónico inválido');
    expect(storedToken()).toBeNull();
  });

  it('[edge case conexión inestable] un fallo de red muestra form-error y no navega', async () => {
    api.register.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: '/api/v1/auth/register' })),
    );
    await fillValid();
    await submit();

    expect(text('form-error').length).toBeGreaterThan(0);
    expect(storedToken()).toBeNull();
    expect(currentUrl()).toBe('/register');
  });

  it('[FR-025] campos y botón con objetivo táctil de al menos 44 px', () => {
    for (const testId of [...FIELDS.map(([id]) => id), 'submit']) {
      expect(touchSize(get(testId))).toBeGreaterThanOrEqual(44);
    }
  });
});

describe('RegisterPage: ruta pública (T026)', () => {
  it('[FR-001][FR-010] /register abre RegisterPage sin sesión', async () => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: AuthApiService, useValue: { register: vi.fn(() => of(sessionResponse())) } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/register');

    expect(TestBed.inject(Router).url).toBe('/register');
    expect(page).toBeInstanceOf(RegisterPage);
  });
});
