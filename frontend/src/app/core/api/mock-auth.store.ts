import { Injectable } from '@angular/core';
import { isValidRuc } from '../../shared/identifiers/ec-document';
import { isValidEmail, normalizeEmail } from '../../shared/identifiers/email';
import { normalizeDocument } from '../../shared/identifiers/normalize';
import type {
  CurrentSessionResponse,
  FieldError,
  Problem,
  Role,
  SessionResponse,
  SessionUser,
  UserAccount,
  UserAuditEntry,
  UserStatus,
  Workshop,
} from './api.models';
import { mockProblem, newId, type MockResult } from './mock-api.store';

// In-memory accounts, workshops and sessions of the mock API for /auth/* (specs/002-autenticacion/contracts/
// openapi.yaml, research R13). Same codes and rules as the backend.
// It lives in the root injector, so every TestBed (and every page load) starts with its own data.
// Passwords are compared as typed: this store only exists in the browser for development, and it never
// returns or echoes a password.

const REGISTER_FIELDS = ['workshopName', 'ruc', 'name', 'email', 'password'] as const;
const LOGIN_FIELDS = ['email', 'password'] as const;
const CHANGE_PASSWORD_FIELDS = ['currentPassword', 'newPassword'] as const;
const CREATE_USER_FIELDS = ['name', 'email', 'role', 'temporaryPassword'] as const;
const CHANGE_ROLE_FIELDS = ['role'] as const;
const RESET_PASSWORD_FIELDS = ['temporaryPassword'] as const;
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 120;
const EMAIL_MAX_LENGTH = 254;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const ACCESS_TOKEN_TTL_SECONDS = 900;
/** FR-009: 5 consecutive failures for the same normalized email lock it for 15 minutes. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

interface MockWorkshop extends Workshop {
  ruc: string;
}

interface MockAccount {
  id: string;
  workshopId: string;
  name: string;
  email: string;
  role: Role;
  password: string;
  status: UserStatus;
  mustChangePassword: boolean;
  /** ISO 8601; set only while a temporary password is pending (like the CHECK of research R7). */
  temporaryPasswordExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedByName: string;
}

interface MockAuditEntry {
  id: string;
  userId: string;
  workshopId: string;
  action: 'user.role_changed' | 'user.deactivated' | 'user.reactivated' | 'user.password_reset';
  actorName: string;
  actorRole: Role;
  occurredAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  channel: string;
}

/** Server-side session (research R5). The "cookie" ms_refresh of the mock points to one of these by id. */
interface MockSession {
  accountId: string;
  revoked: boolean;
}

/** Input of MockAuthStore.addAccount: direct creation of an account (tests; PR3 reuses it for POST /users). */
export interface MockAccountInput {
  id?: string;
  workshopId: string;
  name: string;
  email: string;
  role: Role;
  password: string;
  status?: UserStatus;
  mustChangePassword?: boolean;
  temporaryPasswordExpiresAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  updatedByName?: string;
}

interface CallerInfo {
  id: string;
  workshopId: string;
  name: string;
  role: Role;
}

type CallerCheck = { ok: true; caller: CallerInfo } | { ok: false; problem: Problem };

function toUserAccount(account: MockAccount): UserAccount {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    role: account.role,
    status: account.status,
    mustChangePassword: account.mustChangePassword,
    temporaryPasswordExpiresAt: account.temporaryPasswordExpiresAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    updatedByName: account.updatedByName,
  };
}

/** Account and session of a request token, or the Problem that rejects it. */
type MockSessionCheck = { ok: true; account: MockAccount; sessionId: string } | { ok: false; problem: Problem };

/** Claims of a token that the mock reads (the signature is never verified). */
interface TokenClaims {
  sub: string | null;
  sid: string | null;
  tenantId: string | null;
  role: Role | null;
  name: string;
}

interface LoginThrottle {
  failures: number;
  lockedUntil: number | null;
}

