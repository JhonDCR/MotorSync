import { inject, Injectable } from '@angular/core';
import { isValidEmail, normalizeEmail } from '../../shared/identifiers/email';
import { normalizeDocument } from '../../shared/identifiers/normalize';
import type {
  AccessLogEntry,
  AccessLogResponse,
  CurrentSupportSessionResponse,
  FieldError,
  Problem,
  SupportAgent,
  SupportSessionResponse,
  TemporaryPasswordResponse,
  TicketDetail,
  TicketDiscard,
  TicketListResponse,
  TicketResolution,
  TicketStatus,
  TicketSummary,
  UserStatus,
  WorkshopAccount,
  WorkshopAccountsResponse,
  WorkshopListResponse,
  WorkshopSummary,
} from './api.models';
import { mockProblem, newId, type MockResult } from './mock-api.store';
import { MockAuthStore } from './mock-auth.store';

// In-memory support accounts, sessions, tickets and rate-limiting of the mock API for /auth/forgot-password
// and /support/* (specs/003-soporte-plataforma/contracts/openapi.yaml, research R13).
// It lives in the root injector alongside MockAuthStore.

const LOGIN_FIELDS = ['email', 'password'] as const;
const CHANGE_PASSWORD_FIELDS = ['currentPassword', 'newPassword'] as const;
const DISCARD_TICKET_FIELDS = ['reason'] as const;
const GENERATE_TEMP_PASSWORD_FIELDS = ['verificationNote'] as const;
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const REASON_MAX_LENGTH = 500;
const VERIFICATION_NOTE_MAX_LENGTH = 1000;
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ACCESS_TOKEN_TTL_SECONDS = 900;
const SUPPORT_JWT_AUDIENCE = 'motorsync-support';
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const HELP_RATE_LIMIT_MAX = 20;
const HELP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Contract `GET /support/workshops.q`: 1 to 120 characters after trimming. */
const WORKSHOP_QUERY_MAX_LENGTH = 120;
/** Contract `GET /support/workshops` and `GET /support/access-log`: fixed page size (FR-027). */
const SUPPORT_PAGE_SIZE = 50;

const SEED_SUPPORT_ACCOUNT = {
  name: 'Soporte Demo MotorSync',
  email: 'soporte@motorsync.test',
  password: 'Demo Soporte 2026',
};

export interface MockSupportAccountInput {
  id?: string;
  name: string;
  email: string;
  password: string;
  status?: UserStatus;
  mustChangePassword?: boolean;
  temporaryPasswordExpiresAt?: string | null;
}

interface MockSupportAccount {
  id: string;
  name: string;
  email: string;
  password: string;
  status: UserStatus;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
}

interface MockSupportSession {
  accountId: string;
  revoked: boolean;
}

interface LoginThrottle {
  failures: number;
  lockedUntil: number | null;
}

interface MockTicket {
  id: string;
  number: number;
  accountId: string;
  createdAt: string;
  lastRequestedAt: string;
  requestCount: number;
  status: TicketStatus;
  resolution: TicketResolution | null;
  discard: TicketDiscard | null;
}

interface SupportTokenClaims {
  sub: string | null;
  sid: string | null;
  name: string;
  pwdChange: boolean;
  aud: string | null;
  tenantId: string | null;
  role: string | null;
}

type MockSupportSessionCheck =
  | { ok: true; account: MockSupportAccount; sessionId: string }
  | { ok: false; problem: Problem };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unicodeLength(value: string): number {
  return [...value].length;
}

function base64UrlEncode(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) return null;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function supportAccessTokenFor(account: MockSupportAccount, sessionId: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: account.id,
      sid: sessionId,
      name: account.name,
      pwd_change: account.mustChangePassword,
      aud: SUPPORT_JWT_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    }),
  );
  return `${header}.${payload}.mock-support-signature`;
}

