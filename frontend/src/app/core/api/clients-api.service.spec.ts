// T025: ClientsApiService contra contracts/openapi.yaml (rutas /api/v1/...).
// Contrato para el implementer (T026), archivo core/api/clients-api.service.ts:
//   @Injectable({ providedIn: 'root' }) export class ClientsApiService {
//     create(body: ClientCreate): Observable<ClientDetail>        // POST /api/v1/clients
//     getById(clientId: string): Observable<ClientDetail>         // GET  /api/v1/clients/{clientId}
//     search(q: string): Observable<ClientSearchResponse>         // GET  /api/v1/clients/search?q=...
//   }
// Errores: si el cuerpo de la respuesta es un Problem (isProblem), el observable falla con ESE Problem
// (tipado, no con el HttpErrorResponse). Si no hay Problem (por ejemplo, fallo de red con status 0),
// falla con el HttpErrorResponse original para que la pantalla pueda ofrecer "Reintentar".
//
// T076 (PR3, US4), métodos nuevos para el implementer (T077):
//     update(clientId: string, body: ClientUpdate): Observable<ClientDetail>   // PATCH /api/v1/clients/{clientId}
//   El cuerpo se envía tal cual (version obligatoria, solo los campos que cambian, reason opcional); el id va con
//   encodeURIComponent. Errores igual que arriba: 409 VERSION_CONFLICT llega como el Problem con `current`.
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ClientCreate, ClientDetail, ClientSearchResponse, ClientUpdate, Problem } from './api.models';
import { ClientsApiService } from './clients-api.service';

const CLIENT_ID = '7d1f0c1e-3b8a-4a52-9a43-2f1d8e0b6c11';
const EXISTING_ID = '0b9e7a51-6a0c-4f0e-8d1b-5c2a9e3f4d22';

const CREATE_BODY: ClientCreate = {
  clientType: 'natural',
  documentType: 'cedula',
  documentNumber: '171003406-5',
  firstNames: 'José Andrés',
  lastNames: 'Núñez',
  phone: '+593 99 123 4567',
  email: null,
};

const DETAIL: ClientDetail = {
  id: CLIENT_ID,
  clientType: 'natural',
  documentType: 'cedula',
  documentNumber: '1710034065',
  displayName: 'José Andrés Núñez',
  firstNames: 'José Andrés',
  lastNames: 'Núñez',
  businessName: null,
  phone: '+593991234567',
  email: null,
  version: 1,
  vehicles: [],
  createdAt: '2026-10-21T15:00:00.000Z',
  updatedAt: '2026-10-21T15:00:00.000Z',
  updatedBy: '11111111-1111-4111-8111-111111111111',
  updatedByName: 'Asesor Uno',
};

const SEARCH: ClientSearchResponse = {
  items: [
    {
      id: CLIENT_ID,
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: '1710034065',
      displayName: 'José Andrés Núñez',
      phone: '+593991234567',
      email: null,
    },
  ],
  hasMore: false,
};

function problem(status: number, code: Problem['code'], extra: Partial<Problem> = {}): Problem {
  return { type: 'about:blank', title: 'Error', status, code, ...extra };
}

const PROBLEM_HEADERS = { 'Content-Type': 'application/problem+json' };

