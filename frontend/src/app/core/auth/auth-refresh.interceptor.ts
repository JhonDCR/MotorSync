import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders,
  type HttpEvent,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, finalize, type Observable, shareReplay, switchMap, tap, throwError } from 'rxjs';
import type { ProblemCode, SessionResponse } from '../api/api.models';
import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from '../api/auth-api.service';
import { isProblem } from '../api/problem';
import { CHANGE_PASSWORD_PATH, LOGIN_PATH } from './auth.guards';
import { SessionStore } from './session.store';

const AUTH_PATH_PREFIX = '/api/v1/auth/';
const REFRESH_URL = '/api/v1/auth/refresh';

/**
 * Reason shown by the login page (query `reason`) for each code that ends the session. The backend also answers
 * TEMPORARY_PASSWORD_EXPIRED on any request of a session whose temporary password expired (research R7).
 */
const END_REASONS: Partial<Record<ProblemCode, 'expired' | 'revoked' | 'temporary-expired'>> = {
  SESSION_EXPIRED: 'expired',
  SESSION_REVOKED: 'revoked',
  TEMPORARY_PASSWORD_EXPIRED: 'temporary-expired',
};

/** Path of a request URL, without origin, query or fragment. */
function pathOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').split(/[?#]/)[0];
}

function problemCodeOf(error: unknown): ProblemCode | null {
  if (error instanceof HttpErrorResponse && isProblem(error.error)) {
    return error.error.code;
  }
  return null;
}

/**
 * Single-flight renewal of the session (research R5, R13). Every request that fails with TOKEN_EXPIRED while a
 * refresh is running waits for that same refresh. It never acts on its own: no timers (US3-AC2).
 */
@Injectable({ providedIn: 'root' })
export class SessionRefreshCoordinator {
  private readonly http = inject(HttpClient);
  private readonly store = inject(SessionStore);
  private readonly router = inject(Router);

  private inFlight: Observable<SessionResponse> | null = null;

  /** The running refresh, or a new one. A REFRESH_CONFLICT (two tabs at once) is retried exactly once. */
  refresh(): Observable<SessionResponse> {
    if (this.inFlight === null) {
      this.inFlight = this.requestRefresh().pipe(
        catchError((error: unknown) =>
          problemCodeOf(error) === 'REFRESH_CONFLICT' ? this.requestRefresh() : throwError(() => error),
        ),
        tap({
          next: (session) => this.store.setSession(session),
          error: (error: unknown) => this.endSessionIfRejected(error),
        }),
        finalize(() => {
          this.inFlight = null;
        }),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.inFlight;
  }

  /**
   * Reacts to the codes that end or block the session and lets the error go on to the caller.
   * SESSION_EXPIRED / SESSION_REVOKED → clear() and /login?reason=…; PASSWORD_CHANGE_REQUIRED → /change-password.
   */
  handle(error: unknown): Observable<never> {
    if (!this.endSessionIfRejected(error) && problemCodeOf(error) === 'PASSWORD_CHANGE_REQUIRED') {
      void this.router.navigateByUrl(CHANGE_PASSWORD_PATH);
    }
    return throwError(() => error);
  }

  private requestRefresh(): Observable<SessionResponse> {
    // Through HttpClient (and so through the mock when USE_MOCK_API is on). The body carries no token: the
    // refresh token only travels in the HttpOnly cookie (R11).
    return this.http.post<SessionResponse>(REFRESH_URL, null, {
      withCredentials: true,
      headers: new HttpHeaders({ [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE }),
    });
  }

  private endSessionIfRejected(error: unknown): boolean {
    const code = problemCodeOf(error);
    const reason = code === null ? undefined : END_REASONS[code];
    if (reason === undefined) {
      return false;
    }
    this.store.clear();
    const current = this.router.url;
    const queryParams: Record<string, string> = { reason };
    if (!current.startsWith(LOGIN_PATH) && current !== CHANGE_PASSWORD_PATH) {
      queryParams['returnUrl'] = current;
    }
    void this.router.navigate([LOGIN_PATH], { queryParams });
    return true;
  }
}

function withToken(req: HttpRequest<unknown>, token: string): HttpRequest<unknown> {
  return req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
}

/**
 * Renews the access token when it expires and retries the request (research R5, R13). It goes after
 * authTokenInterceptor and before mockApiInterceptor. /api/v1/auth/* passes untouched, so login, register,
 * refresh, logout, password and me errors reach their screens as they are and the refresh never loops.
 */
export const authRefreshInterceptor: HttpInterceptorFn = (req, next): Observable<HttpEvent<unknown>> => {
  if (pathOf(req.url).startsWith(AUTH_PATH_PREFIX)) {
    return next(req);
  }
  const coordinator = inject(SessionRefreshCoordinator);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (problemCodeOf(error) !== 'TOKEN_EXPIRED') {
        return coordinator.handle(error);
      }
      // The caller gets the response of the retry, never the 401. A retry is not refreshed again (no loops).
      return coordinator
        .refresh()
        .pipe(
          switchMap((session) =>
            next(withToken(req, session.accessToken)).pipe(catchError((retryError: unknown) => coordinator.handle(retryError))),
          ),
        );
    }),
  );
};