// Seed data for `ng serve --configuration mock`. It must not use the emails (*@taller.ec) or RUCs of the tests.
const SEED_WORKSHOP = { name: 'Taller Demo MotorSync', ruc: '1792345678001' };
const SEED_PASSWORD = 'Demo MotorSync 2026';
const SEED_ACCOUNTS: { name: string; email: string; role: Role }[] = [
  { name: 'Administrador Demo', email: 'admin@tallerdemo.example.com', role: 'admin' },
  { name: 'Asesor Demo', email: 'asesor@tallerdemo.example.com', role: 'asesor' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Length in Unicode characters (code points), as the backend (FR-005). */
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

/** JWT with the claims of contract 002 and an invented signature: readable by decodeSessionToken. */
function accessTokenFor(account: MockAccount, sessionId: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: account.id,
      tenant_id: account.workshopId,
      role: account.role,
      name: account.name,
      sid: sessionId,
      pwd_change: account.mustChangePassword,
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    }),
  );
  return `${header}.${payload}.mock-signature`;
}

function stringClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Claims of "header.payload.signature"; null when the token is missing or not readable. */
function readClaims(token: string | null): TokenClaims | null {
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
  const role = payload['role'];
  return {
    sub: stringClaim(payload, 'sub'),
    sid: stringClaim(payload, 'sid'),
    tenantId: stringClaim(payload, 'tenant_id'),
    role: role === 'admin' || role === 'asesor' ? role : null,
    name: stringClaim(payload, 'name') ?? '',
  };
}

function fail<T>(status: number, code: Problem['code'], extra: Partial<Problem> = {}): MockResult<T> {
  return { ok: false, problem: mockProblem(status, code, extra) };
}

function temporaryPasswordExpired(account: MockAccount, now: number): boolean {
  return (
    account.mustChangePassword &&
    account.temporaryPasswordExpiresAt !== null &&
    Date.parse(account.temporaryPasswordExpiresAt) <= now
  );
}

/** R11: refresh and logout without `X-Requested-With: motorsync` are rejected (CSRF). */
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

/** Fields that are not in the request schema (additionalProperties: false) → UNKNOWN_FIELD. */
function checkUnknownFields(body: Record<string, unknown>, allowed: readonly string[], errors: FieldErrors): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      errors.add(key, 'UNKNOWN_FIELD', 'Campo no permitido');
    }
  }
}

/** Text field; empty or whitespace-only is REQUIRED. Returns the raw (untrimmed) value. */
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

function readName(body: Record<string, unknown>, field: string, errors: FieldErrors): string | null {
  const value = readRequiredText(body, field, errors);
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length < NAME_MIN_LENGTH || trimmed.length > NAME_MAX_LENGTH) {
    errors.add(field, 'VALIDATION_ERROR', `Debe tener entre ${NAME_MIN_LENGTH} y ${NAME_MAX_LENGTH} caracteres`);
    return null;
  }
  return trimmed;
}

/** Trimmed and lowercased before validating and comparing, in register and login alike (FR-003). */
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

/** The password is never trimmed: only the empty string is missing. Messages never contain it (FR-006). */
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

function readRole(body: Record<string, unknown>, errors: FieldErrors): Role | null {
  const value = body['role'];
  if (value === undefined || value === null) {
    errors.add('role', 'REQUIRED', 'Campo obligatorio');
    return null;
  }
  if (value !== 'asesor' && value !== 'admin') {
    errors.add('role', 'VALIDATION_ERROR', 'Rol inválido');
    return null;
  }
  return value;
}

/** Undefined values are dropped by JSON serialization: they count as absent. */
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

@Injectable({ providedIn: 'root' })
export class MockAuthStore {
  private readonly workshops = new Map<string, MockWorkshop>();
  /** Accounts by normalized email (unique in all of MotorSync). */
  private readonly accounts = new Map<string, MockAccount>();
  /** Login throttling by normalized email, whether the account exists or not (US2-AC8). */
  private readonly throttles = new Map<string, LoginThrottle>();
  /** Sessions by id (the `sid` of the access tokens). */
  private readonly sessions = new Map<string, MockSession>();
  /** Audit history entries for users. */
  private readonly auditEntries: MockAuditEntry[] = [];
  /** The HttpOnly cookie ms_refresh of this "browser", simulated in memory: id of its session. Never in a body. */
  private refreshCookie: string | null = null;

