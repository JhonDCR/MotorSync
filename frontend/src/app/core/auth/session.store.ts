import { HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, Injector, signal } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, finalize, map, type Observable, of, shareReplay } from 'rxjs';
import type { CurrentSessionResponse, SessionResponse, SessionUser, Workshop } from '../api/api.models';
import { AuthApiService } from '../api/auth-api.service';
import { isProblem } from '../api/problem';
import { AUTH_TOKEN_STORAGE_KEY, readAuthToken } from './auth-token.interceptor';

/**
 * Session state of the frontend (research R13). User, role, workshop and mustChangePassword always come from the
 * server responses (login, register, refresh, password change and GET /auth/me), never from the JWT payload.
 * Nothing here is scheduled in time: there is no background refresh (US3-AC2, R5).
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  // AuthApiService (and with it HttpClient) is resolved only when restore() needs it, so screens that only read
  // the session do not require HttpClient.
  private readonly injector = inject(Injector);

  private readonly currentUser = signal<SessionUser | null>(null);
  private readonly currentWorkshop = signal<Workshop | null>(null);
  private pending: Observable<boolean> | null = null;

  readonly user = this.currentUser.asReadonly();
  readonly workshop = this.currentWorkshop.asReadonly();
  readonly isSignedIn = computed(() => this.currentUser() !== null);
  readonly mustChangePassword = computed(() => this.currentUser()?.mustChangePassword ?? false);

  /** Login, register, refresh and POST /auth/password: stores the access token and the session data. */
  setSession(session: SessionResponse): void {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, session.accessToken);
    this.currentUser.set(session.user);
    this.currentWorkshop.set(session.workshop);
    const router = this.injector.get(Router, null);
    if (router !== null && router.url.split(/[?#]/)[0] === '/forgot-password') {
      router.onSameUrlNavigation = 'reload';
    }
  }

  /** GET /auth/me: session data only; the stored token is left as is. */
  setCurrent(current: CurrentSessionResponse): void {
    this.currentUser.set(current.user);
    this.currentWorkshop.set(current.workshop);
  }

  /**
   * Applies to the signed-in user the data of a server response about that same account (for example the
   * UserAccount returned by PUT /users/{own id}/role), so the role shown and checked updates without a reload.
   * Does nothing without a session or when the account is another one.
   */
  updateUser(account: Pick<SessionUser, 'id' | 'name' | 'email' | 'role'>): void {
    const current = this.currentUser();
    if (current === null || current.id !== account.id) {
      return;
    }
    this.currentUser.set({ ...current, name: account.name, email: account.email, role: account.role });
  }

  clear(): void {
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    this.currentUser.set(null);
    this.currentWorkshop.set(null);
  }

  /**
   * Whether there is a usable session. Without a token: false, no request. With the data already loaded: true, no
   * request. With a token but no data (page reload): asks GET /auth/me. If the access token only expired
   * (TOKEN_EXPIRED), the session is renewed once with POST /auth/refresh. A 401 clears the session; any other
   * failure (for example no network) answers false and keeps the token for a later attempt.
   */
  restore(): Observable<boolean> {
    if (readAuthToken() === null) {
      return of(false);
    }
    if (this.currentUser() !== null) {
      return of(true);
    }
    // Single-flight: the app initializer and the guard of the first navigation share one GET /auth/me.
    this.pending ??= this.load().pipe(
      finalize(() => {
        this.pending = null;
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    return this.pending;
  }

  private load(): Observable<boolean> {
    const api = this.injector.get(AuthApiService);
    return api.me().pipe(
      map((current) => {
        this.setCurrent(current);
        return true;
      }),
      catchError((error: unknown) => {
        if (isProblem(error) && error.code === 'TOKEN_EXPIRED') {
          return api.refresh().pipe(
            map((session) => {
              this.setSession(session);
              return true;
            }),
            catchError((refreshError: unknown) => of(this.rejected(refreshError))),
          );
        }
        return of(this.rejected(error));
      }),
    );
  }

  /** A 401 means the server no longer accepts this session: it is cleared. Always answers false. */
  private rejected(error: unknown): false {
    if (statusOf(error) === 401) {
      this.clear();
    }
    return false;
  }
}

function statusOf(error: unknown): number | null {
  if (isProblem(error)) return error.status;
  if (error instanceof HttpErrorResponse) return error.status;
  return null;
}
