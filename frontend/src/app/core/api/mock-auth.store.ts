import { Injectable } from '@angular/core';
import { isValidRuc } from '../../shared/identifiers/ec-document';
import { isValidEmail, normalizeEmail } from '../../shared/identifiers/email';
import { normalizeDocument } from '../../shared/identifiers/normalize';
import type { FieldError, Role, SessionResponse, SessionUser, Workshop } from './api.models';
import { mockProblem, newId, type MockResult } from './mock-api.store';

// In-memory accounts and workshops of the mock API for POST /auth/register and /auth/login
// (specs/002-autenticacion/contracts/openapi.yaml, research R13). Same codes and rules as the backend.
// It lives in the root injector, so every TestBed (and every page load) starts with its own data.
// Passwords are compared as typed: this store only exists in the browser for development, and it never
// returns or echoes a password.

const REGISTER_FIELDS = ['workshopName', 'ruc', 'name', 'email', 'password'] as const;
const LOGIN_FIELDS = ['email', 'password'] as const;
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
      pwd_change: false,
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
    }),
  );
  return `${header}.${payload}.mock-signature`;
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
function readPassword(body: Record<string, unknown>, errors: FieldErrors, minLength: number): string | null {
  const value = body['password'];
  if (value === undefined || value === null || value === '') {
    errors.add('password', 'REQUIRED', 'Campo obligatorio');
    return null;
  }
  if (typeof value !== 'string') {
    errors.add('password', 'VALIDATION_ERROR', 'Debe ser texto');
    return null;
  }
  const length = unicodeLength(value);
  if (length < minLength) {
    errors.add('password', 'PASSWORD_TOO_SHORT', `Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
    return null;
  }
  if (length > PASSWORD_MAX_LENGTH) {
    errors.add('password', 'PASSWORD_TOO_LONG', `Admite como máximo ${PASSWORD_MAX_LENGTH} caracteres`);
    return null;
  }
  return value;
}

/** Undefined values are dropped by JSON serialization: they count as absent. */
function definedEntries(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
}

function notAnObject<T>(): MockResult<T> {
  return {
    ok: false,
    problem: mockProblem(400, 'VALIDATION_ERROR', {
      errors: [{ field: 'body', code: 'VALIDATION_ERROR', message: 'El cuerpo debe ser un objeto JSON' }],
    }),
  };
}

function validationFailed<T>(errors: FieldErrors): MockResult<T> {
  return { ok: false, problem: mockProblem(400, 'VALIDATION_ERROR', { errors: errors.list }) };
}

@Injectable({ providedIn: 'root' })
export class MockAuthStore {
  private readonly workshops = new Map<string, MockWorkshop>();
  /** Accounts by normalized email (unique in all of MotorSync). */
  private readonly accounts = new Map<string, MockAccount>();
  /** Login throttling by normalized email, whether the account exists or not (US2-AC8). */
  private readonly throttles = new Map<string, LoginThrottle>();

  constructor() {
    const workshop: MockWorkshop = { id: newId(), ...SEED_WORKSHOP };
    this.workshops.set(workshop.id, workshop);
    for (const account of SEED_ACCOUNTS) {
      this.accounts.set(account.email, { id: newId(), workshopId: workshop.id, password: SEED_PASSWORD, ...account });
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
      return { ok: false, problem: mockProblem(409, 'RUC_ALREADY_REGISTERED') };
    }
    if (this.accounts.has(email)) {
      return { ok: false, problem: mockProblem(409, 'REGISTRATION_FAILED') };
    }

    const workshop: MockWorkshop = { id: newId(), name: workshopName, ruc };
    const account: MockAccount = { id: newId(), workshopId: workshop.id, name, email, role: 'admin', password };
    this.workshops.set(workshop.id, workshop);
    this.accounts.set(email, account);
    return { ok: true, status: 201, body: this.sessionOf(account) };
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
    const throttle = this.throttles.get(email) ?? { failures: 0, lockedUntil: null };
    if (throttle.lockedUntil !== null && throttle.lockedUntil > now) {
      return { ok: false, problem: mockProblem(429, 'ACCOUNT_LOCKED') };
    }
    if (throttle.lockedUntil !== null) {
      throttle.failures = 0;
      throttle.lockedUntil = null;
    }

    const account = this.accounts.get(email);
    if (account === undefined || account.password !== password) {
      throttle.failures += 1;
      if (throttle.failures >= MAX_FAILED_ATTEMPTS) {
        throttle.lockedUntil = now + LOCK_DURATION_MS;
      }
      this.throttles.set(email, throttle);
      // Same body whether the email exists or not (US2-AC3, FR-008).
      return { ok: false, problem: mockProblem(401, 'INVALID_CREDENTIALS') };
    }

    this.throttles.delete(email);
    return { ok: true, status: 200, body: this.sessionOf(account) };
  }

  private sessionOf(account: MockAccount): SessionResponse {
    const workshop = this.workshops.get(account.workshopId);
    const user: SessionUser = {
      id: account.id,
      name: account.name,
      email: account.email,
      role: account.role,
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
    };
    return {
      accessToken: accessTokenFor(account, newId()),
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user,
      workshop: { id: account.workshopId, name: workshop?.name ?? '' },
    };
  }
}