  constructor() {
    const workshop: MockWorkshop = { id: newId(), ...SEED_WORKSHOP };
    this.workshops.set(workshop.id, workshop);
    const nowIso = new Date().toISOString();
    for (const account of SEED_ACCOUNTS) {
      this.accounts.set(account.email, {
        id: newId(),
        workshopId: workshop.id,
        password: SEED_PASSWORD,
        status: 'active',
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        updatedByName: 'Administrador Demo',
        ...account,
      });
    }
  }

  register(raw: unknown): MockResult<SessionResponse> {
    if (!isRecord(raw)) return notAnObject();
    const body = definedEntries(raw);
    const errors = new FieldErrors();
    checkUnknownFields(body, REGISTER_FIELDS, errors);

    const workshopName = readName(body, 'workshopName', errors);
    let ruc = readRequiredText(body, 'ruc', errors);
    if (ruc !== null) {
      ruc = normalizeDocument(ruc);
      if (!isValidRuc(ruc)) {
        errors.add('ruc', 'INVALID_RUC', 'RUC inválido: deben ser 13 dígitos terminados en 001');
        ruc = null;
      }
    }
    const name = readName(body, 'name', errors);
    const email = readEmail(body, errors);
    const password = readPassword(body, errors, PASSWORD_MIN_LENGTH);

    if (errors.list.length > 0 || workshopName === null || ruc === null || name === null || email === null || password === null) {
      return validationFailed(errors);
    }
    // With both RUC and email in use, the RUC message wins (US1-AC5). Neither reveals other data.
    const normalizedRuc = ruc;
    if ([...this.workshops.values()].some((workshop) => workshop.ruc === normalizedRuc)) {
      return fail(409, 'RUC_ALREADY_REGISTERED');
    }
    if (this.accounts.has(email)) {
      return fail(409, 'REGISTRATION_FAILED');
    }

    const workshop: MockWorkshop = { id: newId(), name: workshopName, ruc };
    const nowIso = new Date().toISOString();
    const account: MockAccount = {
      id: newId(),
      workshopId: workshop.id,
      name,
      email,
      role: 'admin',
      password,
      status: 'active',
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      updatedByName: name,
    };
    this.workshops.set(workshop.id, workshop);
    this.accounts.set(email, account);
    return { ok: true, status: 201, body: this.sessionOf(account, this.openSession(account)) };
  }

  login(raw: unknown): MockResult<SessionResponse> {
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
    // R7, US5-AC9: an expired temporary password with the right password is not a failed attempt.
    if (account !== undefined && account.password === password && temporaryPasswordExpired(account, now)) {
      return fail(401, 'TEMPORARY_PASSWORD_EXPIRED');
    }
    if (account === undefined || account.password !== password || account.status === 'inactive') {
      this.countFailure(email, throttle, now);
      // Same body whether the email exists or not (US2-AC3, FR-008).
      return fail(401, 'INVALID_CREDENTIALS');
    }

    this.throttles.delete(email);
    return { ok: true, status: 200, body: this.sessionOf(account, this.openSession(account)) };
  }

  /** Direct creation of an account (tests; POST /users in the PR3). The email is stored normalized. */
  addAccount(input: MockAccountInput): void {
    const mustChangePassword = input.mustChangePassword ?? false;
    const temporaryPasswordExpiresAt = mustChangePassword ? (input.temporaryPasswordExpiresAt ?? null) : null;
    if (mustChangePassword && temporaryPasswordExpiresAt === null) {
      throw new Error('MockAuthStore.addAccount: a temporary password needs temporaryPasswordExpiresAt');
    }
    const email = normalizeEmail(input.email);
    const nowIso = new Date().toISOString();
    this.accounts.set(email, {
      id: input.id ?? newId(),
      workshopId: input.workshopId,
      name: input.name,
      email,
      role: input.role,
      password: input.password,
      status: input.status ?? 'active',
      mustChangePassword,
      temporaryPasswordExpiresAt,
      createdAt: input.createdAt ?? nowIso,
      updatedAt: input.updatedAt ?? nowIso,
      updatedByName: input.updatedByName ?? 'Admin Principal',
    });
  }

