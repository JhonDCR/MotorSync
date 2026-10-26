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
import type { ProblemCode, SupportSessionResponse } from '../api/api.models';
import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from '../api/auth-api.service';
import { isProblem } from '../api/problem';
import { isSupportApiUrl } from '../auth/auth-token.interceptor';
import { SUPPORT_CHANGE_PASSWORD_PATH, SUPPORT_LOGIN_PATH } from './support.guards';
import { SupportSessionStore } from './support-session.store';

const SUPPORT_AUTH_PATH_PREFIX = '/api/v1/support/auth/';
const SUPPORT_REFRESH_URL = '/api/v1/support/auth/refresh';

const END_REASONS: Partial<Record<ProblemCode, 'expired' | 'revoked' | 'temporary-expired'>> = {
  SESSION_EXPIRED: 'expired',
  SESSION_REVOKED: 'revoked',
  TEMPORARY_PASSWORD_EXPIRED: 'temporary-expired',
};

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
 * Single-flight renewal of the support session (research R4, R5, R11, R13).
 * No background timers.
 */
@Injectable({ providedIn: 'root' })
export class SupportSessionRefreshCoordinator {
  private readonly http = inject(HttpClient);
  private readonly store = inject(SupportSessionStore);
  private readonly router = inject(Router);

  private inFlight: Observable<SupportSessionResponse> | null = null;

  refresh(): Observable<SupportSessionResponse> {
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

  handle(error: unknown): Observable<never> {
    if (!this.endSessionIfRejected(error) && problemCodeOf(error) === 'PASSWORD_CHANGE_REQUIRED') {
      void this.router.navigateByUrl(SUPPORT_CHANGE_PASSWORD_PATH);
    }
    return throwError(() => error);
  }

  private requestRefresh(): Observable<SupportSessionResponse> {
    return this.http.post<SupportSessionResponse>(SUPPORT_REFRESH_URL, null, {
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
    if (!current.startsWith(SUPPORT_LOGIN_PATH) && current !== SUPPORT_CHANGE_PASSWORD_PATH) {
      queryParams['returnUrl'] = current;
    }
    void this.router.navigate([SUPPORT_LOGIN_PATH], { queryParams });
    return true;
  }
}

function withToken(req: HttpRequest<unknown>, token: string): HttpRequest<unknown> {
  return req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
}

/**
 * Renews the support access token when it expires and retries the request.
 * Only acts on `/api/v1/support/**` URLs outside `/api/v1/support/auth/*`.
 */
export const supportRefreshInterceptor: HttpInterceptorFn = (req, next): Observable<HttpEvent<unknown>> => {
  const path = pathOf(req.url);
  if (!isSupportApiUrl(req.url) || path.startsWith(SUPPORT_AUTH_PATH_PREFIX)) {
    return next(req);
  }
  const coordinator = inject(SupportSessionRefreshCoordinator);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (problemCodeOf(error) !== 'TOKEN_EXPIRED') {
        return coordinator.handle(error);
      }
      return coordinator.refresh().pipe(
        switchMap((session) =>
          next(withToken(req, session.accessToken)).pipe(
            catchError((retryError: unknown) => coordinator.handle(retryError)),
          ),
        ),
      );
    }),
  );
};
