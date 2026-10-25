// T003 (specs/003-soporte-plataforma): e2e helpers for the support panel and the public
// "¿Olvidaste tu contraseña?" flow. They only go through the HTTP surface of the app under test
// (contracts/openapi.yaml), never through production modules, so a change in the API internals
// cannot make a test pass by accident.
// Feature 002 (T002 of specs/002-autenticacion) has the workshop equivalents in auth.ts
// (loginAs, refreshCookieFrom, withRefreshCookie): the two zones use separate cookies.
import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';

/** Name of the support refresh cookie (contract: `ms_support_refresh`, Path=/api/v1/support/auth). */
export const SUPPORT_REFRESH_COOKIE_NAME = 'ms_support_refresh';

export interface SupportLoginResult {
  accessToken: string;
  /** `ms_support_refresh=<value>`, ready for withSupportRefreshCookie(). */
  refreshCookie: string;
  /** SupportSessionResponse of the contract (accessToken, expiresIn, agent). */
  body: Record<string, unknown>;
}

/**
 * `name=value` of the ms_support_refresh cookie set by a response (the attributes are dropped),
 * or undefined if the response sets none. A cleared cookie comes back as `ms_support_refresh=`.
 */
export function supportRefreshCookieFrom(
  response: Response,
): string | undefined {
  const header = response.headers['set-cookie'] as
    string | string[] | undefined;
  const cookies =
    header === undefined ? [] : Array.isArray(header) ? header : [header];
  const cookie = cookies.find((value) =>
    value.startsWith(`${SUPPORT_REFRESH_COOKIE_NAME}=`),
  );
  return cookie?.split(';')[0].trim();
}

/** Headers for POST /support/auth/refresh and /support/auth/logout: cookie + CSRF header. */
export function withSupportRefreshCookie(
  cookie: string,
): Record<string, string> {
  return { Cookie: cookie, 'X-Requested-With': 'motorsync' };
}

/**
 * POST /api/v1/support/auth/login. Throws (with status and body) if the login does not return
 * 200, like loginAs() of the workshop zone.
 */
export async function loginAsSupport(
  app: INestApplication<App>,
  email: string,
  password: string,
): Promise<SupportLoginResult> {
  const response = await request(app.getHttpServer())
    .post('/api/v1/support/auth/login')
    .send({ email, password });
  if (response.status !== 200) {
    throw new Error(
      `loginAsSupport(${email}): expected 200, got ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  const body = response.body as Record<string, unknown>;
  const refreshCookie = supportRefreshCookieFrom(response);
  if (!refreshCookie) {
    throw new Error(
      `loginAsSupport(${email}): the response sets no ms_support_refresh cookie`,
    );
  }
  return { accessToken: body.accessToken as string, refreshCookie, body };
}

/**
 * Lets the app under test read `X-Forwarded-For` as `req.ip` (research R8, plan risk 3). Only
 * the test app is touched: `trust proxy` in production is a deployment setting and the API code
 * does not change. Call it after `app.init()` and before the requests that simulate origins.
 */
export function enableTrustProxyForTests(app: INestApplication<App>): void {
  const instance = app.getHttpAdapter().getInstance() as {
    set: (setting: string, value: unknown) => void;
  };
  instance.set('trust proxy', 'loopback');
}

export interface ForgotPasswordOptions {
  /** Origin sent as `X-Forwarded-For`; the API hashes it into help_request_throttle. */
  ip: string;
}

export interface ForgotPasswordResult {
  response: Response;
  /** Wall-clock duration of the request, in milliseconds (FR-003 compares 202 and 429). */
  durationMs: number;
}

/**
 * POST /api/v1/auth/forgot-password with a simulated origin. Returns the raw supertest response
 * (202, 400 or 429) and how long it took, so a test can compare the response times of an
 * existing and a non-existing email without depending on the server's clock.
 */
export async function forgotPassword(
  app: INestApplication<App>,
  body: Record<string, unknown>,
  options: ForgotPasswordOptions,
): Promise<ForgotPasswordResult> {
  const startedAt = process.hrtime.bigint();
  const response = await request(app.getHttpServer())
    .post('/api/v1/auth/forgot-password')
    .set('X-Forwarded-For', options.ip)
    .send(body);
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { response, durationMs };
}