function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readSupportClaims(token: string | null): SupportTokenClaims | null {
  const parts = token?.split('.') ?? [];
  if (parts.length !== 3) return null;
  const json = base64UrlDecode(parts[1]);
  if (json === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  return {
    sub: stringClaim(payload, 'sub'),
    sid: stringClaim(payload, 'sid'),
    name: stringClaim(payload, 'name') ?? '',
    pwdChange: payload['pwd_change'] === true,
    aud: stringClaim(payload, 'aud'),
    tenantId: stringClaim(payload, 'tenant_id'),
    role: stringClaim(payload, 'role'),
  };
}

function fail<T>(status: number, code: Problem['code'], extra: Partial<Problem> = {}): MockResult<T> {
  return { ok: false, problem: mockProblem(status, code, extra) };
}

function temporaryPasswordExpired(account: MockSupportAccount, now: number): boolean {
  return (
    account.mustChangePassword &&
    account.temporaryPasswordExpiresAt !== null &&
    Date.parse(account.temporaryPasswordExpiresAt) <= now
  );
}

function csrfFailure<T>(): MockResult<T> {
  return fail(400, 'VALIDATION_ERROR', {
    errors: [{ field: 'X-Requested-With', code: 'REQUIRED', message: 'Falta la cabecera X-Requested-With' }],
  });
}

class FieldErrors {
  readonly list: FieldError[] = [];

  add(field: string, code: string, message: string): void {
    this.list.push({ field, code, message });
  }
}

function checkUnknownFields(body: Record<string, unknown>, allowed: readonly string[], errors: FieldErrors): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      errors.add(key, 'UNKNOWN_FIELD', 'Campo no permitido');
    }
  }
}

function readRequiredText(body: Record<string, unknown>, field: string, errors: FieldErrors): string | null {
  const value = body[field];
  if (value === undefined || value === null) {
    errors.add(field, 'REQUIRED', 'Campo obligatorio');
    return null;
  }
  if (typeof value !== 'string') {
    errors.add(field, 'VALIDATION_ERROR', 'Debe ser texto');
    return null;
  }
  if (value.trim() === '') {
    errors.add(field, 'REQUIRED', 'Campo obligatorio');
    return null;
  }
  return value;
}

function readEmail(body: Record<string, unknown>, errors: FieldErrors): string | null {
  const value = readRequiredText(body, 'email', errors);
  if (value === null) return null;
  const email = normalizeEmail(value);
  if (email.length > EMAIL_MAX_LENGTH || !isValidEmail(email)) {
    errors.add('email', 'INVALID_EMAIL', 'Correo electrónico inválido');
    return null;
  }
  return email;
}

