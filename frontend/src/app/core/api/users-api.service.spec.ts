import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type {
  CreateUserRequest,
  Problem,
  UserAccount,
  UserAuditEntry,
  UserHistoryResponse,
  UserListResponse,
} from './api.models';
import { UsersApiService } from './users-api.service';

const USERS_URL = '/api/v1/users';
const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const PROBLEM_HEADERS = { 'Content-Type': 'application/problem+json' };

const MOCK_USER: UserAccount = {
  id: USER_ID,
  name: 'Carlos Mendoza',
  email: 'carlos@taller.ec',
  role: 'asesor',
  status: 'active',
  mustChangePassword: true,
  temporaryPasswordExpiresAt: '2026-10-27T12:00:00.000Z',
  createdAt: '2026-10-24T12:00:00.000Z',
  updatedAt: '2026-10-24T12:00:00.000Z',
  updatedByName: 'Admin Principal',
};

const MOCK_AUDIT_ENTRY: UserAuditEntry = {
  id: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  action: 'user.role_changed',
  actorName: 'Admin Principal',
  actorRole: 'admin',
  occurredAt: '2026-10-24T13:00:00.000Z',
  before: { role: 'asesor' },
  after: { role: 'admin' },
  ip: '127.0.0.1',
  channel: 'web',
};

function makeProblem(status: number, code: Problem['code']): Problem {
  return { type: 'about:blank', title: 'Error', status, code };
}

