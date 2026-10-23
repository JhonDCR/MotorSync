import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type { LoginRequest, RegisterRequest, SessionResponse } from './api.models';
import { toProblem } from './problem-operator';

const AUTH_URL = '/api/v1/auth';

/**
 * Public auth endpoints of specs/002-autenticacion/contracts/openapi.yaml (register and login).
 * withCredentials lets the browser keep the HttpOnly refresh cookie; the frontend never reads it.
 * The body is sent as is: the password is never trimmed or transformed (FR-005).
 * Storing the access token is up to the caller.
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
}
