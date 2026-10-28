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
//
// T076 (PR3, US4), métodos nuevos para el implementer (T077):
//     update(vehicleId: string, body: VehicleUpdate): Observable<VehicleDetail>
//         // PATCH /api/v1/vehicles/{vehicleId}
//     transferOwnership(vehicleId: string, body: OwnershipTransferRequest): Observable<VehicleDetail>
//         // POST  /api/v1/vehicles/{vehicleId}/ownership-transfers
//     getOwnershipHistory(vehicleId: string): Observable<OwnershipHistoryResponse>
//         // GET   /api/v1/vehicles/{vehicleId}/ownership-history  ({ items: OwnershipChange[] }, sin reordenar)
//   Cuerpos tal cual, id con encodeURIComponent, errores Problem como arriba (409 VERSION_CONFLICT con current,
//   422 SAME_OWNER, 404 CLIENT_NOT_FOUND, 400 REASON_REQUIRED).
//
// T004 (007, US1, US2), método nuevo para el implementer (T005):
//     getHistory(vehicleId: string): Observable<VehicleClinicalHistory>
//         // GET   /api/v1/vehicles/{vehicleId}/history
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Observable } from 'rxjs';
import type {
  OwnershipHistoryResponse,
  OwnershipTransferRequest,
  Problem,
  VehicleCreate,
  VehicleDetail,
  VehicleSearchResponse,
  VehicleUpdate,
} from './api.models';
import { VehiclesApiService } from './vehicles-api.service';

export interface VehicleHeader {
  id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
  color: string;
  bodyType: string;
  vin: string | null;
  initialMileage: number;
}

export interface VehicleOwner {
  id: string;
  displayName: string;
  documentType: 'cedula' | 'ruc' | 'passport';
  documentNumber: string;
  phone?: string | null;
}

export interface VehicleMetrics {
  currentMileage: number;
  mileageDelta: number;
  totalCheckins: number;
  totalWorkOrders: number;
  totalDeliveredWorkOrders: number;
  totalInvested: string;
  lastVisitAt: string | null;
}

