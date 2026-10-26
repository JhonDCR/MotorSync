// Utilidades de prueba de la 003 (Soporte de la plataforma y recuperación de acceso), según
// specs/003-soporte-plataforma/spec.md y specs/003-soporte-plataforma/contracts/openapi.yaml.
//
// Los tipos de aquí son una copia estructural del contrato SOLO para las pruebas: así los specs compilan
// aunque api.models.ts todavía no tenga los tipos de la 003 en la fase roja.
import type { Problem, Role, UserStatus } from '../app/core/api/api.models';
import { AUTH_MESSAGES, authProblem } from './auth-fixtures';
import { fakeJwt } from './fake-jwt';

export interface ForgotPasswordRequestFixture {
  email: string;
}

export interface SupportLoginRequestFixture {
  email: string;
  password: string;
}

export interface SupportAgentFixture {
  id: string;
  name: string;
  email: string;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
}

export interface SupportSessionResponseFixture {
  accessToken: string;
  expiresIn: number;
  agent: SupportAgentFixture;
}

export interface CurrentSupportSessionFixture {
  agent: SupportAgentFixture;
}

export type TicketStatusFixture = 'open' | 'resolved' | 'discarded';

export interface TicketAccountFixture {
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
}

export interface TicketWorkshopFixture {
  name: string;
  ruc: string | null;
}

export interface TicketSummaryFixture {
  id: string;
  number: number;
  createdAt: string;
  lastRequestedAt: string;
  requestCount: number;
  account: TicketAccountFixture;
  workshop: TicketWorkshopFixture;
}

export interface TicketResolutionFixture {
  verificationNote: string;
  resolvedByName: string;
  resolvedAt: string;
}

export interface TicketDiscardFixture {
  reason: string;
  discardedByName: string;
  discardedAt: string;
}

export interface TicketDetailFixture extends TicketSummaryFixture {
  status: TicketStatusFixture;
  resolution?: TicketResolutionFixture | null;
  discard?: TicketDiscardFixture | null;
}

export interface TicketListResponseFixture {
  items: TicketSummaryFixture[];
}

export interface DiscardTicketRequestFixture {
  reason: string;
}

export interface GenerateTemporaryPasswordRequestFixture {
  verificationNote: string;
}

export interface TemporaryPasswordResponseFixture {
  temporaryPassword: string;
  temporaryPasswordExpiresAt: string;
  sessionsClosed: number;
  ticket: TicketDetailFixture;
}

export interface WorkshopSummaryFixture {
  id: string;
  name: string;
  ruc: string | null;
  createdAt: string;
}

export interface WorkshopAccountFixture {
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  hasOpenTicket: boolean;
}

export interface AccessLogEntryFixture {
  id: string;
  occurredAt: string;
  agent: { id: string; name: string };
  workshop: { id: string; name: string; ruc: string | null };
  ip: string | null;
  channel: string;
}

export const SUPPORT_AGENT_ID = '55555555-5555-4555-8555-555555555555';
export const SUPPORT_SESSION_ID = '66666666-6666-4666-8666-666666666666';
export const TICKET_ID = '77777777-7777-4777-8777-777777777777';
export const OTHER_TICKET_ID = '88888888-8888-4888-8888-888888888888';

export const SUPPORT_EMAIL = 'pedro.soporte@motorsync.ec';
export const SUPPORT_PASSWORD = '  Soporte Seguro 2026 ';
export const SUPPORT_TEMP_PASSWORD = 'ABCD-EFGH-JKMN-PQRS';
export const SUPPORT_TOKEN_STORAGE_KEY = 'motorsync.support.token';
export const SUPPORT_JWT_AUDIENCE = 'motorsync-support';

export const FORGOT_PASSWORD_URL = '/api/v1/auth/forgot-password';
export const SUPPORT_LOGIN_URL = '/api/v1/support/auth/login';
export const SUPPORT_REFRESH_URL = '/api/v1/support/auth/refresh';
export const SUPPORT_LOGOUT_URL = '/api/v1/support/auth/logout';
export const SUPPORT_ME_URL = '/api/v1/support/auth/me';
export const SUPPORT_PASSWORD_URL = '/api/v1/support/auth/password';
export const SUPPORT_TICKETS_URL = '/api/v1/support/tickets';
export const SUPPORT_WORKSHOPS_URL = '/api/v1/support/workshops';
export const SUPPORT_ACCESS_LOG_URL = '/api/v1/support/access-log';

/** Códigos nuevos de Problem.code en el contrato 003. */
export const SUPPORT_PROBLEM_CODES = ['HELP_RATE_LIMITED', 'TICKET_NOT_OPEN', 'ACCOUNT_INACTIVE'] as const;