function readPassword(
  body: Record<string, unknown>,
  errors: FieldErrors,
  minLength: number,
  field = 'password',
): string | null {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    errors.add(field, 'REQUIRED', 'Campo obligatorio');
    return null;
  }
  if (typeof value !== 'string') {
    errors.add(field, 'VALIDATION_ERROR', 'Debe ser texto');
    return null;
  }
  const length = unicodeLength(value);
  if (length < minLength) {
    errors.add(field, 'PASSWORD_TOO_SHORT', `Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
    return null;
  }
  if (length > PASSWORD_MAX_LENGTH) {
    errors.add(field, 'PASSWORD_TOO_LONG', `Admite como máximo ${PASSWORD_MAX_LENGTH} caracteres`);
    return null;
  }
  return value;
}

function definedEntries(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
}

function notAnObject<T>(): MockResult<T> {
  return fail(400, 'VALIDATION_ERROR', {
    errors: [{ field: 'body', code: 'VALIDATION_ERROR', message: 'El cuerpo debe ser un objeto JSON' }],
  });
}

function validationFailed<T>(errors: FieldErrors): MockResult<T> {
  return fail(400, 'VALIDATION_ERROR', { errors: errors.list });
}

/** Lowercase without diacritics, for the name search of US4-AC2. */
function normalizeSearchText(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Contract `q` of GET /support/workshops: trimmed, 1 to 120 characters. */
function readWorkshopQuery(raw: string | null | undefined, errors: FieldErrors): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (unicodeLength(trimmed) < 1 || unicodeLength(trimmed) > WORKSHOP_QUERY_MAX_LENGTH) {
    errors.add(
      'q',
      'VALIDATION_ERROR',
      `La búsqueda admite entre 1 y ${WORKSHOP_QUERY_MAX_LENGTH} caracteres`,
    );
    return undefined;
  }
  return trimmed;
}

/** 1-based page number; anything that is not an integer greater than or equal to 1 is a 400. */
function readPage(raw: string | null | undefined, errors: FieldErrors): number {
  if (raw === undefined || raw === null) return 1;
  const trimmed = raw.trim();
  const page = Number(trimmed);
  if (trimmed === '' || !Number.isInteger(page) || page < 1) {
    errors.add('page', 'VALIDATION_ERROR', 'La página debe ser un entero mayor o igual a 1');
    return 1;
  }
  return page;
}

/** Optional uuid filter of GET /support/access-log; a non-uuid value is a 400 on its field. */
function readOptionalUuid(
  raw: string | null | undefined,
  field: string,
  errors: FieldErrors,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (!UUID_PATTERN.test(trimmed)) {
    errors.add(field, 'VALIDATION_ERROR', 'Debe ser un uuid');
    return undefined;
  }
  return trimmed;
}

/**
 * US4-AC2: a value that normalizes to digits is a RUC prefix (with or without spaces/dashes);
 * anything else is part of the commercial name, without case or diacritics. `%` and `_` are literal.
 */
function matchesWorkshop(workshop: WorkshopSummary, query: string): boolean {
  const normalizedDocument = normalizeDocument(query);
  if (/^\d+$/.test(normalizedDocument)) {
    return workshop.ruc !== null && workshop.ruc.startsWith(normalizedDocument);
  }
  return normalizeSearchText(workshop.name).includes(normalizeSearchText(query));
}

@Injectable({ providedIn: 'root' })
export class MockSupportStore {
  private readonly authStore = inject(MockAuthStore);
  /** Support accounts by normalized email. */
  private readonly accounts = new Map<string, MockSupportAccount>();
  /** Login throttling by normalized email. */
  private readonly throttles = new Map<string, LoginThrottle>();
  /** Support sessions by id (`sid` claim). */
  private readonly sessions = new Map<string, MockSupportSession>();
  /** Help request timestamps by simulated origin. */
  private readonly helpRateByOrigin = new Map<string, number[]>();
  /** Tickets by id, in creation order. */
  private readonly tickets = new Map<string, MockTicket>();
  /** Support access log: one entry per successful workshop accounts query, in insertion order (FR-018). */
  private readonly accessLog: AccessLogEntry[] = [];
  private nextTicketNumber = 101;
  private lastTimestampMs = 0;
  /** Simulated HttpOnly cookie `ms_support_refresh` of this browser. */
  private supportRefreshCookie: string | null = null;

  constructor() {
    this.authStore.registerSupportEmailCheck((email) => this.accounts.has(email));
    this.addSupportAccount({
      name: SEED_SUPPORT_ACCOUNT.name,
      email: SEED_SUPPORT_ACCOUNT.email,
      password: SEED_SUPPORT_ACCOUNT.password,
      status: 'active',
      mustChangePassword: false,
    });
  }

  addSupportAccount(input: MockSupportAccountInput): void {
    const email = normalizeEmail(input.email);
    if (this.accounts.has(email) || this.authStore.hasEmail(email)) {
      throw new Error(`MockSupportStore.addSupportAccount: email already in use: ${email}`);
    }
    const mustChangePassword = input.mustChangePassword ?? false;
    const temporaryPasswordExpiresAt = mustChangePassword
      ? (input.temporaryPasswordExpiresAt ?? new Date(Date.now() + 72 * 3600 * 1000).toISOString())
      : null;
    this.accounts.set(email, {
      id: input.id ?? newId(),
      name: input.name,
      email,
      password: input.password,
      status: input.status ?? 'active',
      mustChangePassword,
      temporaryPasswordExpiresAt,
    });
  }

  /**
   * POST /auth/forgot-password (US1).
   * Ignores extra fields (US1-AC9), validates email (400 does not consume rate limit, US1-AC8),
   * enforces 20 valid requests per origin per hour (429 HELP_RATE_LIMITED, US1-AC6),
   * and opens/updates a single open ticket only for workshop accounts (US1-AC1..AC5, AC10).
   */
  forgotPassword(raw: unknown, origin = '127.0.0.1'): MockResult<null> {
    if (!isRecord(raw)) return notAnObject();
    const errors = new FieldErrors();
    const email = readEmail(raw, errors);
    if (errors.list.length > 0 || email === null) {
      return validationFailed(errors);
    }

    const now = Date.now();
    const windowStart = now - HELP_RATE_LIMIT_WINDOW_MS;
    const history = (this.helpRateByOrigin.get(origin) ?? []).filter((ts) => ts > windowStart);
    if (history.length >= HELP_RATE_LIMIT_MAX) {
      this.helpRateByOrigin.set(origin, history);
      return fail(429, 'HELP_RATE_LIMITED');
    }
    history.push(now);
    this.helpRateByOrigin.set(origin, history);

    const workshopAccount = this.authStore.findAccountByEmail(email);
    if (workshopAccount !== null && !this.accounts.has(email)) {
      const existingOpen = [...this.tickets.values()].find(
        (t) => t.accountId === workshopAccount.id && t.status === 'open',
      );
      const nowIso = this.nextIsoTimestamp();
      if (existingOpen !== undefined) {
        existingOpen.requestCount += 1;
        existingOpen.lastRequestedAt = nowIso;
      } else {
        const ticket: MockTicket = {
          id: newId(),
          number: this.nextTicketNumber++,
          accountId: workshopAccount.id,
          createdAt: nowIso,
          lastRequestedAt: nowIso,
          requestCount: 1,
          status: 'open',
          resolution: null,
          discard: null,
        };
        this.tickets.set(ticket.id, ticket);
      }
    }

    return { ok: true, status: 202, body: null };
  }

  login(raw: unknown): MockResult<SupportSessionResponse> {
    if (!isRecord(raw)) return notAnObject();
    const body = definedEntries(raw);
    const errors = new FieldErrors();
    checkUnknownFields(body, LOGIN_FIELDS, errors);
    const email = readEmail(body, errors);
    const password = readPassword(body, errors, 1);
    if (errors.list.length > 0 || email === null || password === null) {
      return validationFailed(errors);
    }

    const now = Date.now();
    const throttle = this.lockState(email, now);
    if (throttle === 'locked') {
      return fail(429, 'ACCOUNT_LOCKED');
    }

    const account = this.accounts.get(email);
    if (account !== undefined && account.password === password && temporaryPasswordExpired(account, now)) {
      return fail(401, 'TEMPORARY_PASSWORD_EXPIRED');
    }
    if (account === undefined || account.password !== password || account.status === 'inactive') {
      this.countFailure(email, throttle, now);
      return fail(401, 'INVALID_CREDENTIALS');
    }

    this.throttles.delete(email);
    return { ok: true, status: 200, body: this.sessionOf(account, this.openSession(account)) };
  }

  refresh(csrfHeaderValid: boolean): MockResult<SupportSessionResponse> {
    if (!csrfHeaderValid) return csrfFailure();
    const sessionId = this.supportRefreshCookie;
    if (sessionId === null) {
      return fail(401, 'SESSION_EXPIRED');
    }
    const session = this.sessions.get(sessionId);
    const account = session === undefined ? undefined : this.accountById(session.accountId);
    if (session === undefined || session.revoked || account === undefined || account.status === 'inactive') {
      this.supportRefreshCookie = null;
      return fail(401, 'SESSION_REVOKED');
    }
    if (temporaryPasswordExpired(account, Date.now())) {
      session.revoked = true;
      this.supportRefreshCookie = null;
      return fail(401, 'TEMPORARY_PASSWORD_EXPIRED');
    }
    return { ok: true, status: 200, body: this.sessionOf(account, sessionId) };
  }

  logout(csrfHeaderValid: boolean): MockResult<null> {
    if (!csrfHeaderValid) return csrfFailure();
    if (this.supportRefreshCookie !== null) {
      const session = this.sessions.get(this.supportRefreshCookie);
      if (session !== undefined) session.revoked = true;
      this.supportRefreshCookie = null;
    }
    return { ok: true, status: 204, body: null };
  }

  me(token: string | null): MockResult<CurrentSupportSessionResponse> {
    const check = this.authenticateSupport(token, true);
    if (!check.ok) return check;
    return { ok: true, status: 200, body: { agent: toSupportAgent(check.account) } };
  }

  changePassword(token: string | null, raw: unknown): MockResult<SupportSessionResponse> {
    const check = this.authenticateSupport(token, true);
    if (!check.ok) return check;
    if (!isRecord(raw)) return notAnObject();

    const body = definedEntries(raw);
    const errors = new FieldErrors();
    checkUnknownFields(body, CHANGE_PASSWORD_FIELDS, errors);
    const currentPassword = readPassword(body, errors, 1, 'currentPassword');
    const newPassword = readPassword(body, errors, PASSWORD_MIN_LENGTH, 'newPassword');
    if (errors.list.length > 0 || currentPassword === null || newPassword === null) {
      return validationFailed(errors);
    }

    const { account, sessionId } = check;
    const now = Date.now();
    const throttle = this.lockState(account.email, now);
    if (throttle === 'locked') {
      return fail(429, 'ACCOUNT_LOCKED');
    }
    if (account.password !== currentPassword) {
      this.countFailure(account.email, throttle, now);
      return fail(400, 'CURRENT_PASSWORD_INCORRECT', {
        errors: [
          {
            field: 'currentPassword',
            code: 'CURRENT_PASSWORD_INCORRECT',
            message: 'La contraseña actual no es correcta',
          },
        ],
      });
    }
    if (newPassword === currentPassword) {
      errors.add('newPassword', 'SAME_PASSWORD', 'Debe ser distinta de la actual');
      return validationFailed(errors);
    }

    this.throttles.delete(account.email);
    account.password = newPassword;
    account.mustChangePassword = false;
    account.temporaryPasswordExpiresAt = null;
    for (const [id, session] of this.sessions) {
      if (id !== sessionId && session.accountId === account.id) session.revoked = true;
    }
    return { ok: true, status: 200, body: this.sessionOf(account, sessionId) };
  }

  listOpenTickets(token: string | null): MockResult<TicketListResponse> {
    const check = this.authenticateSupport(token, false);
    if (!check.ok) return check;

    const items: TicketSummary[] = [...this.tickets.values()]
      .filter((ticket) => ticket.status === 'open')
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number)
      .map((ticket) => this.toTicketSummary(ticket))
      .filter((item): item is TicketSummary => item !== null);

    return { ok: true, status: 200, body: { items } };
  }

  getTicket(token: string | null, ticketId: string): MockResult<TicketDetail> {
    const check = this.authenticateSupport(token, false);
    if (!check.ok) return check;

    if (!UUID_PATTERN.test(ticketId)) {
      return fail(404, 'NOT_FOUND');
    }
    const ticket = this.tickets.get(ticketId);
    if (ticket === undefined) {
      return fail(404, 'NOT_FOUND');
    }
    const detail = this.toTicketDetail(ticket);
    if (detail === null) {
      return fail(404, 'NOT_FOUND');
    }
    return { ok: true, status: 200, body: detail };
  }

  discardTicket(token: string | null, ticketId: string, raw: unknown): MockResult<TicketDetail> {
    const check = this.authenticateSupport(token, false);
    if (!check.ok) return check;

    if (!isRecord(raw)) return notAnObject();
    const body = definedEntries(raw);
    const errors = new FieldErrors();
    checkUnknownFields(body, DISCARD_TICKET_FIELDS, errors);
    const rawReason = readRequiredText(body, 'reason', errors);
    let reason: string | null = null;
    if (rawReason !== null) {
      const trimmed = rawReason.trim();
      if (unicodeLength(trimmed) > REASON_MAX_LENGTH) {
        errors.add('reason', 'VALIDATION_ERROR', `Admite como máximo ${REASON_MAX_LENGTH} caracteres`);
      } else {
        reason = trimmed;
      }
    }
    if (errors.list.length > 0 || reason === null) {
      return validationFailed(errors);
    }

    if (!UUID_PATTERN.test(ticketId)) {
      return fail(404, 'NOT_FOUND');
    }
    const ticket = this.tickets.get(ticketId);
    if (ticket === undefined) {
      return fail(404, 'NOT_FOUND');
    }
    if (ticket.status !== 'open') {
      return fail(409, 'TICKET_NOT_OPEN');
    }

    ticket.status = 'discarded';
    ticket.discard = {
      reason,
      discardedByName: check.account.name,
      discardedAt: this.nextIsoTimestamp(),
    };
    const detail = this.toTicketDetail(ticket);
    if (detail === null) {
      return fail(404, 'NOT_FOUND');
    }
    return { ok: true, status: 200, body: detail };
  }

  generateTemporaryPassword(
    token: string | null,
    ticketId: string,
    raw: unknown,
  ): MockResult<TemporaryPasswordResponse> {
    const check = this.authenticateSupport(token, false);
    if (!check.ok) return check;

    if (!isRecord(raw)) return notAnObject();
    const body = definedEntries(raw);
    const errors = new FieldErrors();
    checkUnknownFields(body, GENERATE_TEMP_PASSWORD_FIELDS, errors);
    const rawNote = readRequiredText(body, 'verificationNote', errors);
    let verificationNote: string | null = null;
    if (rawNote !== null) {
      const trimmed = rawNote.trim();
      if (unicodeLength(trimmed) > VERIFICATION_NOTE_MAX_LENGTH) {
        errors.add(
          'verificationNote',
          'VALIDATION_ERROR',
          `Admite como máximo ${VERIFICATION_NOTE_MAX_LENGTH} caracteres`,
        );
      } else {
        verificationNote = trimmed;
      }
    }
    if (errors.list.length > 0 || verificationNote === null) {
      return validationFailed(errors);
    }

    if (!UUID_PATTERN.test(ticketId)) {
      return fail(404, 'NOT_FOUND');
    }
    const ticket = this.tickets.get(ticketId);
    if (ticket === undefined) {
      return fail(404, 'NOT_FOUND');
    }
    if (ticket.status !== 'open') {
      return fail(409, 'TICKET_NOT_OPEN');
    }

    const temporaryPassword = randomTemporaryPassword();
    const resolvedAt = this.nextIsoTimestamp();
    const applyResult = this.authStore.applySupportTemporaryPassword({
      accountId: ticket.accountId,
      temporaryPassword,
      agentName: check.account.name,
      supportTicketNumber: ticket.number,
      occurredAt: resolvedAt,
    });
    if (!applyResult.ok) {
      return applyResult;
    }

    ticket.status = 'resolved';
    ticket.resolution = {
      verificationNote,
      resolvedByName: check.account.name,
      resolvedAt,
    };
    const detail = this.toTicketDetail(ticket);
    if (detail === null) {
      return fail(404, 'NOT_FOUND');
    }
    return {
      ok: true,
      status: 200,
      body: {
        temporaryPassword,
        temporaryPasswordExpiresAt: applyResult.body.temporaryPasswordExpiresAt,
        sessionsClosed: applyResult.body.sessionsClosed,
        ticket: detail,
      },
    };
  }

  /**
   * GET /support/workshops (US4-AC1, US4-AC2): 50 per page, ordered by name, only id/name/ruc/createdAt.
   * `q` searches by RUC prefix (with or without separators) or by part of the name, without case or
   * diacritics; `%` and `_` are literal. `page` is a 1-based integer.
   */
  listWorkshops(
    token: string | null,
    query: { q?: string | null; page?: string | null } = {},
  ): MockResult<WorkshopListResponse> {
    const check = this.authenticateSupport(token, false);
    if (!check.ok) return check;

    const errors = new FieldErrors();
    const q = readWorkshopQuery(query.q, errors);
    const page = readPage(query.page, errors);
    if (errors.list.length > 0) {
      return validationFailed(errors);
    }

    const workshops = this.authStore
      .listWorkshopsForSupport()
      .filter((workshop) => q === undefined || matchesWorkshop(workshop, q));
    const start = (page - 1) * SUPPORT_PAGE_SIZE;
    const items: WorkshopSummary[] = workshops.slice(start, start + SUPPORT_PAGE_SIZE).map((workshop) => ({
      id: workshop.id,
      name: workshop.name,
      ruc: workshop.ruc,
      createdAt: workshop.createdAt,
    }));
    return {
      ok: true,
      status: 200,
      body: { items, page, pageSize: SUPPORT_PAGE_SIZE, total: workshops.length },
    };
  }

  /**
   * GET /support/workshops/{workshopId}/accounts (US4-AC3, US4-AC6, US4-AC7): every account of the
   * workshop, active and inactive, with `hasOpenTicket`. A missing or non-uuid id is the same 404 and
   * writes nothing. A successful query adds exactly one entry to the support access log.
   */
  listWorkshopAccounts(token: string | null, workshopId: string): MockResult<WorkshopAccountsResponse> {
    const check = this.authenticateSupport(token, false);
    if (!check.ok) return check;

    if (!UUID_PATTERN.test(workshopId)) {
      return fail(404, 'NOT_FOUND');
    }
    const workshop = this.authStore.findWorkshopForSupport(workshopId);
    if (workshop === null) {
      return fail(404, 'NOT_FOUND');
    }

    const openAccountIds = new Set(
      [...this.tickets.values()]
        .filter((ticket) => ticket.status === 'open')
        .map((ticket) => ticket.accountId),
    );
    const items: WorkshopAccount[] = this.authStore
      .listAccountsForWorkshop(workshopId)
      .map((account) => ({
        name: account.name,
        email: account.email,
        role: account.role,
        status: account.status,
        hasOpenTicket: openAccountIds.has(account.id),
      }));

    this.accessLog.push({
      id: newId(),
      occurredAt: this.nextIsoTimestamp(),
      agent: { id: check.account.id, name: check.account.name },
      workshop: { id: workshop.id, name: workshop.name, ruc: workshop.ruc },
      ip: '127.0.0.1',
      channel: 'support_panel',
    });

    return { ok: true, status: 200, body: { workshop, items } };
  }

  /**
   * GET /support/access-log (US4-AC8, US4-AC9, FR-027): newest first, 50 per page, optional and
   * combinable workshop/agent filters, and never the agent's email. Reading it writes nothing.
   */
  listAccessLog(
    token: string | null,
    query: { workshopId?: string | null; agentId?: string | null; page?: string | null } = {},
  ): MockResult<AccessLogResponse> {
    const check = this.authenticateSupport(token, false);
    if (!check.ok) return check;

    const errors = new FieldErrors();
    const workshopId = readOptionalUuid(query.workshopId, 'workshopId', errors);
    const agentId = readOptionalUuid(query.agentId, 'agentId', errors);
    const page = readPage(query.page, errors);
    if (errors.list.length > 0) {
      return validationFailed(errors);
    }

    const entries = this.accessLog
      .filter((entry) => workshopId === undefined || entry.workshop.id === workshopId)
      .filter((entry) => agentId === undefined || entry.agent.id === agentId)
      .sort(
        (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.id.localeCompare(b.id),
      );
    const start = (page - 1) * SUPPORT_PAGE_SIZE;
    return {
      ok: true,
      status: 200,
      body: {
        items: entries.slice(start, start + SUPPORT_PAGE_SIZE),
        page,
        pageSize: SUPPORT_PAGE_SIZE,
        total: entries.length,
      },
    };
  }

  /**
   * Validates the support token and session.
   * Any valid JWT that does not carry `aud: 'motorsync-support'` (e.g. a workshop token) is rejected with 403 FORBIDDEN (US2-AC5).
   */
  authenticateSupport(token: string | null, allowPendingPasswordChange: boolean): MockSupportSessionCheck {
    const claims = readSupportClaims(token);
    if (claims === null) {
      return { ok: false, problem: mockProblem(401, 'UNAUTHORIZED') };
    }
    if (claims.aud !== SUPPORT_JWT_AUDIENCE || claims.tenantId !== null || claims.role !== null) {
      return { ok: false, problem: mockProblem(403, 'FORBIDDEN') };
    }
    if (claims.sid === null) {
      return { ok: false, problem: mockProblem(401, 'UNAUTHORIZED') };
    }
    const session = this.sessions.get(claims.sid);
    const account = session === undefined ? undefined : this.accountById(session.accountId);
    if (session === undefined || session.revoked || account === undefined || account.status === 'inactive') {
      return { ok: false, problem: mockProblem(401, 'SESSION_REVOKED') };
    }
    if (temporaryPasswordExpired(account, Date.now())) {
      session.revoked = true;
      return { ok: false, problem: mockProblem(401, 'TEMPORARY_PASSWORD_EXPIRED') };
    }
    if (!allowPendingPasswordChange && account.mustChangePassword) {
      return { ok: false, problem: mockProblem(403, 'PASSWORD_CHANGE_REQUIRED') };
    }
    return { ok: true, account, sessionId: claims.sid };
  }

  private toTicketSummary(ticket: MockTicket): TicketSummary | null {
    const account = this.authStore.findAccountById(ticket.accountId);
    if (account === null) return null;
    return {
      id: ticket.id,
      number: ticket.number,
      createdAt: ticket.createdAt,
      lastRequestedAt: ticket.lastRequestedAt,
      requestCount: ticket.requestCount,
      account: {
        email: account.email,
        name: account.name,
        role: account.role,
        status: account.status,
      },
      workshop: {
        name: account.workshopName,
        ruc: account.workshopRuc,
      },
    };
  }

  private toTicketDetail(ticket: MockTicket): TicketDetail | null {
    const summary = this.toTicketSummary(ticket);
    if (summary === null) return null;
    return {
      ...summary,
      status: ticket.status,
      resolution: ticket.resolution,
      discard: ticket.discard,
    };
  }

  private nextIsoTimestamp(): string {
    const now = Math.max(Date.now(), this.lastTimestampMs + 1);
    this.lastTimestampMs = now;
    return new Date(now).toISOString();
  }

  private lockState(email: string, now: number): LoginThrottle | 'locked' {
    const throttle = this.throttles.get(email) ?? { failures: 0, lockedUntil: null };
    if (throttle.lockedUntil !== null && throttle.lockedUntil > now) {
      return 'locked';
    }
    if (throttle.lockedUntil !== null) {
      throttle.failures = 0;
      throttle.lockedUntil = null;
    }
    return throttle;
  }

  private countFailure(email: string, throttle: LoginThrottle, now: number): void {
    throttle.failures += 1;
    if (throttle.failures >= MAX_FAILED_ATTEMPTS) {
      throttle.lockedUntil = now + LOCK_DURATION_MS;
    }
    this.throttles.set(email, throttle);
  }

  private openSession(account: MockSupportAccount): string {
    const sessionId = newId();
    this.sessions.set(sessionId, { accountId: account.id, revoked: false });
    this.supportRefreshCookie = sessionId;
    return sessionId;
  }

  private accountById(id: string): MockSupportAccount | undefined {
    for (const account of this.accounts.values()) {
      if (account.id === id) return account;
    }
    return undefined;
  }

  private sessionOf(account: MockSupportAccount, sessionId: string): SupportSessionResponse {
    return {
      accessToken: supportAccessTokenFor(account, sessionId),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      agent: toSupportAgent(account),
    };
  }
}

function toSupportAgent(account: MockSupportAccount): SupportAgent {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    mustChangePassword: account.mustChangePassword,
    temporaryPasswordExpiresAt: account.temporaryPasswordExpiresAt,
  };
}

function randomTemporaryPassword(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const chars = Array.from(bytes, (b) => TEMP_PASSWORD_ALPHABET[b % TEMP_PASSWORD_ALPHABET.length]);
  return [
    chars.slice(0, 4).join(''),
    chars.slice(4, 8).join(''),
    chars.slice(8, 12).join(''),
    chars.slice(12, 16).join(''),
  ].join('-');
}