export interface TimelineEvent {
  id: string;
  kind: 'checkin' | 'budget' | 'work_order' | 'ownership_transfer';
  occurredAt: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface VehicleClinicalHistory {
  vehicle: VehicleHeader;
  owner: VehicleOwner;
  metrics: VehicleMetrics;
  timeline: TimelineEvent[];
}

declare module './vehicles-api.service' {
  interface VehiclesApiService {
    getHistory(vehicleId: string): Observable<VehicleClinicalHistory>;
  }
}

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

describe('VehiclesApiService: edición, transferencia e historial (T076)', () => {
  const NEW_OWNER_ID = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
  const REASON = 'Venta del vehículo con contrato notariado';

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

  describe('update', () => {
    const UPDATE_BODY: VehicleUpdate = { version: 1, color: 'Rojo', initialMileage: 46000 };

    it('[US4-AC6] hace PATCH /api/v1/vehicles/{vehicleId} con el cuerpo VehicleUpdate y devuelve el VehicleDetail', () => {
      const updated: VehicleDetail = { ...DETAIL, color: 'Rojo', initialMileage: 46000, version: 2 };
      let result: VehicleDetail | undefined;
      service.update(VEHICLE_ID, UPDATE_BODY).subscribe((detail: VehicleDetail) => (result = detail));

      const req = httpMock.expectOne(`/api/v1/vehicles/${VEHICLE_ID}`);
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual(UPDATE_BODY);
      req.flush(updated);

      expect(result).toEqual(updated);
    });

    it('[US4-AC11][US4-AC15] envía plate, vin y reason cuando cambian los identificadores', () => {
      const body: VehicleUpdate = { version: 2, plate: 'PBB4321', vin: '1HGCM82633A004352', reason: REASON };
      service.update(VEHICLE_ID, body).subscribe();

      const req = httpMock.expectOne(`/api/v1/vehicles/${VEHICLE_ID}`);
      expect(req.request.body).toEqual(body);
      req.flush({ ...DETAIL, plate: 'PBB4321', vin: '1HGCM82633A004352', version: 3 });
    });

    it('[US4-AC13] codifica el id en la URL y no añade tenantId ni X-Tenant-Id', () => {
      service.update('a/b c', UPDATE_BODY).subscribe();

      const req = httpMock.expectOne('/api/v1/vehicles/a%2Fb%20c');
      expect(Object.keys(req.request.body as object)).not.toContain('tenantId');
      expect(req.request.headers.has('X-Tenant-Id')).toBe(false);
      req.flush(DETAIL);
    });

    it('[US4-AC12] un 409 VERSION_CONFLICT se propaga como Problem con current', () => {
      const current: VehicleDetail = { ...DETAIL, color: 'Negro', version: 2 };
      let received: Problem | undefined;
      service.update(VEHICLE_ID, UPDATE_BODY).subscribe({ error: (err: Problem) => (received = err) });

      httpMock
        .expectOne(`/api/v1/vehicles/${VEHICLE_ID}`)
        .flush(problem(409, 'VERSION_CONFLICT', { current }), {
          status: 409,
          statusText: 'Conflict',
          headers: PROBLEM_HEADERS,
        });

      expect(received?.code).toBe('VERSION_CONFLICT');
      expect(received?.current).toEqual(current);
      expect(received).not.toBeInstanceOf(HttpErrorResponse);
    });

    it('[US4-AC5] un 409 PLATE_ALREADY_EXISTS se propaga como Problem con existingId', () => {
      let received: Problem | undefined;
      service.update(VEHICLE_ID, { version: 1, plate: 'GYE0123', reason: REASON }).subscribe({
        error: (err: Problem) => (received = err),
      });

      httpMock
        .expectOne(`/api/v1/vehicles/${VEHICLE_ID}`)
        .flush(problem(409, 'PLATE_ALREADY_EXISTS', { existingId: EXISTING_ID }), {
          status: 409,
          statusText: 'Conflict',
          headers: PROBLEM_HEADERS,
        });

      expect(received?.code).toBe('PLATE_ALREADY_EXISTS');
      expect(received?.existingId).toBe(EXISTING_ID);
    });

    it('[US4-AC15] un 400 REASON_REQUIRED se propaga como el Problem tipado', () => {
      const body = problem(400, 'VALIDATION_ERROR', { errors: [{ field: 'reason', code: 'REASON_REQUIRED', message: 'x' }] });
      let received: unknown;
      service.update(VEHICLE_ID, { version: 1, plate: 'GYE0123' }).subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne(`/api/v1/vehicles/${VEHICLE_ID}`)
        .flush(body, { status: 400, statusText: 'Bad Request', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
    });
  });

  describe('transferOwnership', () => {
    const TRANSFER: OwnershipTransferRequest = { newOwnerClientId: NEW_OWNER_ID, version: 1, reason: REASON };

    it('[US4-AC7] hace POST /api/v1/vehicles/{vehicleId}/ownership-transfers y devuelve el vehículo con el nuevo propietario', () => {
      const transferred: VehicleDetail = {
        ...DETAIL,
        version: 2,
        owner: { ...OWNER, id: NEW_OWNER_ID, displayName: 'Carlos Ruiz', documentNumber: '0912345675' },
      };
      let result: VehicleDetail | undefined;
      service.transferOwnership(VEHICLE_ID, TRANSFER).subscribe((detail: VehicleDetail) => (result = detail));

      const req = httpMock.expectOne(`/api/v1/vehicles/${VEHICLE_ID}/ownership-transfers`);
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual(TRANSFER);
      req.flush(transferred);

      expect(result?.owner.id).toBe(NEW_OWNER_ID);
    });

    it('[US4-AC16] sin motivo (admin) envía el cuerpo sin reason', () => {
      service.transferOwnership(VEHICLE_ID, { newOwnerClientId: NEW_OWNER_ID, version: 1 }).subscribe();

      const req = httpMock.expectOne(`/api/v1/vehicles/${VEHICLE_ID}/ownership-transfers`);
      expect(req.request.body).toEqual({ newOwnerClientId: NEW_OWNER_ID, version: 1 });
      expect(Object.keys(req.request.body as object)).not.toContain('tenantId');
      req.flush(DETAIL);
    });

    it('[US4-AC13] codifica el id del vehículo en la URL', () => {
      service.transferOwnership('a/b', TRANSFER).subscribe();

      httpMock.expectOne('/api/v1/vehicles/a%2Fb/ownership-transfers').flush(DETAIL);
    });

    it.each<[number, Problem['code']]>([
      [422, 'SAME_OWNER'],
      [404, 'CLIENT_NOT_FOUND'],
      [404, 'NOT_FOUND'],
      [409, 'VERSION_CONFLICT'],
    ])('[US4-AC7][US4-AC9][US4-AC12] un %i %s se propaga como el Problem tipado', (status, code) => {
      const body = problem(status, code);
      let received: unknown;
      service.transferOwnership(VEHICLE_ID, TRANSFER).subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne(`/api/v1/vehicles/${VEHICLE_ID}/ownership-transfers`)
        .flush(body, { status, statusText: 'Error', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
      expect(received).not.toBeInstanceOf(HttpErrorResponse);
    });

    it('[US4-AC15] un 400 REASON_REQUIRED se propaga como el Problem tipado', () => {
      const body = problem(400, 'VALIDATION_ERROR', { errors: [{ field: 'reason', code: 'REASON_REQUIRED', message: 'x' }] });
      let received: unknown;
      service.transferOwnership(VEHICLE_ID, { newOwnerClientId: NEW_OWNER_ID, version: 1 }).subscribe({
        error: (err: unknown) => (received = err),
      });

      httpMock
        .expectOne(`/api/v1/vehicles/${VEHICLE_ID}/ownership-transfers`)
        .flush(body, { status: 400, statusText: 'Bad Request', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
    });
  });

  describe('getOwnershipHistory', () => {
    const HISTORY: OwnershipHistoryResponse = {
      items: [
        {
          id: 'd4444444-4444-4444-8444-444444444444',
          occurredAt: '2026-10-21T18:00:00.000Z',
          previousOwner: { clientId: NEW_OWNER_ID, displayName: 'Carlos Ruiz', documentNumber: '0912345675' },
          newOwner: { clientId: OWNER_ID, displayName: 'Ana Pérez', documentNumber: '1710034065' },
          actorUserId: '22222222-2222-4222-8222-222222222222',
          actorName: 'Admin Uno',
          actorRole: 'admin',
          reason: null,
        },
        {
          id: 'e5555555-5555-4555-8555-555555555555',
          occurredAt: '2026-10-20T15:00:00.000Z',
          previousOwner: { clientId: OWNER_ID, displayName: 'Ana Pérez', documentNumber: '1710034065' },
          newOwner: { clientId: NEW_OWNER_ID, displayName: 'Carlos Ruiz', documentNumber: '0912345675' },
          actorUserId: '11111111-1111-4111-8111-111111111111',
          actorName: 'Asesor Uno',
          actorRole: 'asesor',
          reason: REASON,
        },
      ],
    };

    it('[US4-AC10] hace GET /api/v1/vehicles/{vehicleId}/ownership-history y devuelve los items en el orden recibido', () => {
      let result: OwnershipHistoryResponse | undefined;
      service.getOwnershipHistory(VEHICLE_ID).subscribe((response: OwnershipHistoryResponse) => (result = response));

      const req = httpMock.expectOne(`/api/v1/vehicles/${VEHICLE_ID}/ownership-history`);
      expect(req.request.method).toBe('GET');
      req.flush(HISTORY);

      expect(result).toEqual(HISTORY);
      expect(result?.items.map((item) => item.id)).toEqual(HISTORY.items.map((item) => item.id));
    });

    it('[US4-AC10] un historial vacío llega como items vacío', () => {
      let result: OwnershipHistoryResponse | undefined;
      service.getOwnershipHistory(VEHICLE_ID).subscribe((response: OwnershipHistoryResponse) => (result = response));

      httpMock.expectOne(`/api/v1/vehicles/${VEHICLE_ID}/ownership-history`).flush({ items: [] });

      expect(result).toEqual({ items: [] });
    });

    it('[US4-AC14] un 404 NOT_FOUND (vehículo de otro taller) se propaga como el Problem tipado', () => {
      const body = problem(404, 'NOT_FOUND');
      let received: unknown;
      service.getOwnershipHistory(VEHICLE_ID).subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne(`/api/v1/vehicles/${VEHICLE_ID}/ownership-history`)
        .flush(body, { status: 404, statusText: 'Not Found', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
    });
  });

  describe('getHistory (T004, US1, US2)', () => {
    const CLINICAL_HISTORY: VehicleClinicalHistory = {
      vehicle: {
        id: VEHICLE_ID,
        plate: 'PBA1234',
        brand: 'Toyota',
        model: 'Hilux',
        year: 2022,
        color: 'Blanco',
        bodyType: 'pickup',
        vin: null,
        initialMileage: 45000,
      },
      owner: {
        id: OWNER_ID,
        displayName: 'Ana Pérez',
        documentType: 'cedula',
        documentNumber: '1710034065',
        phone: '0991234567',
      },
      metrics: {
        currentMileage: 52000,
        mileageDelta: 7000,
        totalCheckins: 3,
        totalWorkOrders: 2,
        totalDeliveredWorkOrders: 2,
        totalInvested: '450.00',
        lastVisitAt: '2026-10-21T18:00:00.000Z',
      },
      timeline: [
        {
          id: 'e1111111-1111-4111-8111-111111111111',
          kind: 'work_order',
          occurredAt: '2026-10-21T18:00:00.000Z',
          summary: 'Orden de trabajo #2 entregada',
          data: { number: 2, status: 'entregada' },
        },
        {
          id: 'e2222222-2222-4222-8222-222222222222',
          kind: 'budget',
          occurredAt: '2026-10-21T16:00:00.000Z',
          summary: 'Presupuesto #2 aprobado',
          data: { number: 2, status: 'aprobado', total: '250.00' },
        },
        {
          id: 'e3333333-3333-4333-8333-333333333333',
          kind: 'checkin',
          occurredAt: '2026-10-21T15:00:00.000Z',
          summary: 'Check-in de recepción con 52.000 km',
          data: { mileage: 52000, fuelLevel: '1/2' },
        },
        {
          id: 'e4444444-4444-4444-8444-444444444444',
          kind: 'ownership_transfer',
          occurredAt: '2026-09-15T14:00:00.000Z',
          summary: 'Transferencia de propietario',
          data: {
            previousOwner: { displayName: 'Carlos Ruiz', documentNumber: '0912345675' },
            newOwner: { displayName: 'Ana Pérez', documentNumber: '1710034065' },
          },
        },
      ],
    };

    it('[US1-AC1] solicita GET /api/v1/vehicles/:vehicleId/history y retorna VehicleClinicalHistory', () => {
      let result: VehicleClinicalHistory | undefined;
      service.getHistory(VEHICLE_ID).subscribe((response: VehicleClinicalHistory) => (result = response));

      const req = httpMock.expectOne(`/api/v1/vehicles/${VEHICLE_ID}/history`);
      expect(req.request.method).toBe('GET');
      req.flush(CLINICAL_HISTORY);

      expect(result).toEqual(CLINICAL_HISTORY);
    });

    it('[US1-AC1] codifica el vehicleId en la URL', () => {
      const weirdId = 'vehículo/especial?1';
      service.getHistory(weirdId).subscribe();

      const req = httpMock.expectOne(`/api/v1/vehicles/${encodeURIComponent(weirdId)}/history`);
      expect(req.request.method).toBe('GET');
      req.flush(CLINICAL_HISTORY);
    });

    it('[US1-AC4] maneja error 404 (vehículo inexistente o ajeno) propagando Problem tipado', () => {
      const body = problem(404, 'NOT_FOUND');
      let received: unknown;
      service.getHistory(VEHICLE_ID).subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne(`/api/v1/vehicles/${VEHICLE_ID}/history`)
        .flush(body, { status: 404, statusText: 'Not Found', headers: PROBLEM_HEADERS });

      expect(received).toEqual(body);
    });

    it('[edge case conexión inestable] un fallo de red con status 0 se propaga como HttpErrorResponse', () => {
      let received: unknown;
      service.getHistory(VEHICLE_ID).subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne(`/api/v1/vehicles/${VEHICLE_ID}/history`)
        .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

      expect(received).toBeInstanceOf(HttpErrorResponse);
    });
  });
});
