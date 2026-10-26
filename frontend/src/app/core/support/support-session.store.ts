import { HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, Injector, signal } from '@angular/core';
import { catchError, finalize, map, type Observable, of, shareReplay } from 'rxjs';
import type { CurrentSupportSessionResponse, SupportAgent, SupportSessionResponse } from '../api/api.models';
import { isProblem } from '../api/problem';
import { SupportApiService } from '../api/support-api.service';
import { readSupportToken, SUPPORT_TOKEN_STORAGE_KEY } from '../auth/auth-token.interceptor';

export { SUPPORT_TOKEN_STORAGE_KEY };

/**
 * Support session state of the frontend (research R4, R13).
 * Agent and mustChangePassword always come from server responses (login, refresh, password change and GET /support/auth/me),
 * never from the JWT payload. Isolated from workshop SessionStore and `motorsync.token`.
 */
@Injectable({ providedIn: 'root' })
export class SupportSessionStore {
  private readonly injector = inject(Injector);

  private readonly currentAgent = signal<SupportAgent | null>(null);
  private pending: Observable<boolean> | null = null;

  readonly agent = this.currentAgent.asReadonly();
  readonly isSignedIn = computed(() => this.currentAgent() !== null);
  readonly mustChangePassword = computed(() => this.currentAgent()?.mustChangePassword ?? false);

  /** Login, refresh and POST /support/auth/password: stores the support access token and agent data. */
  setSession(session: SupportSessionResponse): void {
    localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, session.accessToken);
    this.currentAgent.set(session.agent);
  }

  /** GET /support/auth/me: agent data only; the stored support token is left as is. */
  setCurrent(current: CurrentSupportSessionResponse): void {
    this.currentAgent.set(current.agent);
  }

  clear(): void {
    localStorage.removeItem(SUPPORT_TOKEN_STORAGE_KEY);
    this.currentAgent.set(null);
  }

  /**
   * Whether there is a usable support session.
   * Without `motorsync.support.token`: false, no request.
   * With agent already loaded: true, no request.
   * With a token but no agent (page reload): asks GET /support/auth/me.
   */
  restore(): Observable<boolean> {
    if (readSupportToken() === null) {
      return of(false);
    }
    if (this.currentAgent() !== null) {
      return of(true);
    }
    this.pending ??= this.load().pipe(
      finalize(() => {
        this.pending = null;
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    return this.pending;
  }

  private load(): Observable<boolean> {
    const api = this.injector.get(SupportApiService);
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
