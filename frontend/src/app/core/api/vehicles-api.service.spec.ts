// T047: VehiclesApiService contra contracts/openapi.yaml (rutas /api/v1/...).
// Contrato para el implementer (T048), archivo core/api/vehicles-api.service.ts:
//   @Injectable({ providedIn: 'root' }) export class VehiclesApiService {
//     create(body: VehicleCreate): Observable<VehicleDetail>          // POST /api/v1/vehicles
//     getById(vehicleId: string): Observable<VehicleDetail>           // GET  /api/v1/vehicles/{vehicleId}
//     search(q: string): Observable<VehicleSearchResponse>            // GET  /api/v1/vehicles/search?q=...
//   }
// Errores: igual que ClientsApiService. Si el cuerpo de la respuesta es un Problem (isProblem), el observable
// falla con ESE Problem (tipado, no con el HttpErrorResponse). Si no hay Problem (por ejemplo, fallo de red con
// status 0), falla con el HttpErrorResponse original para que la pantalla pueda ofrecer "Reintentar".
// (El operador toProblem de clients-api.service.ts puede extraerse a un módulo común y reutilizarse.)
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Problem, VehicleCreate, VehicleDetail, VehicleSearchResponse } from './api.models';
import { VehiclesApiService } from './vehicles-api.service';

const VEHICLE_ID = 'b2222222-2222-4222-8222-222222222222';
const EXISTING_ID = 'c3333333-3333-4333-8333-333333333333';
const OWNER_ID = '7d1f0c1e-3b8a-4a52-9a43-2f1d8e0b6c11';

const OWNER = {
  id: OWNER_ID,
  clientType: 'natural' as const,
  documentType: 'cedula' as const,
  documentNumber: '1710034065',
  displayName: 'Ana Pérez',
  phone: '0991234567',
  email: 'ana.perez@example.com',
};

const CREATE_BODY: VehicleCreate = {
  ownerClientId: OWNER_ID,
  plate: 'pba-1234',
  vin: null,
  brand: 'Toyota',
  model: 'Hilux',
  year: 2022,
  color: 'Blanco',
  bodyType: 'pickup',
  initialMileage: 45000,
};

const DETAIL: VehicleDetail = {
  id: VEHICLE_ID,
  plate: 'PBA1234',
  brand: 'Toyota',
  model: 'Hilux',
  year: 2022,
  vin: null,
  color: 'Blanco',
  bodyType: 'pickup',
  initialMileage: 45000,
  version: 1,
  owner: OWNER,
  createdAt: '2026-10-21T15:00:00.000Z',
  updatedAt: '2026-10-21T15:00:00.000Z',
  updatedBy: '11111111-1111-4111-8111-111111111111',
  updatedByName: 'Asesor Uno',
};

const SEARCH: VehicleSearchResponse = {
  items: [
    {
      id: VEHICLE_ID,
      plate: 'PBA1234',
      brand: 'Toyota',
      model: 'Hilux',
      year: 2022,
      vin: null,
      color: 'Blanco',
      bodyType: 'pickup',
      initialMileage: 45000,
      owner: OWNER,
    },
  ],
  hasMore: false,
};

function problem(status: number, code: Problem['code'], extra: Partial<Problem> = {}): Problem {
  return { type: 'about:blank', title: 'Error', status, code, ...extra };
}

const PROBLEM_HEADERS = { 'Content-Type': 'application/problem+json' };

