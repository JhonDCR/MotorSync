import type { CookieOptions, Response } from 'express';
import { API_PREFIX } from '../app.setup.js';
import { readAuthFlags } from '../config/env.js';

/** Refresh cookie of the contract (research R5, R11). */
export const REFRESH_COOKIE_NAME = 'ms_refresh';
export const REFRESH_COOKIE_PATH = `/${API_PREFIX}/auth`;

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
 * Value of a cookie from a raw `Cookie` header, or undefined (own parser, no cookie-parser,
 * research R11). Malformed percent-encoding leaves the value as sent.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    const value = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}