/**
 * Textos literales de specs/003-soporte-plataforma/spec.md y research.md (R12, R13):
 * - FR-003: mensaje genérico tras pedir ayuda en "¿Olvidaste tu contraseña?"
 * - US1-AC6 / FR-004: mensaje al superar el límite de 20 solicitudes por origen por hora
 * - US3-AC3 / FR-023: error cuando falta la nota de verificación de identidad y aviso de no escribir contraseñas
 * - US3-AC5: error al intentar generar una temporal sobre un ticket que no está abierto
 * - US3-AC8: error al intentar generar una temporal para una cuenta desactivada
 * - FR-022 / US5-AC9: mensaje de contraseña temporal vencida con ambas vías de recuperación
 * - US3-AC2 / R9 / R13: avisos del diálogo de contraseña temporal y del panel
 */
export const SUPPORT_MESSAGES = {
  FORGOT_PASSWORD_LINK: '¿Olvidaste tu contraseña?',
  FORGOT_PASSWORD_ACCEPTED:
    'Si el correo corresponde a una cuenta de MotorSync, nuestro equipo de soporte se pondrá en contacto con usted para verificar su identidad y ayudarle a recuperar el acceso.',
  HELP_RATE_LIMITED: 'Demasiadas solicitudes. Intente de nuevo más tarde',
  TEMPORARY_PASSWORD_EXPIRED: AUTH_MESSAGES.TEMPORARY_PASSWORD_EXPIRED,
  VERIFICATION_NOTE_REQUIRED: 'Indique cómo verificó la identidad de la persona',
  VERIFICATION_NOTE_WARNING: 'No escriba contraseñas en la nota',
  TICKET_NOT_OPEN: 'Solo se puede generar una contraseña temporal sobre un ticket abierto',
  ACCOUNT_INACTIVE: 'La cuenta está desactivada; el administrador de su taller debe reactivarla',
  TEMPORARY_PASSWORD_FORMAT_NOTICE: 'Escríbala tal cual, con los guiones y en mayúsculas',
  TEMPORARY_PASSWORD_ONCE_NOTICE: 'Esta contraseña temporal se muestra una sola vez y no se volverá a mostrar',
  PANEL_HEADER: 'Soporte MotorSync',
  AUDIT_ACTOR_PREFIX: 'Soporte MotorSync',
  WORKSHOP_NOT_FOUND: 'Taller no encontrado',
} as const;

/** Motivos con los que se llega a /support/login (query `reason`), equivalentes a los del taller (R4, R13). */
export const SUPPORT_LOGIN_REASON_MESSAGES = {
  expired: 'Su sesión expiró por inactividad',
  revoked: 'Su sesión fue cerrada. Vuelva a iniciar sesión',
  logout: 'Cerró su sesión',
  'temporary-expired': AUTH_MESSAGES.TEMPORARY_PASSWORD_EXPIRED,
} as const;

export type SupportLoginReason = keyof typeof SUPPORT_LOGIN_REASON_MESSAGES;

/**
 * JWT de soporte con los claims del contrato 003 (sub, sid, name, pwd_change, aud: 'motorsync-support', exp).
 * Nunca incluye tenant_id ni role (FR-008, R3).
 */
export function supportSessionToken(
  name = 'Pedro Soporte',
  mustChangePassword = false,
  overrides: Record<string, unknown> = {},
): string {
  return fakeJwt({
    sub: SUPPORT_AGENT_ID,
    sid: SUPPORT_SESSION_ID,
    name,
    pwd_change: mustChangePassword,
    aud: SUPPORT_JWT_AUDIENCE,
    exp: Math.floor(Date.now() / 1000) + 900,
    ...overrides,
  });
}

export function supportSessionResponse(
  overrides: Partial<SupportAgentFixture> = {},
): SupportSessionResponseFixture {
  const agent: SupportAgentFixture = {
    id: SUPPORT_AGENT_ID,
    name: 'Pedro Soporte',
    email: SUPPORT_EMAIL,
    mustChangePassword: false,
    temporaryPasswordExpiresAt: null,
    ...overrides,
  };
  return {
    accessToken: supportSessionToken(agent.name, agent.mustChangePassword, { sub: agent.id }),
    expiresIn: 900,
    agent,
  };
}

export function currentSupportSession(
  overrides: Partial<SupportAgentFixture> = {},
): CurrentSupportSessionFixture {
  return { agent: supportSessionResponse(overrides).agent };
}

export function ticketSummaryFixture(overrides: Partial<TicketSummaryFixture> = {}): TicketSummaryFixture {
  return {
    id: TICKET_ID,
    number: 101,
    createdAt: '2026-10-25T14:00:00.000Z',
    lastRequestedAt: '2026-10-25T14:00:00.000Z',
    requestCount: 1,
    account: {
      email: 'ana.perez@taller.ec',
      name: 'Ana Pérez',
      role: 'admin',
      status: 'active',
    },
    workshop: {
      name: 'Taller Andrade',
      ruc: '1790012345001',
    },
    ...overrides,
  };
}

export function ticketDetailFixture(overrides: Partial<TicketDetailFixture> = {}): TicketDetailFixture {
  return {
    ...ticketSummaryFixture(overrides),
    status: 'open',
    resolution: null,
    discard: null,
    ...overrides,
  };
}

export function supportProblem(status: number, code: string, extra: Partial<Problem> = {}): Problem {
  return authProblem(status, code, extra);
}
