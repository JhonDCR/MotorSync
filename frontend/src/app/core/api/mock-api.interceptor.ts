import {
  HttpErrorResponse,
  HttpEvent,
  HttpHeaders,
  HttpInterceptorFn,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { mergeMap, Observable, throwError, timer, of } from 'rxjs';
import { decodeSessionToken } from '../auth/current-session';
import {
  MockApiStore,
  mockActor,
  mockProblem,
  type MockActor,
  type MockResult,
} from './mock-api.store';
import { REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE } from './auth-api.service';
import { MockAuthStore } from './mock-auth.store';
import { MockBudgetStore } from './mock-budget.store';
import { MockCheckinStore } from './mock-checkin.store';
import { MockSupportStore } from './mock-support.store';
import { USE_MOCK_API } from './use-mock-api';

// API simulada en memoria (research R8). Solo actúa con USE_MOCK_API en true y en rutas /api/.
// Respeta contracts/openapi.yaml: éxitos con el status del contrato y errores como HttpErrorResponse
// cuyo `error` es el Problem (application/problem+json).

/** Simulated latency, so that loading states are visible in `ng serve --configuration mock`. */
const MOCK_LATENCY_MS = 150;
const API_PREFIX = '/api/';
const CLIENTS_PATH = '/api/v1/clients';
const CLIENT_BY_ID = /^\/api\/v1\/clients\/([^/]+)$/;
const VEHICLES_PATH = '/api/v1/vehicles';
const VEHICLE_BY_ID = /^\/api\/v1\/vehicles\/([^/]+)$/;
const VEHICLE_TRANSFERS = /^\/api\/v1\/vehicles\/([^/]+)\/ownership-transfers$/;
const VEHICLE_HISTORY = /^\/api\/v1\/vehicles\/([^/]+)\/ownership-history$/;
const VEHICLE_CHECKINS = /^\/api\/v1\/vehicles\/([^/]+)\/checkins$/;
const CHECKIN_BY_ID = /^\/api\/v1\/checkins\/([^/]+)$/;
const CHECKIN_IMAGE = /^\/api\/v1\/checkins\/([^/]+)\/images\/([^/]+)$/;
const CHECKIN_BUDGETS = /^\/api\/v1\/checkins\/([^/]+)\/budgets$/;
const VEHICLE_BUDGETS = /^\/api\/v1\/vehicles\/([^/]+)\/budgets$/;
const BUDGET_BY_ID = /^\/api\/v1\/budgets\/([^/]+)$/;
const BUDGET_TRANSITION = /^\/api\/v1\/budgets\/([^/]+)\/(send|approve|reject)$/;
const AUTH_REGISTER_PATH = '/api/v1/auth/register';
const AUTH_LOGIN_PATH = '/api/v1/auth/login';
const AUTH_REFRESH_PATH = '/api/v1/auth/refresh';
const AUTH_LOGOUT_PATH = '/api/v1/auth/logout';
const AUTH_ME_PATH = '/api/v1/auth/me';
const AUTH_PASSWORD_PATH = '/api/v1/auth/password';
const AUTH_FORGOT_PASSWORD_PATH = '/api/v1/auth/forgot-password';
const SUPPORT_PREFIX = '/api/v1/support';
const SUPPORT_LOGIN_PATH = '/api/v1/support/auth/login';
const SUPPORT_REFRESH_PATH = '/api/v1/support/auth/refresh';
const SUPPORT_LOGOUT_PATH = '/api/v1/support/auth/logout';
const SUPPORT_ME_PATH = '/api/v1/support/auth/me';
const SUPPORT_PASSWORD_PATH = '/api/v1/support/auth/password';
const SUPPORT_TICKETS_PATH = '/api/v1/support/tickets';
const SUPPORT_TICKET_BY_ID = /^\/api\/v1\/support\/tickets\/([^/]+)$/;
const SUPPORT_TICKET_DISCARD = /^\/api\/v1\/support\/tickets\/([^/]+)\/discard$/;
const SUPPORT_TICKET_TEMP_PASSWORD = /^\/api\/v1\/support\/tickets\/([^/]+)\/temporary-password$/;
const SUPPORT_WORKSHOPS_PATH = '/api/v1/support/workshops';
const SUPPORT_WORKSHOP_ACCOUNTS = /^\/api\/v1\/support\/workshops\/([^/]+)\/accounts$/;
const SUPPORT_ACCESS_LOG_PATH = '/api/v1/support/access-log';
const USERS_PATH = '/api/v1/users';
const USER_BY_ID = /^\/api\/v1\/users\/([^/]+)$/;
const USER_ROLE = /^\/api\/v1\/users\/([^/]+)\/role$/;
const USER_DEACTIVATE = /^\/api\/v1\/users\/([^/]+)\/deactivate$/;
const USER_REACTIVATE = /^\/api\/v1\/users\/([^/]+)\/reactivate$/;
const USER_PASSWORD_RESET = /^\/api\/v1\/users\/([^/]+)\/password-reset$/;
const USER_HISTORY = /^\/api\/v1\/users\/([^/]+)\/history$/;
const BEARER = /^Bearer\s+(\S+)$/i;

function bearerToken(req: HttpRequest<unknown>): string | null {
  return BEARER.exec(req.headers.get('Authorization')?.trim() ?? '')?.[1] ?? null;
}

/** R11: refresh and logout only with `X-Requested-With: motorsync` (CSRF). */
function hasCsrfHeader(req: HttpRequest<unknown>): boolean {
  return req.headers.get(REQUESTED_WITH_HEADER) === REQUESTED_WITH_VALUE;
}

/** Role and name of the request token (signature not verified); without a readable token, an asesor. */
function actorOf(req: HttpRequest<unknown>): MockActor {
  return mockActor(decodeSessionToken(bearerToken(req)));
}

/** Query parameter from HttpParams or, if absent, from a query written in the URL itself. */
function queryParam(req: HttpRequest<unknown>, name: string): string | null {
  const query = req.urlWithParams.split('#')[0].split('?')[1] ?? '';
  return req.params.get(name) ?? new URLSearchParams(query).get(name);
}

/** Path of the request URL, without origin, query or fragment. */
function pathOf(url: string): string {
  const withoutOrigin = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  return withoutOrigin.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
}

function respond(
  req: HttpRequest<unknown>,
  result: MockResult<unknown>,
  location?: string,
): Observable<HttpEvent<unknown>> {
  if (!result.ok) {
    return throwError(
      () =>
        new HttpErrorResponse({
          error: result.problem,
          headers: new HttpHeaders({ 'Content-Type': 'application/problem+json' }),
          status: result.problem.status,
          statusText: result.problem.title,
          url: req.urlWithParams,
        }),
    );
  }
  let headers = new HttpHeaders({ 'Content-Type': 'application/json' });
  if (location !== undefined) {
    headers = headers.set('Location', location);
  }
  return of(
    new HttpResponse({ body: result.body, headers, status: result.status, url: req.urlWithParams }),
  );
}

function route(
  req: HttpRequest<unknown>,
  store: MockApiStore,
  auth: MockAuthStore,
  support: MockSupportStore,
  checkins: MockCheckinStore,
  budgets: MockBudgetStore,
): Observable<HttpEvent<unknown>> {
  const path = pathOf(req.url);

  // Public auth routes of contracts 002 and 003 (no token needed).
  if (path === AUTH_FORGOT_PASSWORD_PATH && req.method === 'POST') {
    const origin = req.headers.get('X-Forwarded-For')?.trim() || '127.0.0.1';
    return respond(req, support.forgotPassword(req.body, origin));
  }
  if (path === AUTH_REGISTER_PATH && req.method === 'POST') {
    return respond(req, auth.register(req.body));
  }
  if (path === AUTH_LOGIN_PATH && req.method === 'POST') {
    return respond(req, auth.login(req.body));
  }
  if (path === AUTH_REFRESH_PATH && req.method === 'POST') {
    return respond(req, auth.refresh(hasCsrfHeader(req)));
  }
  if (path === AUTH_LOGOUT_PATH && req.method === 'POST') {
    return respond(req, auth.logout(hasCsrfHeader(req)));
  }
  if (path === AUTH_ME_PATH && req.method === 'GET') {
    return respond(req, auth.me(bearerToken(req)));
  }
  if (path === AUTH_PASSWORD_PATH && req.method === 'POST') {
    return respond(req, auth.changePassword(bearerToken(req), req.body));
  }

  // Support panel routes of contract 003 (PR1).
  if (path === SUPPORT_LOGIN_PATH && req.method === 'POST') {
    return respond(req, support.login(req.body));
  }
  if (path === SUPPORT_REFRESH_PATH && req.method === 'POST') {
    return respond(req, support.refresh(hasCsrfHeader(req)));
  }
  if (path === SUPPORT_LOGOUT_PATH && req.method === 'POST') {
    return respond(req, support.logout(hasCsrfHeader(req)));
  }
  if (path === SUPPORT_ME_PATH && req.method === 'GET') {
    return respond(req, support.me(bearerToken(req)));
  }
  if (path === SUPPORT_PASSWORD_PATH && req.method === 'POST') {
    return respond(req, support.changePassword(bearerToken(req), req.body));
  }
  if (path === SUPPORT_TICKETS_PATH && req.method === 'GET') {
    return respond(req, support.listOpenTickets(bearerToken(req)));
  }
  const supportTicketDiscard = SUPPORT_TICKET_DISCARD.exec(path);
  if (supportTicketDiscard !== null && req.method === 'POST') {
    return respond(
      req,
      support.discardTicket(
        bearerToken(req),
        decodeURIComponent(supportTicketDiscard[1]),
        req.body,
      ),
    );
  }
  const supportTicketTempPassword = SUPPORT_TICKET_TEMP_PASSWORD.exec(path);
  if (supportTicketTempPassword !== null && req.method === 'POST') {
    return respond(
      req,
      support.generateTemporaryPassword(
        bearerToken(req),
        decodeURIComponent(supportTicketTempPassword[1]),
        req.body,
      ),
    );
  }
  const supportTicketById = SUPPORT_TICKET_BY_ID.exec(path);
  if (supportTicketById !== null && req.method === 'GET') {
    return respond(
      req,
      support.getTicket(bearerToken(req), decodeURIComponent(supportTicketById[1])),
    );
  }
  // Support workshops and access log of contract 003 (PR3): read-only, 50 per page.
  if (path === SUPPORT_WORKSHOPS_PATH && req.method === 'GET') {
    return respond(
      req,
      support.listWorkshops(bearerToken(req), {
        q: queryParam(req, 'q'),
        page: queryParam(req, 'page'),
      }),
    );
  }
  const supportWorkshopAccounts = SUPPORT_WORKSHOP_ACCOUNTS.exec(path);
  if (supportWorkshopAccounts !== null && req.method === 'GET') {
    return respond(
      req,
      support.listWorkshopAccounts(
        bearerToken(req),
        decodeURIComponent(supportWorkshopAccounts[1]),
      ),
    );
  }
  if (path === SUPPORT_ACCESS_LOG_PATH && req.method === 'GET') {
    return respond(
      req,
      support.listAccessLog(bearerToken(req), {
        workshopId: queryParam(req, 'workshopId'),
        agentId: queryParam(req, 'agentId'),
        page: queryParam(req, 'page'),
      }),
    );
  }
  if (path === SUPPORT_PREFIX || path.startsWith(`${SUPPORT_PREFIX}/`)) {
    const authCheck = support.authenticateSupport(bearerToken(req), false);
    if (!authCheck.ok) {
      return respond(req, authCheck);
    }
    return respond(req, { ok: false, problem: mockProblem(404, 'NOT_FOUND') });
  }

  // Users routes of contract 002 (US4 - solo administrador)
  if (path === USERS_PATH && req.method === 'GET') {
    return respond(req, auth.listUsers(bearerToken(req)));
  }
  if (path === USERS_PATH && req.method === 'POST') {
    const result = auth.createUser(bearerToken(req), req.body);
    return respond(req, result, result.ok ? `${USERS_PATH}/${result.body.id}` : undefined);
  }
  const userRole = USER_ROLE.exec(path);
  if (userRole !== null && req.method === 'PUT') {
    return respond(
      req,
      auth.changeUserRole(bearerToken(req), decodeURIComponent(userRole[1]), req.body),
    );
  }
  const userDeactivate = USER_DEACTIVATE.exec(path);
  if (userDeactivate !== null && req.method === 'POST') {
    return respond(
      req,
      auth.deactivateUser(bearerToken(req), decodeURIComponent(userDeactivate[1])),
    );
  }
  const userReactivate = USER_REACTIVATE.exec(path);
  if (userReactivate !== null && req.method === 'POST') {
    return respond(
      req,
      auth.reactivateUser(bearerToken(req), decodeURIComponent(userReactivate[1])),
    );
  }
  const userPasswordReset = USER_PASSWORD_RESET.exec(path);
  if (userPasswordReset !== null && req.method === 'POST') {
    return respond(
      req,
      auth.resetUserPassword(bearerToken(req), decodeURIComponent(userPasswordReset[1]), req.body),
    );
  }
  const userHistory = USER_HISTORY.exec(path);
  if (userHistory !== null && req.method === 'GET') {
    return respond(req, auth.getUserHistory(bearerToken(req), decodeURIComponent(userHistory[1])));
  }
  const userById = USER_BY_ID.exec(path);
  if (userById !== null && req.method === 'GET') {
    return respond(req, auth.getUser(bearerToken(req), decodeURIComponent(userById[1])));
  }

  // Workshop routes (001): a token with a session must be live and without a pending temporary password.
  const blocked = auth.workshopAccessProblem(bearerToken(req));
  if (blocked !== null) {
    return respond(req, { ok: false, problem: blocked });
  }

  // Check-ins of contract 004 (immutable: only GET and POST).
  const vehicleCheckins = VEHICLE_CHECKINS.exec(path);
  if (vehicleCheckins !== null && req.method === 'POST') {
    return respond(
      req,
      checkins.create(decodeURIComponent(vehicleCheckins[1]), req.body, actorOf(req)),
    );
  }
  if (vehicleCheckins !== null && req.method === 'GET') {
    return respond(req, checkins.list(decodeURIComponent(vehicleCheckins[1])));
  }
  const checkinById = CHECKIN_BY_ID.exec(path);
  if (checkinById !== null && req.method === 'GET') {
    return respond(req, checkins.get(decodeURIComponent(checkinById[1])));
  }
  // Budgets of contract 005.
  const checkinBudgets = CHECKIN_BUDGETS.exec(path);
  if (checkinBudgets !== null && req.method === 'POST') {
    return respond(
      req,
      budgets.create(decodeURIComponent(checkinBudgets[1]), req.body, actorOf(req)),
    );
  }
  if (checkinBudgets !== null && req.method === 'GET') {
    return respond(req, budgets.listByCheckin(decodeURIComponent(checkinBudgets[1])));
  }
  const vehicleBudgets = VEHICLE_BUDGETS.exec(path);
  if (vehicleBudgets !== null && req.method === 'GET') {
    return respond(req, budgets.listByVehicle(decodeURIComponent(vehicleBudgets[1])));
  }
  const budgetById = BUDGET_BY_ID.exec(path);
  if (budgetById !== null && req.method === 'GET') {
    return respond(req, budgets.get(decodeURIComponent(budgetById[1])));
  }
  if (budgetById !== null && req.method === 'PUT') {
    return respond(req, budgets.update(decodeURIComponent(budgetById[1]), req.body));
  }
  const budgetTransition = BUDGET_TRANSITION.exec(path);
  if (budgetTransition !== null && req.method === 'POST') {
    const action =
      budgetTransition[2] === 'send'
        ? 'send'
        : budgetTransition[2] === 'approve'
          ? 'approve'
          : 'reject';
    return respond(
      req,
      budgets.transition(decodeURIComponent(budgetTransition[1]), action, actorOf(req)),
    );
  }
  const checkinImage = CHECKIN_IMAGE.exec(path);
  if (checkinImage !== null && req.method === 'GET') {
    const image = checkins.image(
      decodeURIComponent(checkinImage[1]),
      decodeURIComponent(checkinImage[2]),
    );
    if (!image.ok) {
      return respond(req, image);
    }
    const headers = new HttpHeaders({ 'Content-Type': image.body.type });
    return of(new HttpResponse({ body: image.body, headers, status: 200, url: req.urlWithParams }));
  }

  if (path === CLIENTS_PATH && req.method === 'POST') {
    const result = store.createClient(req.body);
    return respond(req, result, result.ok ? `${CLIENTS_PATH}/${result.body.id}` : undefined);
  }
  if (path === `${CLIENTS_PATH}/search` && req.method === 'GET') {
    return respond(req, store.searchClients(queryParam(req, 'q')));
  }
  const byId = CLIENT_BY_ID.exec(path);
  if (byId !== null && req.method === 'GET') {
    return respond(req, store.getClient(decodeURIComponent(byId[1])));
  }
  if (byId !== null && req.method === 'PATCH') {
    return respond(req, store.updateClient(decodeURIComponent(byId[1]), req.body, actorOf(req)));
  }
  if (path === VEHICLES_PATH && req.method === 'POST') {
    const result = store.createVehicle(req.body);
    return respond(req, result, result.ok ? `${VEHICLES_PATH}/${result.body.id}` : undefined);
  }
  // Before VEHICLE_BY_ID, otherwise "search" would be read as a vehicle id.
  if (path === `${VEHICLES_PATH}/search` && req.method === 'GET') {
    return respond(req, store.searchVehicles(queryParam(req, 'q')));
  }
  const vehicleById = VEHICLE_BY_ID.exec(path);
  if (vehicleById !== null && req.method === 'GET') {
    return respond(req, store.getVehicle(decodeURIComponent(vehicleById[1])));
  }
  if (vehicleById !== null && req.method === 'PATCH') {
    return respond(
      req,
      store.updateVehicle(decodeURIComponent(vehicleById[1]), req.body, actorOf(req)),
    );
  }
  const transfers = VEHICLE_TRANSFERS.exec(path);
  if (transfers !== null && req.method === 'POST') {
    return respond(
      req,
      store.transferOwnership(decodeURIComponent(transfers[1]), req.body, actorOf(req)),
    );
  }
  const history = VEHICLE_HISTORY.exec(path);
  if (history !== null && req.method === 'GET') {
    return respond(req, store.getOwnershipHistory(decodeURIComponent(history[1])));
  }
  return respond(req, { ok: false, problem: mockProblem(404, 'NOT_FOUND') });
}

export const mockApiInterceptor: HttpInterceptorFn = (req, next) => {
  if (inject(USE_MOCK_API) !== true || !`${pathOf(req.url)}/`.startsWith(API_PREFIX)) {
    return next(req);
  }
  const store = inject(MockApiStore);
  const auth = inject(MockAuthStore);
  const support = inject(MockSupportStore);
  const checkins = inject(MockCheckinStore);
  const budgets = inject(MockBudgetStore);
  return timer(MOCK_LATENCY_MS).pipe(
    mergeMap(() => route(req, store, auth, support, checkins, budgets)),
  );
};
