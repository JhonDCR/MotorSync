import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, type Observable } from 'rxjs';
import type {
  ChangePasswordRequest,
  CurrentSupportSessionResponse,
  DiscardTicketRequest,
  SupportLoginRequest,
  SupportSessionResponse,
  TicketDetail,
  TicketListResponse,
} from './api.models';
import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from './auth-api.service';
import { toProblem } from './problem-operator';

const SUPPORT_URL = '/api/v1/support';
const SUPPORT_AUTH_URL = `${SUPPORT_URL}/auth`;
const SUPPORT_TICKETS_URL = `${SUPPORT_URL}/tickets`;

function cookieRequestOptions(): { withCredentials: true; headers: HttpHeaders } {
  return { withCredentials: true, headers: new HttpHeaders({ [REQUESTED_WITH_HEADER]: REQUESTED_WITH_VALUE }) };
}

/**
 * Support panel endpoints of specs/003-soporte-plataforma/contracts/openapi.yaml (PR1: auth & open tickets/discard).
 * withCredentials lets the browser keep and send the HttpOnly cookie `ms_support_refresh`.
 * Passwords are sent as typed: never trimmed or transformed (FR-009).
 */
@Injectable({ providedIn: 'root' })
export class SupportApiService {
  private readonly http = inject(HttpClient);

  login(body: SupportLoginRequest): Observable<SupportSessionResponse> {
    const request: SupportLoginRequest = { email: body.email, password: body.password };
    return this.http
      .post<SupportSessionResponse>(`${SUPPORT_AUTH_URL}/login`, request, { withCredentials: true })
      .pipe(toProblem);
  }

  refresh(): Observable<SupportSessionResponse> {
    return this.http
      .post<SupportSessionResponse>(`${SUPPORT_AUTH_URL}/refresh`, null, cookieRequestOptions())
      .pipe(toProblem);
  }

  logout(): Observable<void> {
    return this.http.post(`${SUPPORT_AUTH_URL}/logout`, null, cookieRequestOptions()).pipe(
      map(() => undefined),
      toProblem,
    );
  }

  me(): Observable<CurrentSupportSessionResponse> {
    return this.http.get<CurrentSupportSessionResponse>(`${SUPPORT_AUTH_URL}/me`).pipe(toProblem);
  }

  changePassword(body: ChangePasswordRequest): Observable<SupportSessionResponse> {
    const request: ChangePasswordRequest = { currentPassword: body.currentPassword, newPassword: body.newPassword };
    return this.http.post<SupportSessionResponse>(`${SUPPORT_AUTH_URL}/password`, request).pipe(toProblem);
  }

  listOpenTickets(): Observable<TicketListResponse> {
    return this.http.get<TicketListResponse>(SUPPORT_TICKETS_URL).pipe(toProblem);
  }

  getTicket(ticketId: string): Observable<TicketDetail> {
    return this.http
      .get<TicketDetail>(`${SUPPORT_TICKETS_URL}/${encodeURIComponent(ticketId)}`)
      .pipe(toProblem);
  }

  discardTicket(ticketId: string, reasonOrRequest: string | DiscardTicketRequest): Observable<TicketDetail> {
    const reason = typeof reasonOrRequest === 'string' ? reasonOrRequest : reasonOrRequest.reason;
    const request: DiscardTicketRequest = { reason };
    return this.http
      .post<TicketDetail>(`${SUPPORT_TICKETS_URL}/${encodeURIComponent(ticketId)}/discard`, request)
      .pipe(toProblem);
  }
}
