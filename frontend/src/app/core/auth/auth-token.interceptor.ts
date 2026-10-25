import { HttpInterceptorFn } from '@angular/common/http';

// research.md R2: el token de desarrollo se guarda en localStorage desde /dev-token.
export const AUTH_TOKEN_STORAGE_KEY = 'motorsync.token';
export const SUPPORT_TOKEN_STORAGE_KEY = 'motorsync.support.token';

const SUPPORT_API_PREFIX = '/api/v1/support';

export function readAuthToken(): string | null {
  const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
  return token ? token : null;
}

export function readSupportToken(): string | null {
  const token = localStorage.getItem(SUPPORT_TOKEN_STORAGE_KEY)?.trim();
  return token ? token : null;
}

function pathOf(url: string): string {
  const withoutOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  return withoutOrigin.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
}

export function isSupportApiUrl(url: string): boolean {
  const path = pathOf(url);
  return path === SUPPORT_API_PREFIX || path.startsWith(`${SUPPORT_API_PREFIX}/`);
}

/**
 * Añade `Authorization: Bearer <token>` leyendo el token correspondiente en cada request:
 * - Para `/api/v1/support/**` usa `motorsync.support.token`.
 * - Para el resto usa `motorsync.token`.
 * Nunca mezcla ambos ni envía `X-Tenant-Id` (FR-008, FR-022).
 */
export const authTokenInterceptor: HttpInterceptorFn = (req, next) => {
  const token = isSupportApiUrl(req.url) ? readSupportToken() : readAuthToken();
  if (token === null) {
    return next(req);
  }
  return next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};
