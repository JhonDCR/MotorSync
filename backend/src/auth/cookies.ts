import type { CookieOptions, Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { readAuthFlags } from '../config/env.js';

/** Name and Path of a refresh cookie: the workshop one or the support panel one (research R4). */
export interface RefreshCookie {
  name: string;
  path: string;
}

/** Refresh cookie of the contract (research R5, R11). */
export const REFRESH_COOKIE_NAME = 'ms_refresh';
export const REFRESH_COOKIE_PATH = `/${API_PREFIX}/auth`;

/** Refresh cookie of the workshop (research R5, R11 of the 002). */
export const WORKSHOP_REFRESH_COOKIE: RefreshCookie = {
  name: REFRESH_COOKIE_NAME,
  path: REFRESH_COOKIE_PATH,
};

/** Refresh cookie of the support panel, never sent to workshop routes (research R3, R4). */
export const SUPPORT_REFRESH_COOKIE: RefreshCookie = {
  name: 'ms_support_refresh',
  path: `/${API_PREFIX}/support/auth`,
};

/** CSRF header required by POST /auth/refresh and /auth/logout (research R11). */
const REQUESTED_WITH_HEADER = 'x-requested-with';
const REQUESTED_WITH_VALUE = 'motorsync';

/**
 * `HttpOnly; Secure; SameSite=Strict` and the Path of the cookie (the workshop one by default),
 * without Max-Age nor Expires: the session lives while there is activity (FR-012). `Secure`
 * follows AUTH_COOKIE_SECURE (default true).
 */
export function refreshCookieOptions(
  cookie: RefreshCookie = WORKSHOP_REFRESH_COOKIE,
): CookieOptions {
  return {
    httpOnly: true,
    secure: readAuthFlags().cookieSecure,
    sameSite: 'strict',
    path: cookie.path,
  };
}

/** Sets the refresh cookie (ms_refresh by default) with the opaque token (only on success). */
export function setRefreshCookie(
  res: Response,
  token: string,
  cookie: RefreshCookie = WORKSHOP_REFRESH_COOKIE,
): void {
  res.cookie(cookie.name, token, refreshCookieOptions(cookie));
}

/**
 * Clears the refresh cookie (ms_refresh by default) with the same attributes and `Max-Age=0`
 * (contract ClearRefreshCookie). Written with res.cookie because Express 5 clearCookie() sets
 * Expires but no Max-Age.
 */
export function clearRefreshCookie(
  res: Response,
  cookie: RefreshCookie = WORKSHOP_REFRESH_COOKIE,
): void {
  res.cookie(cookie.name, '', { ...refreshCookieOptions(cookie), maxAge: 0 });
}

/**
 * Cookies of a raw `Cookie` header (own parser, no cookie-parser, research R11). Splits each pair
 * on its first `=`, drops surrounding double quotes and decodes percent-encoding; a malformed
 * encoding leaves the value as sent. If a name repeats, the first one wins. Never throws.
 */
export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    // `__proto__` would replace the prototype of the result instead of adding a key.
    if (name === '' || name === '__proto__' || Object.hasOwn(cookies, name))
      continue;
    const raw = part.slice(separator + 1).trim();
    const value =
      raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
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

/** Value of the refresh cookie (ms_refresh by default) of a request, or undefined. */
export function readRefreshCookie(
  header: string | undefined,
  cookie: RefreshCookie = WORKSHOP_REFRESH_COOKIE,
): string | undefined {
  const value = parseCookies(header)[cookie.name];
  return value === undefined || value === '' ? undefined : value;
}

/** 400 VALIDATION_ERROR unless the request carries exactly `X-Requested-With: motorsync` (R11). */
export function assertRequestedWith(
  headers: Record<string, string | string[] | undefined>,
): void {
  if (headers[REQUESTED_WITH_HEADER] !== REQUESTED_WITH_VALUE) {
    throw new ProblemException(400, 'VALIDATION_ERROR');
  }
}
