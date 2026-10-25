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
  TEMPORARY_PASSWORD_EXPIRED:
    'Su contraseña temporal venció. Pida al administrador de su taller que la restablezca o use ¿Olvidaste tu contraseña?',
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

// --- PR2 (US3, US5): sesión, refresh, logout, me y cambio de contraseña ---
//
// Igual que arriba, tipos estructurales SOLO para las pruebas. El implementer-frontend (T040, T042, T044) debe
// exportar desde core/api/api.models.ts los equivalentes del contrato: ChangePasswordRequest
// ({ currentPassword, newPassword }) y el schema CurrentSession ({ user, workshop }) de GET /auth/me. Como
// core/auth/current-session.ts ya exporta otro `CurrentSession` (rol y nombre del JWT, 001), el nombre del tipo de
// /auth/me en api.models.ts queda a criterio del implementer (por ejemplo `CurrentSessionResponse`).

export interface ChangePasswordRequestFixture {
  currentPassword: string;
  newPassword: string;
}

export interface CurrentSessionFixture {
  user: SessionUserFixture;
  workshop: { id: string; name: string };
}

/** Nueva contraseña válida con espacios al inicio y al final: tampoco se recorta (FR-005). */
export const NEW_PASSWORD = ' Nueva Clave Segura 2027  ';

/** Contraseña temporal que el administrador entregó (US4-AC2); válida según FR-005. */
export const TEMPORARY_PASSWORD = 'Temporal 2026!';

export const REQUESTED_WITH_HEADER = 'X-Requested-With';
export const REQUESTED_WITH_VALUE = 'motorsync';

export const LOGIN_URL = '/api/v1/auth/login';
export const REFRESH_URL = '/api/v1/auth/refresh';
export const LOGOUT_URL = '/api/v1/auth/logout';
export const ME_URL = '/api/v1/auth/me';
export const PASSWORD_URL = '/api/v1/auth/password';

/** Problem en application/problem+json, como lo responde el backend. */
export const PROBLEM_HEADERS = { 'Content-Type': 'application/problem+json' } as const;

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  409: 'Conflict',
  429: 'Too Many Requests',
};

/** Opciones de TestRequest.flush para responder un Problem con su status. */
export function problemFlush(status: number): { status: number; statusText: string; headers: typeof PROBLEM_HEADERS } {
  return { status, statusText: STATUS_TEXT[status] ?? 'Error', headers: PROBLEM_HEADERS };
}

/** Respuesta de GET /auth/me (schema CurrentSession del contrato 002). */
export function currentSession(overrides: Partial<SessionUserFixture> = {}): CurrentSessionFixture {
  const { user, workshop } = sessionResponse(overrides);
  return { user, workshop };
}

/** SessionResponse con un accessToken propio (para distinguir el token viejo del nuevo tras un refresh). */
export function sessionResponseWithToken(
  accessToken: string,
  overrides: Partial<SessionUserFixture> = {},
): SessionResponseFixture {
  return { ...sessionResponse(overrides), accessToken };
}

/** Claims del payload de un JWT (sin verificar la firma); null si no se puede leer. */
export function decodeClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Motivos con los que se llega a /login (query `reason`) y el mensaje que muestra la página
 * (data-testid="session-reason"). "expired" es literal de spec.md (US3-AC2); "temporary-expired" es el de US5-AC9;
 * "revoked" y "logout" los fija esta suite.
 */
export const LOGIN_REASON_MESSAGES = {
  expired: 'Su sesión expiró por inactividad',
  revoked: 'Su sesión fue cerrada. Vuelva a iniciar sesión',
  logout: 'Cerró su sesión',
  'temporary-expired':
    'Su contraseña temporal venció. Pida al administrador de su taller que la restablezca o use ¿Olvidaste tu contraseña?',
} as const;

export type LoginReason = keyof typeof LOGIN_REASON_MESSAGES;

/** Mensajes de la pantalla de cambio de contraseña (US5). Los dos primeros son literales de spec.md. */
export const CHANGE_PASSWORD_MESSAGES = {
  MUST_CHANGE: 'Debe cambiar su contraseña antes de continuar',
  CURRENT_PASSWORD_INCORRECT: 'La contraseña actual no es correcta',
  PASSWORD_TOO_SHORT: 'La contraseña debe tener al menos 8 caracteres',
  PASSWORD_TOO_LONG: 'La contraseña admite como máximo 128 caracteres',
  SAME_PASSWORD: 'La nueva contraseña debe ser distinta de la actual',
  CONFIRMATION_MISMATCH: 'Las contraseñas no coinciden',
  REQUIRED: 'Este campo es obligatorio',
} as const;
