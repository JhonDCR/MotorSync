import { HttpInterceptorFn } from '@angular/common/http';

// research.md R2: el token de desarrollo se guarda en localStorage desde /dev-token.
export const AUTH_TOKEN_STORAGE_KEY = 'motorsync.token';

export function readAuthToken(): string | null {
  const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
  return token ? token : null;
}

/**
 * Añade `Authorization: Bearer <token>` leyendo el token en cada request.
 * Nunca envía `X-Tenant-Id`: el taller sale solo del token (FR-022).
 */
export const authTokenInterceptor: HttpInterceptorFn = (req, next) => {
  const token = readAuthToken();
  if (token === null) {
    return next(req);
  }
  return next(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
};
