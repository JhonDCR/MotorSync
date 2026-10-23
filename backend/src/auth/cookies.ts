import type { CookieOptions, Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { readAuthFlags } from '../config/env.js';

/** Refresh cookie of the contract (research R5, R11). */
export const REFRESH_COOKIE_NAME = 'ms_refresh';
export const REFRESH_COOKIE_PATH = `/${API_PREFIX}/auth`;

/** CSRF header required by POST /auth/refresh and /auth/logout (research R11). */
const REQUESTED_WITH_HEADER = 'x-requested-with';
const REQUESTED_WITH_VALUE = 'motorsync';

/**
 * `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`, without Max-Age nor Expires: the session
 * lives while there is activity (FR-012). `Secure` follows AUTH_COOKIE_SECURE (default true).
 */
export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: readAuthFlags().cookieSecure,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
  };
}

/** Sets ms_refresh with the opaque refresh token (only on a successful response). */
export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions());
}

/**
 * Clears ms_refresh with the same attributes and `Max-Age=0` (contract ClearRefreshCookie).
 * Written with res.cookie because Express 5 clearCookie() sets Expires but no Max-Age.
 */
export function clearRefreshCookie(res: Response): void {
  res.cookie(REFRESH_COOKIE_NAME, '', { ...refreshCookieOptions(), maxAge: 0 });
}

/**
 * Cookies of a raw `Cookie` header (own parser, no cookie-parser, research R11). Splits each pair
 * on its first `=`, drops surrounding double quotes and decodes percent-encoding; a malformed
 * encoding leaves the value as sent. If a name repeats, the first one wins. Never throws.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    // `__proto__` would replace the prototype of the result instead of adding a key.
    if (name === '' || name === '__proto__' || Object.hasOwn(cookies, name)) continue;
    const raw = part.slice(separator + 1).trim();
    const value = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    cookies[name] = decodeOrKeep(value);
  }
  return cookies;
}

function decodeOrKeep(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Value of the ms_refresh cookie of a request, or undefined. */
export function readRefreshCookie(header: string | undefined): string | undefined {
  const value = parseCookies(header)[REFRESH_COOKIE_NAME];
  return value === undefined || value === '' ? undefined : value;
}

/** 400 VALIDATION_ERROR unless the request carries exactly `X-Requested-With: motorsync` (R11). */
export function assertRequestedWith(headers: Record<string, string | string[] | undefined>): void {
  if (headers[REQUESTED_WITH_HEADER] !== REQUESTED_WITH_VALUE) {
    throw new ProblemException(400, 'VALIDATION_ERROR');
  }
}