  /** POST /auth/refresh: same session (same sid) with the current account data. */
  refresh(csrfHeaderValid: boolean): MockResult<SessionResponse> {
    if (!csrfHeaderValid) return csrfFailure();
    const sessionId = this.refreshCookie;
    if (sessionId === null) {
      return fail(401, 'SESSION_EXPIRED');
    }
    const session = this.sessions.get(sessionId);
    const account = session === undefined ? undefined : this.accountById(session.accountId);
    if (session === undefined || session.revoked || account === undefined) {
      this.refreshCookie = null;
      return fail(401, 'SESSION_REVOKED');
    }
    if (temporaryPasswordExpired(account, Date.now())) {
      session.revoked = true;
      this.refreshCookie = null;
      return fail(401, 'TEMPORARY_PASSWORD_EXPIRED');
    }
    return { ok: true, status: 200, body: this.sessionOf(account, sessionId) };
  }

  /** POST /auth/logout: always 204 (idempotent, US3-AC6); revokes the session of the cookie, if any. */
  logout(csrfHeaderValid: boolean): MockResult<null> {
    if (!csrfHeaderValid) return csrfFailure();
    if (this.refreshCookie !== null) {
      const session = this.sessions.get(this.refreshCookie);
      if (session !== undefined) session.revoked = true;
      this.refreshCookie = null;
    }
    return { ok: true, status: 204, body: null };
  }

  /**
   * GET /auth/me. A readable token without `sid` (dev-token, 001) is answered with its own claims, so
   * `ng serve --configuration mock` keeps working with /dev-token (research R9).
   */
  me(token: string | null): MockResult<CurrentSessionResponse> {
    const claims = readClaims(token);
    if (claims === null || claims.role === null) {
      return fail(401, 'UNAUTHORIZED');
    }
    if (claims.sid === null) {
      const workshop = claims.tenantId === null ? undefined : this.workshops.get(claims.tenantId);
      return {
        ok: true,
        status: 200,
        body: {
          user: {
            id: claims.sub ?? '',
            name: claims.name,
            email: '',
            role: claims.role,
            mustChangePassword: false,
            temporaryPasswordExpiresAt: null,
          },
          workshop: { id: claims.tenantId ?? '', name: workshop?.name ?? '' },
        },
      };
    }
    const check = this.checkSession(claims.sid);
    if (!check.ok) return check;
    const { user, workshop } = this.sessionOf(check.account, check.sessionId);
    return { ok: true, status: 200, body: { user, workshop } };
  }

  /**
   * 001 routes: a token with `sid` needs a live session, and a temporary password still to change only allows
   * /auth/* (403 PASSWORD_CHANGE_REQUIRED, US5-AC1). A token without `sid` goes on as before (research R9).
   * Null when the request may go on.
   */
  workshopAccessProblem(token: string | null): Problem | null {
    const sid = readClaims(token)?.sid ?? null;
    if (sid === null) return null;
    const check = this.checkSession(sid);
    if (!check.ok) return check.problem;
    return check.account.mustChangePassword ? mockProblem(403, 'PASSWORD_CHANGE_REQUIRED') : null;
  }