describe('ClientsApiService (T025)', () => {
  let service: ClientsApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ClientsApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('create', () => {
    it('[US2-AC1] hace POST /api/v1/clients con el cuerpo ClientCreate y devuelve el ClientDetail (201)', () => {
      let result: ClientDetail | undefined;
      service.create(CREATE_BODY).subscribe((detail: ClientDetail) => (result = detail));

      const req = httpMock.expectOne('/api/v1/clients');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(CREATE_BODY);
      req.flush(DETAIL, { status: 201, statusText: 'Created', headers: { Location: `/api/v1/clients/${CLIENT_ID}` } });

      expect(result).toEqual(DETAIL);
    });

    it('[US2-AC10] no añade tenantId al cuerpo ni la cabecera X-Tenant-Id', () => {
      service.create(CREATE_BODY).subscribe();

      const req = httpMock.expectOne('/api/v1/clients');
      expect(Object.keys(req.request.body as object)).not.toContain('tenantId');
      expect(Object.keys(req.request.body as object)).not.toContain('tenant_id');
      expect(req.request.headers.has('X-Tenant-Id')).toBe(false);
      req.flush(DETAIL, { status: 201, statusText: 'Created' });
    });

    it('[US2-AC4][US2-AC7] un 400 VALIDATION_ERROR se propaga como el Problem tipado con errors[]', () => {
      const body = problem(400, 'VALIDATION_ERROR', {
        errors: [
          { field: 'documentNumber', code: 'INVALID_CEDULA', message: 'x' },
          { field: 'email', code: 'INVALID_EMAIL', message: 'x' },
        ],
      });
      let received: unknown;
      service.create(CREATE_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne('/api/v1/clients').flush(body, { status: 400, statusText: 'Bad Request', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
      expect(received).not.toBeInstanceOf(HttpErrorResponse);
    });

    it('[US2-AC6] un 409 DOCUMENT_ALREADY_EXISTS se propaga como Problem con existingId', () => {
      const body = problem(409, 'DOCUMENT_ALREADY_EXISTS', { existingId: EXISTING_ID });
      let received: Problem | undefined;
      service.create(CREATE_BODY).subscribe({ error: (err: Problem) => (received = err) });

      httpMock.expectOne('/api/v1/clients').flush(body, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });

      expect(received?.code).toBe('DOCUMENT_ALREADY_EXISTS');
      expect(received?.existingId).toBe(EXISTING_ID);
      expect(received?.status).toBe(409);
    });

    it('[edge case conexión inestable] un fallo de red (status 0) se propaga como HttpErrorResponse con status 0', () => {
      let received: unknown;
      service.create(CREATE_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne('/api/v1/clients').error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

      expect(received).toBeInstanceOf(HttpErrorResponse);
      expect((received as HttpErrorResponse).status).toBe(0);
    });
  });

  describe('getById', () => {
    it('[US2-AC1] hace GET /api/v1/clients/{clientId} y devuelve el ClientDetail con vehicles', () => {
      let result: ClientDetail | undefined;
      service.getById(CLIENT_ID).subscribe((detail: ClientDetail) => (result = detail));

      const req = httpMock.expectOne(`/api/v1/clients/${CLIENT_ID}`);
      expect(req.request.method).toBe('GET');
      req.flush(DETAIL);

      expect(result).toEqual(DETAIL);
      expect(result?.vehicles).toEqual([]);
    });

    it('[FR-023] un 404 NOT_FOUND se propaga como el Problem tipado', () => {
      const body = problem(404, 'NOT_FOUND');
      let received: unknown;
      service.getById(CLIENT_ID).subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne(`/api/v1/clients/${CLIENT_ID}`)
        .flush(body, { status: 404, statusText: 'Not Found', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
    });
  });

  describe('search', () => {
    it('[US4-AC1] hace GET /api/v1/clients/search con el parámetro q y devuelve ClientSearchResponse', () => {
      let result: ClientSearchResponse | undefined;
      service.search('171003406-5').subscribe((response: ClientSearchResponse) => (result = response));

      const req = httpMock.expectOne(
        (r) => r.url === '/api/v1/clients/search' && r.params.get('q') === '171003406-5',
      );
      expect(req.request.method).toBe('GET');
      req.flush(SEARCH);

      expect(result).toEqual(SEARCH);
    });

    it('[US4-AC2] codifica el término en la URL (tildes y espacios)', () => {
      service.search('José Núñez').subscribe();

      const req = httpMock.expectOne((r) => r.url === '/api/v1/clients/search');
      expect(req.request.params.get('q')).toBe('José Núñez');
      expect(req.request.urlWithParams).toContain('q=Jos%C3%A9');
      req.flush({ items: [], hasMore: false });
    });

    it('[US1-AC5] un 400 SEARCH_TERM_TOO_SHORT se propaga como el Problem tipado', () => {
      const body = problem(400, 'SEARCH_TERM_TOO_SHORT');
      let received: Problem | undefined;
      service.search('a').subscribe({ error: (err: Problem) => (received = err) });

      httpMock
        .expectOne((r) => r.url === '/api/v1/clients/search')
        .flush(body, { status: 400, statusText: 'Bad Request', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
    });
  });
});

describe('ClientsApiService.update (T076)', () => {
  let service: ClientsApiService;
  let httpMock: HttpTestingController;

  const UPDATE_BODY: ClientUpdate = { version: 1, phone: '0987654321', email: 'ana@example.com' };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ClientsApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('[US4-AC4] hace PATCH /api/v1/clients/{clientId} con el cuerpo ClientUpdate y devuelve el ClientDetail', () => {
    const updated: ClientDetail = { ...DETAIL, phone: '0987654321', email: 'ana@example.com', version: 2 };
    let result: ClientDetail | undefined;
    service.update(CLIENT_ID, UPDATE_BODY).subscribe((detail: ClientDetail) => (result = detail));

    const req = httpMock.expectOne(`/api/v1/clients/${CLIENT_ID}`);
    expect(req.request.method).toBe('PATCH');
    expect(req.request.body).toEqual(UPDATE_BODY);
    req.flush(updated);

    expect(result).toEqual(updated);
    expect(result?.version).toBe(2);
  });

  it('[US4-AC11][US4-AC15] envía documentNumber y reason cuando cambia el documento', () => {
    const body: ClientUpdate = {
      version: 3,
      documentType: 'cedula',
      documentNumber: '0912345675',
      reason: 'Corrección del documento según cédula física',
    };
    service.update(CLIENT_ID, body).subscribe();

    const req = httpMock.expectOne(`/api/v1/clients/${CLIENT_ID}`);
    expect(req.request.body).toEqual(body);
    req.flush({ ...DETAIL, documentNumber: '0912345675', version: 4 });
  });

  it('[US4-AC13] codifica el id en la URL y no añade tenantId ni X-Tenant-Id', () => {
    service.update('a/b c', UPDATE_BODY).subscribe();

    const req = httpMock.expectOne('/api/v1/clients/a%2Fb%20c');
    expect(Object.keys(req.request.body as object)).not.toContain('tenantId');
    expect(Object.keys(req.request.body as object)).not.toContain('tenant_id');
    expect(req.request.headers.has('X-Tenant-Id')).toBe(false);
    req.flush(DETAIL);
  });

  it('[US4-AC12] un 409 VERSION_CONFLICT se propaga como Problem con los datos actuales en current', () => {
    const current: ClientDetail = { ...DETAIL, phone: '0911111111', version: 2, updatedByName: 'Otra Persona' };
    const body = problem(409, 'VERSION_CONFLICT', { current });
    let received: Problem | undefined;
    service.update(CLIENT_ID, UPDATE_BODY).subscribe({ error: (err: Problem) => (received = err) });

    httpMock
      .expectOne(`/api/v1/clients/${CLIENT_ID}`)
      .flush(body, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });

    expect(received?.code).toBe('VERSION_CONFLICT');
    expect(received?.current).toEqual(current);
    expect(received).not.toBeInstanceOf(HttpErrorResponse);
  });

  it('[US4-AC15] un 400 VALIDATION_ERROR con REASON_REQUIRED en reason se propaga como el Problem tipado', () => {
    const body = problem(400, 'VALIDATION_ERROR', {
      errors: [{ field: 'reason', code: 'REASON_REQUIRED', message: 'x' }],
    });
    let received: unknown;
    service.update(CLIENT_ID, { version: 1, documentNumber: '0912345675' }).subscribe({
      error: (err: unknown) => (received = err),
    });

    httpMock
      .expectOne(`/api/v1/clients/${CLIENT_ID}`)
      .flush(body, { status: 400, statusText: 'Bad Request', headers: PROBLEM_HEADERS });

    expect(received).toEqual(body);
  });

  it('[US4-AC5] un 409 DOCUMENT_ALREADY_EXISTS se propaga como Problem con existingId', () => {
    const body = problem(409, 'DOCUMENT_ALREADY_EXISTS', { existingId: EXISTING_ID });
    let received: Problem | undefined;
    service.update(CLIENT_ID, { version: 1, documentNumber: '0912345675', reason: 'Corrección de documento' }).subscribe({
      error: (err: Problem) => (received = err),
    });

    httpMock
      .expectOne(`/api/v1/clients/${CLIENT_ID}`)
      .flush(body, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });

    expect(received?.code).toBe('DOCUMENT_ALREADY_EXISTS');
    expect(received?.existingId).toBe(EXISTING_ID);
  });

  it('[US4-AC13] un 404 NOT_FOUND (de otro taller o inexistente) se propaga como el Problem tipado', () => {
    const body = problem(404, 'NOT_FOUND');
    let received: unknown;
    service.update(CLIENT_ID, UPDATE_BODY).subscribe({ error: (err: unknown) => (received = err) });

    httpMock
      .expectOne(`/api/v1/clients/${CLIENT_ID}`)
      .flush(body, { status: 404, statusText: 'Not Found', headers: PROBLEM_HEADERS });

    expect(received).toEqual(body);
  });

  it('[edge case conexión inestable] un fallo de red se propaga como HttpErrorResponse con status 0', () => {
    let received: unknown;
    service.update(CLIENT_ID, UPDATE_BODY).subscribe({ error: (err: unknown) => (received = err) });

    httpMock.expectOne(`/api/v1/clients/${CLIENT_ID}`).error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

    expect(received).toBeInstanceOf(HttpErrorResponse);
    expect((received as HttpErrorResponse).status).toBe(0);
  });
});