describe('VehiclesApiService (T047)', () => {
  let service: VehiclesApiService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(VehiclesApiService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('create', () => {
    it('[US3-AC1] hace POST /api/v1/vehicles con el cuerpo VehicleCreate y devuelve el VehicleDetail (201)', () => {
      let result: VehicleDetail | undefined;
      service.create(CREATE_BODY).subscribe((detail: VehicleDetail) => (result = detail));

      const req = httpMock.expectOne('/api/v1/vehicles');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(CREATE_BODY);
      req.flush(DETAIL, { status: 201, statusText: 'Created', headers: { Location: `/api/v1/vehicles/${VEHICLE_ID}` } });

      expect(result).toEqual(DETAIL);
      expect(result?.owner.id).toBe(OWNER_ID);
    });

    it('[US3-AC2] devuelve la placa normalizada tal como la responde el servidor', () => {
      let result: VehicleDetail | undefined;
      service.create(CREATE_BODY).subscribe((detail: VehicleDetail) => (result = detail));

      httpMock.expectOne('/api/v1/vehicles').flush(DETAIL, { status: 201, statusText: 'Created' });

      expect(result?.plate).toBe('PBA1234');
    });

    it('[US3-AC10] no añade tenantId al cuerpo ni la cabecera X-Tenant-Id', () => {
      service.create(CREATE_BODY).subscribe();

      const req = httpMock.expectOne('/api/v1/vehicles');
      expect(Object.keys(req.request.body as object)).not.toContain('tenantId');
      expect(Object.keys(req.request.body as object)).not.toContain('tenant_id');
      expect(req.request.headers.has('X-Tenant-Id')).toBe(false);
      req.flush(DETAIL, { status: 201, statusText: 'Created' });
    });

    it('[US3-AC4][US3-AC7][US3-AC12] un 400 VALIDATION_ERROR se propaga como el Problem tipado con errors[]', () => {
      const body = problem(400, 'VALIDATION_ERROR', {
        errors: [
          { field: 'plate', code: 'INVALID_PLATE', message: 'x' },
          { field: 'vin', code: 'INVALID_VIN', message: 'x' },
          { field: 'year', code: 'INVALID_YEAR', message: 'x' },
          { field: 'initialMileage', code: 'INVALID_MILEAGE', message: 'x' },
        ],
      });
      let received: unknown;
      service.create(CREATE_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne('/api/v1/vehicles').flush(body, { status: 400, statusText: 'Bad Request', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
      expect(received).not.toBeInstanceOf(HttpErrorResponse);
    });

    it('[US3-AC3] un 409 PLATE_ALREADY_EXISTS se propaga como Problem con existingId', () => {
      const body = problem(409, 'PLATE_ALREADY_EXISTS', { existingId: EXISTING_ID });
      let received: Problem | undefined;
      service.create(CREATE_BODY).subscribe({ error: (err: Problem) => (received = err) });

      httpMock.expectOne('/api/v1/vehicles').flush(body, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });

      expect(received?.code).toBe('PLATE_ALREADY_EXISTS');
      expect(received?.existingId).toBe(EXISTING_ID);
      expect(received?.status).toBe(409);
    });

    it('[US3-AC5] un 409 VIN_ALREADY_EXISTS se propaga como Problem con existingId', () => {
      const body = problem(409, 'VIN_ALREADY_EXISTS', { existingId: EXISTING_ID });
      let received: Problem | undefined;
      service.create({ ...CREATE_BODY, vin: '1HGCM82633A004352' }).subscribe({ error: (err: Problem) => (received = err) });

      httpMock.expectOne('/api/v1/vehicles').flush(body, { status: 409, statusText: 'Conflict', headers: PROBLEM_HEADERS });

      expect(received?.code).toBe('VIN_ALREADY_EXISTS');
      expect(received?.existingId).toBe(EXISTING_ID);
    });

    it('[US3-AC11] un 404 CLIENT_NOT_FOUND se propaga como el Problem tipado', () => {
      const body = problem(404, 'CLIENT_NOT_FOUND');
      let received: unknown;
      service.create(CREATE_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne('/api/v1/vehicles').flush(body, { status: 404, statusText: 'Not Found', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
    });

    it('[edge case conexión inestable] un fallo de red (status 0) se propaga como HttpErrorResponse con status 0', () => {
      let received: unknown;
      service.create(CREATE_BODY).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne('/api/v1/vehicles').error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

      expect(received).toBeInstanceOf(HttpErrorResponse);
      expect((received as HttpErrorResponse).status).toBe(0);
    });
  });

  describe('getById', () => {
    it('[US3-AC1] hace GET /api/v1/vehicles/{vehicleId} y devuelve el VehicleDetail con su propietario', () => {
      let result: VehicleDetail | undefined;
      service.getById(VEHICLE_ID).subscribe((detail: VehicleDetail) => (result = detail));

      const req = httpMock.expectOne(`/api/v1/vehicles/${VEHICLE_ID}`);
      expect(req.request.method).toBe('GET');
      req.flush(DETAIL);

      expect(result).toEqual(DETAIL);
      expect(result?.owner.displayName).toBe('Ana Pérez');
    });

    it('[US1-AC9] un 404 NOT_FOUND (inexistente o de otro taller) se propaga como el Problem tipado', () => {
      const body = problem(404, 'NOT_FOUND');
      let received: unknown;
      service.getById(VEHICLE_ID).subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne(`/api/v1/vehicles/${VEHICLE_ID}`)
        .flush(body, { status: 404, statusText: 'Not Found', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
    });

    it('[edge case conexión inestable] un fallo de red se propaga como HttpErrorResponse', () => {
      let received: unknown;
      service.getById(VEHICLE_ID).subscribe({ error: (err: unknown) => (received = err) });

      httpMock.expectOne(`/api/v1/vehicles/${VEHICLE_ID}`).error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

      expect(received).toBeInstanceOf(HttpErrorResponse);
    });
  });

  describe('search', () => {
    it('[US1-AC1] hace GET /api/v1/vehicles/search con el parámetro q y devuelve VehicleSearchResponse', () => {
      let result: VehicleSearchResponse | undefined;
      service.search('PBA1234').subscribe((response: VehicleSearchResponse) => (result = response));

      const req = httpMock.expectOne((r) => r.url === '/api/v1/vehicles/search' && r.params.get('q') === 'PBA1234');
      expect(req.request.method).toBe('GET');
      req.flush(SEARCH);

      expect(result).toEqual(SEARCH);
      expect(result?.items[0].owner.displayName).toBe('Ana Pérez');
    });

    it('[US1-AC2] envía el término tal como se escribió (lo normaliza el servidor) y lo codifica en la URL', () => {
      service.search('pba 12').subscribe();

      const req = httpMock.expectOne((r) => r.url === '/api/v1/vehicles/search');
      expect(req.request.params.get('q')).toBe('pba 12');
      expect(req.request.urlWithParams).toMatch(/q=pba(%20|\+)12/);
      req.flush({ items: [], hasMore: false });
    });

    it('[US1-AC4] conserva hasMore de la respuesta', () => {
      let result: VehicleSearchResponse | undefined;
      service.search('BA').subscribe((response: VehicleSearchResponse) => (result = response));

      httpMock.expectOne((r) => r.url === '/api/v1/vehicles/search').flush({ ...SEARCH, hasMore: true });

      expect(result?.hasMore).toBe(true);
    });

    it('[US1-AC5] un 400 SEARCH_TERM_TOO_SHORT se propaga como el Problem tipado', () => {
      const body = problem(400, 'SEARCH_TERM_TOO_SHORT');
      let received: Problem | undefined;
      service.search('a').subscribe({ error: (err: Problem) => (received = err) });

      httpMock
        .expectOne((r) => r.url === '/api/v1/vehicles/search')
        .flush(body, { status: 400, statusText: 'Bad Request', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
    });
  });
});