  /**
   * POST /auth/password (US5). A wrong current password counts for the lock of the email (US5-AC4); success ends
   * the temporary password, revokes the OTHER sessions (US5-AC3) and answers a token of the same session.
   */
  changePassword(token: string | null, raw: unknown): MockResult<SessionResponse> {
    const sid = readClaims(token)?.sid ?? null;
    if (sid === null) return fail(401, 'UNAUTHORIZED');
    const check = this.checkSession(sid);
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
          { field: 'currentPassword', code: 'CURRENT_PASSWORD_INCORRECT', message: 'La contraseña actual no es correcta' },
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

  /**
   * Session of a token `sid` (research R6): revoked or unknown → 401 SESSION_REVOKED; temporary password expired
   * → 401 TEMPORARY_PASSWORD_EXPIRED and the session is revoked (R7).
   */
  private checkSession(sessionId: string): MockSessionCheck {
    const session = this.sessions.get(sessionId);
    const account = session === undefined ? undefined : this.accountById(session.accountId);
    if (session === undefined || session.revoked || account === undefined || account.status === 'inactive') {
      return { ok: false, problem: mockProblem(401, 'SESSION_REVOKED') };
    }
    if (temporaryPasswordExpired(account, Date.now())) {
      session.revoked = true;
      return { ok: false, problem: mockProblem(401, 'TEMPORARY_PASSWORD_EXPIRED') };
    }
    return { ok: true, account, sessionId };
  }

  // --- Users management (PR3 / specs/002-autenticacion/contracts/openapi.yaml) ---

  listUsers(token: string | null): MockResult<{ items: UserAccount[] }> {
    const callerCheck = this.callerOf(token);
    if (!callerCheck.ok) return callerCheck;
    const { caller } = callerCheck;
    const items = [...this.accounts.values()]
      .filter((account) => account.workshopId === caller.workshopId)
      .map(toUserAccount);
    return { ok: true, status: 200, body: { items } };
  }

  createUser(token: string | null, raw: unknown): MockResult<UserAccount> {
    const callerCheck = this.callerOf(token);
    if (!callerCheck.ok) return callerCheck;
    const { caller } = callerCheck;

    if (!isRecord(raw)) return notAnObject();
    const body = definedEntries(raw);
    const errors = new FieldErrors();
    checkUnknownFields(body, CREATE_USER_FIELDS, errors);

    const name = readName(body, 'name', errors);
    const email = readEmail(body, errors);
    const role = readRole(body, errors);
    const temporaryPassword = readPassword(body, errors, PASSWORD_MIN_LENGTH, 'temporaryPassword');

    if (errors.list.length > 0 || name === null || email === null || role === null || temporaryPassword === null) {
      return validationFailed(errors);
    }

    if (this.accounts.has(email)) {
      return fail(409, 'EMAIL_UNAVAILABLE');
    }

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    const account: MockAccount = {
      id: newId(),
      workshopId: caller.workshopId,
      name,
      email,
      role,
      password: temporaryPassword,
      status: 'active',
      mustChangePassword: true,
      temporaryPasswordExpiresAt: expiresIso,
      createdAt: nowIso,
      updatedAt: nowIso,
      updatedByName: caller.name,
    };
    this.accounts.set(email, account);
    return { ok: true, status: 201, body: toUserAccount(account) };
  }

  getUser(token: string | null, userId: string): MockResult<UserAccount> {
    const callerCheck = this.callerOf(token);
    if (!callerCheck.ok) return callerCheck;
    const { caller } = callerCheck;

    const account = this.accountById(userId);
    if (account === undefined || account.workshopId !== caller.workshopId) {
      return fail(404, 'NOT_FOUND');
    }
    return { ok: true, status: 200, body: toUserAccount(account) };
  }

  changeUserRole(token: string | null, userId: string, raw: unknown): MockResult<UserAccount> {
    const callerCheck = this.callerOf(token);
    if (!callerCheck.ok) return callerCheck;
    const { caller } = callerCheck;

    const account = this.accountById(userId);
    if (account === undefined || account.workshopId !== caller.workshopId) {
      return fail(404, 'NOT_FOUND');
    }

    if (!isRecord(raw)) return notAnObject();
    const body = definedEntries(raw);
    const errors = new FieldErrors();
    checkUnknownFields(body, CHANGE_ROLE_FIELDS, errors);
    const role = readRole(body, errors);
    if (errors.list.length > 0 || role === null) {
      return validationFailed(errors);
    }

    if (account.role === role) {
      return { ok: true, status: 200, body: toUserAccount(account) };
    }

    if (account.role === 'admin' && role === 'asesor') {
      const activeAdmins = this.getActiveAdmins(caller.workshopId);
      if (activeAdmins.length <= 1 && activeAdmins.some((a) => a.id === account.id)) {
        return fail(409, 'LAST_ADMIN');
      }
    }

    const oldRole = account.role;
    const nowIso = new Date().toISOString();
    account.role = role;
    account.updatedAt = nowIso;
    account.updatedByName = caller.name;

    this.auditEntries.unshift({
      id: newId(),
      userId: account.id,
      workshopId: account.workshopId,
      action: 'user.role_changed',
      actorName: caller.name,
      actorRole: caller.role,
      occurredAt: nowIso,
      before: { role: oldRole },
      after: { role: account.role },
      ip: '127.0.0.1',
      channel: 'web',
    });

    return { ok: true, status: 200, body: toUserAccount(account) };
  }

  deactivateUser(token: string | null, userId: string): MockResult<UserAccount> {
    const callerCheck = this.callerOf(token);
    if (!callerCheck.ok) return callerCheck;
    const { caller } = callerCheck;

    const account = this.accountById(userId);
    if (account === undefined || account.workshopId !== caller.workshopId) {
      return fail(404, 'NOT_FOUND');
    }

    if (account.status === 'inactive') {
      return { ok: true, status: 200, body: toUserAccount(account) };
    }

    if (account.role === 'admin') {
      const activeAdmins = this.getActiveAdmins(caller.workshopId);
      if (activeAdmins.length <= 1 && activeAdmins.some((a) => a.id === account.id)) {
        return fail(409, 'LAST_ADMIN');
      }
    }

    const nowIso = new Date().toISOString();
    account.status = 'inactive';
    account.updatedAt = nowIso;
    account.updatedByName = caller.name;

    for (const session of this.sessions.values()) {
      if (session.accountId === account.id) {
        session.revoked = true;
      }
    }

    this.auditEntries.unshift({
      id: newId(),
      userId: account.id,
      workshopId: account.workshopId,
      action: 'user.deactivated',
      actorName: caller.name,
      actorRole: caller.role,
      occurredAt: nowIso,
      before: { status: 'active' },
      after: { status: 'inactive' },
      ip: '127.0.0.1',
      channel: 'web',
    });

    return { ok: true, status: 200, body: toUserAccount(account) };
  }

  reactivateUser(token: string | null, userId: string): MockResult<UserAccount> {
    const callerCheck = this.callerOf(token);
    if (!callerCheck.ok) return callerCheck;
    const { caller } = callerCheck;

    const account = this.accountById(userId);
    if (account === undefined || account.workshopId !== caller.workshopId) {
      return fail(404, 'NOT_FOUND');
    }

    if (account.status === 'active') {
      return { ok: true, status: 200, body: toUserAccount(account) };
    }

    const nowIso = new Date().toISOString();
    account.status = 'active';
    account.updatedAt = nowIso;
    account.updatedByName = caller.name;

    this.auditEntries.unshift({
      id: newId(),
      userId: account.id,
      workshopId: account.workshopId,
      action: 'user.reactivated',
      actorName: caller.name,
      actorRole: caller.role,
      occurredAt: nowIso,
      before: { status: 'inactive' },
      after: { status: 'active' },
      ip: '127.0.0.1',
      channel: 'web',
    });

    return { ok: true, status: 200, body: toUserAccount(account) };
  }

  resetUserPassword(token: string | null, userId: string, raw: unknown): MockResult<UserAccount> {
    const callerCheck = this.callerOf(token);
    if (!callerCheck.ok) return callerCheck;
    const { caller } = callerCheck;

    if (caller.id === userId) {
      return fail(409, 'SELF_RESET_NOT_ALLOWED');
    }

    const account = this.accountById(userId);
    if (account === undefined || account.workshopId !== caller.workshopId) {
      return fail(404, 'NOT_FOUND');
    }

    if (!isRecord(raw)) return notAnObject();
    const body = definedEntries(raw);
    const errors = new FieldErrors();
    checkUnknownFields(body, RESET_PASSWORD_FIELDS, errors);
    const temporaryPassword = readPassword(body, errors, PASSWORD_MIN_LENGTH, 'temporaryPassword');
    if (errors.list.length > 0 || temporaryPassword === null) {
      return validationFailed(errors);
    }

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    account.password = temporaryPassword;
    account.mustChangePassword = true;
    account.temporaryPasswordExpiresAt = expiresIso;
    account.updatedAt = nowIso;
    account.updatedByName = caller.name;

    for (const session of this.sessions.values()) {
      if (session.accountId === account.id) {
        session.revoked = true;
      }
    }
    this.throttles.delete(account.email);

    this.auditEntries.unshift({
      id: newId(),
      userId: account.id,
      workshopId: account.workshopId,
      action: 'user.password_reset',
      actorName: caller.name,
      actorRole: caller.role,
      occurredAt: nowIso,
      before: null,
      after: null,
      ip: '127.0.0.1',
      channel: 'web',
    });

    return { ok: true, status: 200, body: toUserAccount(account) };
  }

  getUserHistory(token: string | null, userId: string): MockResult<{ items: UserAuditEntry[] }> {
    const callerCheck = this.callerOf(token);
    if (!callerCheck.ok) return callerCheck;
    const { caller } = callerCheck;

    const account = this.accountById(userId);
    if (account === undefined || account.workshopId !== caller.workshopId) {
      return fail(404, 'NOT_FOUND');
    }

    const items: UserAuditEntry[] = this.auditEntries
      .filter((entry) => entry.userId === userId && entry.workshopId === caller.workshopId)
      .map((entry) => ({
        id: entry.id,
        action: entry.action,
        actorName: entry.actorName,
        actorRole: entry.actorRole,
        occurredAt: entry.occurredAt,
        before: entry.before,
        after: entry.after,
        ip: entry.ip,
        channel: entry.channel,
      }));

    return { ok: true, status: 200, body: { items } };
  }

  private callerOf(token: string | null): CallerCheck {
    const claims = readClaims(token);
    if (claims === null || claims.role === null) {
      return { ok: false, problem: mockProblem(401, 'UNAUTHORIZED') };
    }
    if (claims.sid !== null) {
      const check = this.checkSession(claims.sid);
      if (!check.ok) return { ok: false, problem: check.problem };
      if (check.account.mustChangePassword) {
        return { ok: false, problem: mockProblem(403, 'PASSWORD_CHANGE_REQUIRED') };
      }
      if (check.account.role !== 'admin') {
        return { ok: false, problem: mockProblem(403, 'FORBIDDEN') };
      }
      return {
        ok: true,
        caller: {
          id: check.account.id,
          workshopId: check.account.workshopId,
          name: check.account.name,
          role: check.account.role,
        },
      };
    }
    if (claims.role !== 'admin') {
      return { ok: false, problem: mockProblem(403, 'FORBIDDEN') };
    }
    const workshopId = claims.tenantId ?? [...this.workshops.keys()][0] ?? '';
    return {
      ok: true,
      caller: {
        id: claims.sub ?? newId(),
        workshopId,
        name: claims.name || 'Admin Principal',
        role: claims.role,
      },
    };
  }

  private getActiveAdmins(workshopId: string): MockAccount[] {
    return [...this.accounts.values()].filter(
      (a) => a.workshopId === workshopId && a.role === 'admin' && a.status === 'active',
    );
  }

  /** Throttle of an email; 'locked' while the lock lasts. An expired lock starts over. */
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

  /** New session for a login or register; the cookie of this "browser" now points to it. */
  private openSession(account: MockAccount): string {
    const sessionId = newId();
    this.sessions.set(sessionId, { accountId: account.id, revoked: false });
    this.refreshCookie = sessionId;
    return sessionId;
  }

  private accountById(id: string): MockAccount | undefined {
    for (const account of this.accounts.values()) {
      if (account.id === id) return account;
    }
    return undefined;
  }

  private sessionOf(account: MockAccount, sessionId: string): SessionResponse {
    const workshop = this.workshops.get(account.workshopId);
    const user: SessionUser = {
      id: account.id,
      name: account.name,
      email: account.email,
      role: account.role,
      mustChangePassword: account.mustChangePassword,
      temporaryPasswordExpiresAt: account.temporaryPasswordExpiresAt,
    };
    return {
      accessToken: accessTokenFor(account, sessionId),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user,
      workshop: { id: account.workshopId, name: workshop?.name ?? '' },
    };
  }
}
