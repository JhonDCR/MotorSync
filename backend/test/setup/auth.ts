// T002: issues HS256 JWTs for e2e tests, signed with JWT_SECRET (research R3).
// Implemented with node:crypto on purpose: the e2e harness does not depend on the same
// library the API uses to verify (@nestjs/jwt), so a token signed here and accepted by the
// API also proves the API follows the standard (alg HS256, base64url, exp in seconds).
// T011 adds signTestJwt() to build malformed tokens (alg none, HS384, missing claims).
// T002 of feature 002 adds loginAs(), refreshCookieFrom(), withRefreshCookie() and decodeJwtPayload().
import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';

export type TestRole = 'asesor' | 'admin';

export interface TestTokenOptions {
  tenantId: string;
  userId: string;
  role: TestRole;
  name: string;
  /**
   * Lifetime in seconds, or a string such as '30s', '15m', '1h', '7d'.
   * A negative number issues an already expired token. Default: 1 hour.
   */
  expiresIn?: number | string;
  /** Overrides the secret, e.g. to test that a token signed with another key is rejected. */
  secret?: string;
}

/** Algorithms the raw signer can produce. Only HS256 is accepted by the API (research R3). */
export type TestJwtAlg = 'HS256' | 'HS384' | 'HS512' | 'none';

export interface SignTestJwtOptions {
  /** Header alg. 'none' produces an unsigned token (empty signature). Default: HS256. */
  alg?: TestJwtAlg;
  /** Default: JWT_SECRET. */
  secret?: string;
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

const HMAC_BY_ALG: Record<Exclude<TestJwtAlg, 'none'>, string> = {
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
};

function toSeconds(expiresIn: number | string): number {
  if (typeof expiresIn === 'number') return Math.trunc(expiresIn);
  const match = /^(-?\d+)\s*([smhd])?$/.exec(expiresIn.trim());
  if (!match)
    throw new Error(`issueTestToken: invalid expiresIn "${expiresIn}"`);
  return Number(match[1]) * UNIT_SECONDS[match[2] ?? 's'];
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function requireSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET is missing or shorter than 32 characters in the e2e environment',
    );
  }
  return secret;
}

/**
 * Low-level signer: signs any payload as-is (no claim is added or checked). Used to build
 * malformed tokens: missing claims, invalid uuids, unknown roles, alg none or HS384.
 */
export function signTestJwt(
  payload: Record<string, unknown>,
  options: SignTestJwtOptions = {},
): string {
  const alg = options.alg ?? 'HS256';
  const header = { alg, typ: 'JWT' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  if (alg === 'none') return `${signingInput}.`;
  const secret = options.secret ?? requireSecret();
  const signature = createHmac(HMAC_BY_ALG[alg], secret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

/** Claims of a valid token (sub, tenant_id, role, name, iat, exp) for the given options. */
export function testTokenClaims(
  options: TestTokenOptions,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: options.userId,
    tenant_id: options.tenantId,
    role: options.role,
    name: options.name,
    iat: now,
    exp: now + toSeconds(options.expiresIn ?? 3600),
  };
}

export function issueTestToken(options: TestTokenOptions): string {
  return signTestJwt(testTokenClaims(options), {
    alg: 'HS256',
    secret: options.secret,
  });
}

/** Convenience for supertest: `.set(authHeader(token))`. */
export function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------------------------
// Feature 002 (T002 of specs/002-autenticacion): real sessions through the API.
// ---------------------------------------------------------------------------------------------

/** Name of the refresh cookie (contract: `ms_refresh`, HttpOnly, Path=/api/v1/auth). */
export const REFRESH_COOKIE_NAME = 'ms_refresh';

export interface LoginResult {
  accessToken: string;
  /** `ms_refresh=<value>`, ready for withRefreshCookie(). */
  refreshCookie: string;
  /** SessionResponse of the contract. */
  body: Record<string, unknown>;
}

/**
 * `name=value` of the ms_refresh cookie set by a response (the attributes are dropped), or
 * undefined if the response sets none. A cleared cookie comes back as `ms_refresh=`.
 */
export function refreshCookieFrom(response: Response): string | undefined {
  const header = response.headers['set-cookie'] as
    string | string[] | undefined;
  const cookies =
    header === undefined ? [] : Array.isArray(header) ? header : [header];
  const cookie = cookies.find((value) =>
    value.startsWith(`${REFRESH_COOKIE_NAME}=`),
  );
  return cookie?.split(';')[0].trim();
}

/** Headers for POST /auth/refresh and /auth/logout: the cookie and the CSRF header. */
export function withRefreshCookie(cookie: string): Record<string, string> {
  return { Cookie: cookie, 'X-Requested-With': 'motorsync' };
}

/** POST /api/v1/auth/login. Throws (with status and body) if the login does not return 200. */
export async function loginAs(
  app: INestApplication<App>,
  email: string,
  password: string,
): Promise<LoginResult> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password });
  if (response.status !== 200) {
    throw new Error(
      `loginAs(${email}): expected 200, got ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  const body = response.body as Record<string, unknown>;
  const refreshCookie = refreshCookieFrom(response);
  if (!refreshCookie)
    throw new Error(
      `loginAs(${email}): the response sets no ms_refresh cookie`,
    );
  return { accessToken: body.accessToken as string, refreshCookie, body };
}

/** Payload of a JWT, without verifying the signature (to read sid, pwd_change, exp...). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('decodeJwtPayload: not a JWT');
  return JSON.parse(
    Buffer.from(parts[1], 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
}
