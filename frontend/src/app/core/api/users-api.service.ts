import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ChangeRoleRequest,
  CreateUserRequest,
  ResetPasswordRequest,
  Role,
  UserAccount,
  UserHistoryResponse,
  UserListResponse,
} from './api.models';
import { toProblem } from './problem-operator';

const USERS_URL = '/api/v1/users';

/** Users endpoints of specs/002-autenticacion/contracts/openapi.yaml. */
@Injectable({ providedIn: 'root' })
export class UsersApiService {
  private readonly http = inject(HttpClient);

  list(): Observable<UserListResponse> {
    return this.http.get<UserListResponse>(USERS_URL).pipe(toProblem);
  }

  create(req: CreateUserRequest): Observable<UserAccount> {
    return this.http.post<UserAccount>(USERS_URL, req).pipe(toProblem);
  }

  getById(id: string): Observable<UserAccount> {
    return this.http.get<UserAccount>(`${USERS_URL}/${encodeURIComponent(id)}`).pipe(toProblem);
  }

  changeRole(id: string, role: Role): Observable<UserAccount> {
    const body: ChangeRoleRequest = { role };
    return this.http.put<UserAccount>(`${USERS_URL}/${encodeURIComponent(id)}/role`, body).pipe(toProblem);
  }

  deactivate(id: string): Observable<UserAccount> {
    return this.http.post<UserAccount>(`${USERS_URL}/${encodeURIComponent(id)}/deactivate`, {}).pipe(toProblem);
  }

  reactivate(id: string): Observable<UserAccount> {
    return this.http.post<UserAccount>(`${USERS_URL}/${encodeURIComponent(id)}/reactivate`, {}).pipe(toProblem);
  }

  resetPassword(id: string, temporaryPassword: string): Observable<UserAccount> {
    const body: ResetPasswordRequest = { temporaryPassword };
    return this.http.post<UserAccount>(`${USERS_URL}/${encodeURIComponent(id)}/password-reset`, body).pipe(toProblem);
  }

  getHistory(id: string): Observable<UserHistoryResponse> {
    return this.http.get<UserHistoryResponse>(`${USERS_URL}/${encodeURIComponent(id)}/history`).pipe(toProblem);
  }
}
