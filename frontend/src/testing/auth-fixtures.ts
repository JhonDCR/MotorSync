// Utilidades de prueba de la 002 (PR1: registro e inicio de sesión), según
// specs/002-autenticacion/contracts/openapi.yaml.
//
// Los tipos de aquí son una copia estructural del contrato SOLO para las pruebas: así los specs compilan
// aunque api.models.ts todavía no tenga los tipos de la 002. El implementer-frontend (T025) debe exportar desde
// core/api/api.models.ts los tipos equivalentes (RegisterRequest, LoginRequest, SessionUser, Workshop,
// SessionResponse) y ampliar PROBLEM_CODES y FieldErrorCode con los códigos del contrato 002.
import type { Problem } from '../app/core/api/api.models';
import { fakeJwt, TENANT_A } from './fake-jwt';

export interface RegisterRequestFixture {
  workshopName: string;
  ruc: string;
  name: string;
  email: string;
  password: string;
}

export interface LoginRequestFixture {
  email: string;
  password: string;
}

export interface SessionUserFixture {
  id: string;
  name: string;
  email: string;
  role: 'asesor' | 'admin';
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
}

export interface SessionResponseFixture {
  accessToken: string;
  expiresIn: number;
  user: SessionUserFixture;
  workshop: { id: string; name: string };
}

export const ADMIN_USER_ID = '33333333-3333-4333-8333-333333333333';
export const SESSION_ID = '44444444-4444-4444-8444-444444444444';

/** RUC válidos (sociedad privada, tercer dígito 9). Los datos semilla del mock no deben usarlos. */
export const VALID_RUC = '1790012345001';
export const OTHER_VALID_RUC = '0990011223001';
export const THIRD_VALID_RUC = '1890001122001';

/** RUC inválidos de US1-AC3: 12 dígitos, sin 001 y con tercer dígito 7. */
export const INVALID_RUCS = ['179001234500', '1790012345002', '1770012345001'] as const;

/** Contraseña con espacios y mayúsculas: nunca se recorta ni se transforma (FR-005). */
export const PASSWORD = '  Clave Segura 2026 ';

export const REGISTER_BODY: RegisterRequestFixture = {
  workshopName: 'Taller Andrade',
  ruc: VALID_RUC,
  name: 'Ana Pérez',
  email: 'ana.perez@taller.ec',
  password: PASSWORD,
};

/** JWT con los claims del contrato 002 (sub, tenant_id, role, name, exp, sid, pwd_change). */
export function sessionToken(role: 'asesor' | 'admin', name: string, mustChangePassword = false): string {
  return fakeJwt({
    sub: ADMIN_USER_ID,
    tenant_id: TENANT_A,
    role,
    name,
    sid: SESSION_ID,
    pwd_change: mustChangePassword,
    exp: Math.floor(Date.now() / 1000) + 900,
  });
}

export function sessionResponse(overrides: Partial<SessionUserFixture> = {}): SessionResponseFixture {
  const user: SessionUserFixture = {
    id: ADMIN_USER_ID,
    name: 'Ana Pérez',
    email: 'ana.perez@taller.ec',
    role: 'admin',
    mustChangePassword: false,
    temporaryPasswordExpiresAt: null,
    ...overrides,
  };
  return {
    accessToken: sessionToken(user.role, user.name, user.mustChangePassword),
    expiresIn: 900,
    user,
    workshop: { id: TENANT_A, name: 'Taller Andrade' },
  };
}

/** Problem del contrato 002. El cast permite usar códigos que PROBLEM_CODES aún no incluye. */
export function authProblem(status: number, code: string, extra: Partial<Problem> = {}): Problem {
  return { type: 'about:blank', title: 'Error', status, code: code as Problem['code'], ...extra };
}

/** Códigos nuevos del enum Problem.code del contrato 002 (además de los de la 001). */
export const AUTH_PROBLEM_CODES = [
  'TOKEN_EXPIRED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'REFRESH_CONFLICT',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'TEMPORARY_PASSWORD_EXPIRED',
  'PASSWORD_CHANGE_REQUIRED',
  'CURRENT_PASSWORD_INCORRECT',
  'RUC_ALREADY_REGISTERED',
  'REGISTRATION_FAILED',
  'EMAIL_UNAVAILABLE',
  'LAST_ADMIN',
  'SELF_RESET_NOT_ALLOWED',
  'FORBIDDEN',
] as const;

/** Mensajes que spec.md fija literalmente (US1-AC4, US1-AC5, US2-AC3, US2-AC5, US5-AC9). */
export const AUTH_MESSAGES = {
  RUC_ALREADY_REGISTERED: 'Este RUC ya tiene un taller registrado en MotorSync',
  REGISTRATION_FAILED: 'No se pudo completar el registro con estos datos; si ya tiene una cuenta, inicie sesión',
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos',
  ACCOUNT_LOCKED: 'Demasiados intentos fallidos. Intente de nuevo en unos minutos',
  TEMPORARY_PASSWORD_EXPIRED: 'Su contraseña temporal venció. Pida al administrador de su taller que la restablezca',
} as const;

/** min-height (o height) calculado en px; acepta rem/em a 16 px. NaN si no hay valor. */
export function touchSize(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const toPx = (value: string): number => {
    const match = /^([\d.]+)(px|rem|em)$/.exec(value.trim());
    if (match === null) return Number.NaN;
    return match[2] === 'px' ? Number(match[1]) : Number(match[1]) * 16;
  };
  const values = [toPx(style.minHeight), toPx(style.height)].filter((v) => !Number.isNaN(v));
  return values.length === 0 ? Number.NaN : Math.max(...values);
}