describe('UsersApiService (T056)', () => {
  let service: UsersApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(UsersApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('list', () => {
    it('[US4-AC1] hace GET /api/v1/users y devuelve lista de usuarios (200)', () => {
      const response: UserListResponse = { items: [MOCK_USER] };
      let result: UserListResponse | undefined;
      service.list().subscribe((res) => (result = res));

      const req = httpMock.expectOne(USERS_URL);
      expect(req.request.method).toBe('GET');
      req.flush(response);

      expect(result).toEqual(response);
    });

    it('[US4-AC16] propaga error Problem en 403 FORBIDDEN', () => {
      const prob = makeProblem(403, 'FORBIDDEN');
      let error: unknown;
      service.list().subscribe({ error: (err) => (error = err) });

      httpMock.expectOne(USERS_URL).flush(prob, { status: 403, statusText: 'Forbidden', headers: PROBLEM_HEADERS });
      expect(error).toEqual(prob);
    });
  });

  describe('create', () => {
    it('[US4-AC2] hace POST /api/v1/users con el body CreateUserRequest y devuelve UserAccount (201)', () => {
      const body: CreateUserRequest = {
        name: 'Carlos Mendoza',
        email: 'carlos@taller.ec',
        role: 'asesor',
        temporaryPassword: 'TempPassword123',
      };
      let result: UserAccount | undefined;
      service.create(body).subscribe((res) => (result = res));

      const req = httpMock.expectOne(USERS_URL);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(body);
      req.flush(MOCK_USER, { status: 201, statusText: 'Created' });

      expect(result).toEqual(MOCK_USER);
    });

    it('[US4-AC3] propaga 409 EMAIL_UNAVAILABLE como Problem tipado', () => {
      const body: CreateUserRequest = {
        name: 'Carlos Mendoza',
        email: 'carlos@taller.ec',
        role: 'asesor',
        temporaryPassword: 'TempPassword123',
      };
      const prob = makeProblem(409, 'EMAIL_UNAVAILABLE');
      let error: unknown;
      service.create(body).subscribe({ error: (err) => (error = err) });

      httpMock.expectOne(USERS_URL).flush(prob, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });
      expect(error).toEqual(prob);
    });
  });

  describe('getById', () => {
    it('[US4-AC1] hace GET /api/v1/users/:id con encodeURIComponent y devuelve UserAccount (200)', () => {
      let result: UserAccount | undefined;
      service.getById(USER_ID).subscribe((res) => (result = res));

      const req = httpMock.expectOne(`${USERS_URL}/${USER_ID}`);
      expect(req.request.method).toBe('GET');
      req.flush(MOCK_USER);

      expect(result).toEqual(MOCK_USER);
    });

    it('[US4-AC17] propaga 404 NOT_FOUND como Problem', () => {
      const prob = makeProblem(404, 'NOT_FOUND');
      let error: unknown;
      service.getById(USER_ID).subscribe({ error: (err) => (error = err) });

      httpMock
        .expectOne(`${USERS_URL}/${USER_ID}`)
        .flush(prob, { status: 404, statusText: 'Not Found', headers: PROBLEM_HEADERS });
      expect(error).toEqual(prob);
    });
  });

  describe('changeRole', () => {
    it('[US4-AC5] hace PUT /api/v1/users/:id/role con { role } y devuelve UserAccount actualizado (200)', () => {
      const updated = { ...MOCK_USER, role: 'admin' as const };
      let result: UserAccount | undefined;
      service.changeRole(USER_ID, 'admin').subscribe((res) => (result = res));

      const req = httpMock.expectOne(`${USERS_URL}/${USER_ID}/role`);
      expect(req.request.method).toBe('PUT');
      expect(req.request.body).toEqual({ role: 'admin' });
      req.flush(updated);

      expect(result).toEqual(updated);
    });

    it('[US4-AC9] propaga 409 LAST_ADMIN como Problem', () => {
      const prob = makeProblem(409, 'LAST_ADMIN');
      let error: unknown;
      service.changeRole(USER_ID, 'asesor').subscribe({ error: (err) => (error = err) });

      httpMock
        .expectOne(`${USERS_URL}/${USER_ID}/role`)
        .flush(prob, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });
      expect(error).toEqual(prob);
    });
  });

  describe('deactivate', () => {
    it('[US4-AC6] hace POST /api/v1/users/:id/deactivate con {} y devuelve UserAccount (200)', () => {
      const updated = { ...MOCK_USER, status: 'inactive' as const };
      let result: UserAccount | undefined;
      service.deactivate(USER_ID).subscribe((res) => (result = res));

      const req = httpMock.expectOne(`${USERS_URL}/${USER_ID}/deactivate`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({});
      req.flush(updated);

      expect(result).toEqual(updated);
    });

    it('[US4-AC9] propaga 409 LAST_ADMIN como Problem', () => {
      const prob = makeProblem(409, 'LAST_ADMIN');
      let error: unknown;
      service.deactivate(USER_ID).subscribe({ error: (err) => (error = err) });

      httpMock
        .expectOne(`${USERS_URL}/${USER_ID}/deactivate`)
        .flush(prob, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });
      expect(error).toEqual(prob);
    });
  });

  describe('reactivate', () => {
    it('[US4-AC7] hace POST /api/v1/users/:id/reactivate con {} y devuelve UserAccount (200)', () => {
      let result: UserAccount | undefined;
      service.reactivate(USER_ID).subscribe((res) => (result = res));

      const req = httpMock.expectOne(`${USERS_URL}/${USER_ID}/reactivate`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({});
      req.flush(MOCK_USER);

      expect(result).toEqual(MOCK_USER);
    });
  });

  describe('resetPassword', () => {
    it('[US4-AC21] hace POST /api/v1/users/:id/password-reset con { temporaryPassword } y devuelve UserAccount (200)', () => {
      let result: UserAccount | undefined;
      service.resetPassword(USER_ID, 'NewTempPass99').subscribe((res) => (result = res));

      const req = httpMock.expectOne(`${USERS_URL}/${USER_ID}/password-reset`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ temporaryPassword: 'NewTempPass99' });
      req.flush(MOCK_USER);

      expect(result).toEqual(MOCK_USER);
    });

    it('[US4-AC23] propaga 409 SELF_RESET_NOT_ALLOWED como Problem', () => {
      const prob = makeProblem(409, 'SELF_RESET_NOT_ALLOWED');
      let error: unknown;
      service.resetPassword(USER_ID, 'NewTempPass99').subscribe({ error: (err) => (error = err) });

      httpMock
        .expectOne(`${USERS_URL}/${USER_ID}/password-reset`)
        .flush(prob, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });
      expect(error).toEqual(prob);
    });
  });

  describe('getHistory', () => {
    it('[US4-AC20] hace GET /api/v1/users/:id/history y devuelve lista de auditorías (200)', () => {
      const response: UserHistoryResponse = { items: [MOCK_AUDIT_ENTRY] };
      let result: UserHistoryResponse | undefined;
      service.getHistory(USER_ID).subscribe((res) => (result = res));

      const req = httpMock.expectOne(`${USERS_URL}/${USER_ID}/history`);
      expect(req.request.method).toBe('GET');
      req.flush(response);

      expect(result).toEqual(response);
    });
  });

  describe('errores de red', () => {
    it('[FR-015] falla con HttpErrorResponse si no es un Problem', () => {
      let error: unknown;
      service.list().subscribe({ error: (err) => (error = err) });

      const req = httpMock.expectOne(USERS_URL);
      req.error(new ProgressEvent('error'));

      expect(error).toBeInstanceOf(HttpErrorResponse);
    });
  });
});
