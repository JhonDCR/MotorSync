import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import type {
  ChangePasswordRequest,
  CurrentSessionResponse,
  LoginRequest,
  RegisterRequest,
  SessionResponse,
} from './api.models';
import { toProblem } from './problem-operator';

const AUTH_URL = '/api/v1/auth';

/** R11 (CSRF): refresh and logout are only accepted with this header, which a cross-site form cannot send. */
export const REQUESTED_WITH_HEADER = 'X-Requested-With';
export const REQUESTED_WITH_VALUE = 'motorsync';

function cookieRequestOptions(): { withCredentials: true; headers: HttpHeaders } {
  return { withCredentials: true, headers: new HttpHeaders({ [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE }) };
}

/**
 * Auth endpoints of specs/002-autenticacion/contracts/openapi.yaml.
 * withCredentials lets the browser keep and send the HttpOnly refresh cookie; the frontend never reads it and no
 * body carries a refresh token. Passwords are sent as typed: never trimmed or transformed (FR-005).
 * Storing the access token is up to the caller (SessionStore).
 */
@Injectable({ providedIn: 'root' })
export class AuthApiService {
  private readonly http = inject(HttpClient);

  register(body: RegisterRequest): Observable<SessionResponse> {
    return this.http.post<SessionResponse>(`${AUTH_URL}/register`, body, { withCredentials: true }).pipe(toProblem);
  }

  login(body: LoginRequest): Observable<SessionResponse> {
    return this.http.post<SessionResponse>(`${AUTH_URL}/login`, body, { withCredentials: true }).pipe(toProblem);
  }

  refresh(): Observable<SessionResponse> {
    return this.http.post<SessionResponse>(`${AUTH_URL}/refresh`, null, cookieRequestOptions()).pipe(toProblem);
  }

  logout(): Observable<void> {
    return this.http.post(`${AUTH_URL}/logout`, null, cookieRequestOptions()).pipe(
      map(() => undefined),
      toProblem,
    );
  }

  me(): Observable<CurrentSessionResponse> {
    return this.http.get<CurrentSessionResponse>(`${AUTH_URL}/me`).pipe(toProblem);
  }

  changePassword(body: ChangePasswordRequest): Observable<SessionResponse> {
    const request: ChangePasswordRequest = { currentPassword: body.currentPassword, newPassword: body.newPassword };
    return this.http.post<SessionResponse>(`${AUTH_URL}/password`, request).pipe(toProblem);
  }
}
