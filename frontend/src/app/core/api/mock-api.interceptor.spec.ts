// T029: mockApiInterceptor, parte de clientes (research R8). Responde con datos en memoria que respetan
// contracts/openapi.yaml y las mismas validaciones que la API, solo si USE_MOCK_API es true.
//
// Contrato para el implementer (T030), archivo core/api/mock-api.interceptor.ts:
//   export const mockApiInterceptor: HttpInterceptorFn
//   - USE_MOCK_API false → no hace nada (next(req)).
//   - USE_MOCK_API true  → atiende las rutas /api/v1/clients...; lo que no empieza por /api/ sigue a next(req).
//   - Éxito: HttpResponse con el status del contrato. Error: HttpErrorResponse cuyo `error` es el Problem.
//   - Los datos en memoria viven en el inyector (p. ej. un servicio providedIn: 'root'), de modo que cada
//     TestBed empieza con su propio almacén. Los datos semilla, si los hay, no usan los documentos de estas
//     pruebas (1710034065, 0912345675, 1790011674001) ni el nombre "Núñez".
//   - Puede responder con retardo: las pruebas esperan la respuesta de forma asíncrona.
//
// T057: parte de vehículos (contrato para el implementer, T058):
//   - POST /api/v1/vehicles y GET /api/v1/vehicles/{id} como la API (201 + Location, 400, 404, 409).
//   - GET /api/v1/vehicles/search?q= (VehicleSearchResponse). Debe atenderse ANTES de /vehicles/{id}: hoy "search"
//     se lee como un id y responde 404. Igual que data-model.md "Consultas de referencia":
//       q se normaliza: mayúsculas y solo [A-Z0-9] (se descarta todo lo demás). Menos de 2 caracteres tras
//       normalizar, sin q o con q vacío → 400 SEARCH_TERM_TOO_SHORT (como el backend). Más de 40 caracteres
//       (maxLength del contrato) → 400 VALIDATION_ERROR en q.
//       Coincide si la placa contiene q, o si el VIN es igual a q (un fragmento de VIN no coincide).
//       Orden: exacta (placa o VIN) → prefijo de placa → contiene; empate por placa. Máximo 20 + hasMore.
//       Cada item: VehicleSummary + vin, color, bodyType, initialMileage, owner (ClientSummary).
//   - Los vehículos semilla no usan las placas ni los VIN de estas pruebas ni contienen "BA12" ni "ABC10".
import { HttpClient, HttpErrorResponse, HttpResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import type {
  ClientCreate,
  ClientDetail,
  ClientSearchResponse,
  Problem,
  VehicleCreate,
  VehicleDetail,
  VehicleSearchItem,
  VehicleSearchResponse,
} from './api.models';
import { mockApiInterceptor } from './mock-api.interceptor';
import { USE_MOCK_API } from './use-mock-api';

const NATURAL: ClientCreate = {
  clientType: 'natural',
  documentType: 'cedula',
  documentNumber: '171003406-5',
  firstNames: 'José Andrés',
  lastNames: 'Núñez',
  phone: '+593 99 123 4567',
  email: 'Jose.Nunez@Example.com',
};

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

function setup(useMock: boolean): { http: HttpClient; httpMock: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [
      { provide: USE_MOCK_API, useValue: useMock },
      provideHttpClient(withInterceptors([mockApiInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  return { http: TestBed.inject(HttpClient), httpMock: TestBed.inject(HttpTestingController) };
}

async function failure(request: Promise<unknown>): Promise<HttpErrorResponse> {
  try {
    await request;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpErrorResponse);
    return error as HttpErrorResponse;
  }
  throw new Error('Se esperaba un error HTTP y la petición tuvo éxito');
}

function problemOf(error: HttpErrorResponse): Problem {
  return error.error as Problem;
}

function fieldCodes(error: HttpErrorResponse): { field: string; code: string }[] {
  return (problemOf(error).errors ?? []).map(({ field, code }) => ({ field, code }));
}

describe('mockApiInterceptor: activación (T029)', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('[R8] con USE_MOCK_API false no responde: la petición llega al backend', () => {
    const { http, httpMock } = setup(false);
    let body: unknown;
    http.get('/api/v1/clients/search', { params: { q: 'nunez' } }).subscribe((response) => (body = response));

    const req = httpMock.expectOne((r) => r.url === '/api/v1/clients/search');
    req.flush({ items: [], hasMore: false });
    expect(body).toEqual({ items: [], hasMore: false });
  });

  it('[R8] con USE_MOCK_API false un POST /api/v1/clients también pasa al backend', () => {
    const { http, httpMock } = setup(false);
    http.post('/api/v1/clients', NATURAL).subscribe();

    httpMock.expectOne('/api/v1/clients').flush({}, { status: 201, statusText: 'Created' });
  });

  it('[R8] con USE_MOCK_API true responde sin llegar al backend', async () => {
    const { http, httpMock } = setup(true);

    await firstValueFrom(http.get<ClientSearchResponse>('/api/v1/clients/search', { params: { q: 'nunez' } }));

    httpMock.expectNone(() => true);
  });

  it('[R8] con USE_MOCK_API true lo que no es /api/ sigue su camino', () => {
    const { http, httpMock } = setup(true);
    http.get('/assets/config.json').subscribe();

    httpMock.expectOne('/assets/config.json').flush({});
  });
});

describe('mockApiInterceptor: clientes (T029)', () => {
  let http: HttpClient;

  beforeEach(() => {
    http = setup(true).http;
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  function create(body: unknown): Promise<HttpResponse<ClientDetail>> {
    return firstValueFrom(http.post<ClientDetail>('/api/v1/clients', body, { observe: 'response' }));
  }

  describe('POST /api/v1/clients', () => {
    it('[US2-AC1] 201 con ClientDetail normalizado, vehicles vacío, auditoría y Location', async () => {
      const response = await create(NATURAL);

      expect(response.status).toBe(201);
      const detail = response.body as ClientDetail;
      expect(detail.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(detail).toEqual(
        expect.objectContaining({
          clientType: 'natural',
          documentType: 'cedula',
          documentNumber: '1710034065',
          firstNames: 'José Andrés',
          lastNames: 'Núñez',
          displayName: 'José Andrés Núñez',
          phone: '+593991234567',
          email: 'jose.nunez@example.com',
          version: 1,
          vehicles: [],
        }),
      );
      expect(Number.isNaN(Date.parse(detail.createdAt))).toBe(false);
      expect(Number.isNaN(Date.parse(detail.updatedAt))).toBe(false);
      expect(detail.updatedBy).toEqual(expect.any(String));
      expect(detail.updatedByName).toEqual(expect.any(String));
      expect(response.headers.get('Location')).toBe(`/api/v1/clients/${detail.id}`);
    });

    it('[US2-AC2] 201 para una empresa con RUC (displayName = razón social)', async () => {
      const response = await create({
        clientType: 'company',
        documentType: 'ruc',
        documentNumber: '1790011674001',
        businessName: 'Talleres Andinos S.A.',
        phone: '022551234',
      });

      expect(response.status).toBe(201);
      expect(response.body?.displayName).toBe('Talleres Andinos S.A.');
      expect(response.body?.email).toBeNull();
    });

    it('[US2-AC7] 201 con correo omitido o null', async () => {
      const omitted = await create({ ...NATURAL, email: undefined });
      expect(omitted.status).toBe(201);
      expect(omitted.body?.email).toBeNull();

      const nulled = await create({ ...NATURAL, documentNumber: '0912345675', email: null });
      expect(nulled.status).toBe(201);
      expect(nulled.body?.email).toBeNull();
    });

    it('[US2-AC4] 400 VALIDATION_ERROR con INVALID_CEDULA en documentNumber', async () => {
      const error = await failure(create({ ...NATURAL, documentNumber: '1710034064' }));

      expect(error.status).toBe(400);
      expect(problemOf(error)).toEqual(expect.objectContaining({ status: 400, code: 'VALIDATION_ERROR' }));
      expect(fieldCodes(error)).toContainEqual({ field: 'documentNumber', code: 'INVALID_CEDULA' });
    });

    it('[US2-AC5] 400 con INVALID_RUC en documentNumber', async () => {
      const error = await failure(create({ ...NATURAL, documentType: 'ruc', documentNumber: '1710034065002' }));

      expect(error.status).toBe(400);
      expect(fieldCodes(error)).toContainEqual({ field: 'documentNumber', code: 'INVALID_RUC' });
    });

    it('[US2-AC3] 400 con INVALID_PASSPORT para un pasaporte de 4 caracteres', async () => {
      const error = await failure(create({ ...NATURAL, documentType: 'passport', documentNumber: 'A123' }));

      expect(fieldCodes(error)).toContainEqual({ field: 'documentNumber', code: 'INVALID_PASSPORT' });
    });

    it('[US2-AC2] 400 con INVALID_DOCUMENT_TYPE para una empresa con cédula', async () => {
      const error = await failure(
        create({
          clientType: 'company',
          documentType: 'cedula',
          documentNumber: '1710034065',
          businessName: 'Talleres Andinos S.A.',
          phone: '022551234',
        }),
      );

      expect(error.status).toBe(400);
      expect(fieldCodes(error)).toContainEqual({ field: 'documentType', code: 'INVALID_DOCUMENT_TYPE' });
    });

    it('[US2-AC7] 400 con INVALID_EMAIL e INVALID_PHONE', async () => {
      const error = await failure(create({ ...NATURAL, email: 'ana@', phone: '123456' }));

      expect(fieldCodes(error)).toEqual(
        expect.arrayContaining([
          { field: 'email', code: 'INVALID_EMAIL' },
          { field: 'phone', code: 'INVALID_PHONE' },
        ]),
      );
    });

    it('[US2-AC8] 400 con REQUIRED por cada obligatorio faltante', async () => {
      const error = await failure(create({ clientType: 'natural', documentType: 'cedula' }));

      expect(fieldCodes(error)).toEqual(
        expect.arrayContaining([
          { field: 'documentNumber', code: 'REQUIRED' },
          { field: 'firstNames', code: 'REQUIRED' },
          { field: 'lastNames', code: 'REQUIRED' },
          { field: 'phone', code: 'REQUIRED' },
        ]),
      );
    });

    it('[US2-AC10] 400 con UNKNOWN_FIELD si el body trae tenantId', async () => {
      const error = await failure(create({ ...NATURAL, tenantId: UNKNOWN_ID }));

      expect(error.status).toBe(400);
      expect(fieldCodes(error)).toContainEqual({ field: 'tenantId', code: 'UNKNOWN_FIELD' });
    });

    it('[US2-AC6] 409 DOCUMENT_ALREADY_EXISTS con existingId para el mismo documento con espacios o guiones', async () => {
      const first = await create({ ...NATURAL, documentNumber: '1710034065' });

      const error = await failure(create({ ...NATURAL, documentNumber: ' 171 003 406-5 ' }));

      expect(error.status).toBe(409);
      expect(problemOf(error)).toEqual(
        expect.objectContaining({ status: 409, code: 'DOCUMENT_ALREADY_EXISTS', existingId: first.body?.id }),
      );
    });

    it('[US2-AC6] un documento rechazado no queda guardado: tras un 400 el mismo documento válido da 201', async () => {
      await failure(create({ ...NATURAL, phone: '123' }));

      const response = await create(NATURAL);
      expect(response.status).toBe(201);
    });
  });

  describe('GET /api/v1/clients/{clientId}', () => {
    it('[US2-AC1] 200 con el cliente creado', async () => {
      const created = (await create(NATURAL)).body as ClientDetail;

      const response = await firstValueFrom(
        http.get<ClientDetail>(`/api/v1/clients/${created.id}`, { observe: 'response' }),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual(created);
    });

    it('[FR-023] 404 NOT_FOUND para un id que no existe', async () => {
      const error = await failure(firstValueFrom(http.get(`/api/v1/clients/${UNKNOWN_ID}`)));

      expect(error.status).toBe(404);
      expect(problemOf(error)).toEqual(expect.objectContaining({ status: 404, code: 'NOT_FOUND' }));
    });
  });

  describe('GET /api/v1/clients/search', () => {
    function search(q: string): Promise<HttpResponse<ClientSearchResponse>> {
      return firstValueFrom(
        http.get<ClientSearchResponse>('/api/v1/clients/search', { params: { q }, observe: 'response' }),
      );
    }

    it('[US4-AC1] 200 con items y hasMore; encuentra por documento con o sin guion', async () => {
      const created = (await create(NATURAL)).body as ClientDetail;

      for (const q of ['1710034065', '171003406-5', '17100']) {
        const response = await search(q);
        expect(response.status).toBe(200);
        expect(response.body?.hasMore).toBe(false);
        expect(response.body?.items.map((item) => item.id)).toContain(created.id);
      }
    });

    it('[US4-AC2] encuentra por nombre sin distinguir mayúsculas ni tildes, con forma ClientSummary', async () => {
      const created = (await create(NATURAL)).body as ClientDetail;

      const response = await search('nunez');

      const item = response.body?.items.find((candidate) => candidate.id === created.id);
      expect(item).toEqual({
        id: created.id,
        clientType: 'natural',
        documentType: 'cedula',
        documentNumber: '1710034065',
        displayName: 'José Andrés Núñez',
        phone: '+593991234567',
        email: 'jose.nunez@example.com',
      });
    });

    it('[US1-AC5] 400 SEARCH_TERM_TOO_SHORT con menos de 2 caracteres', async () => {
      const error = await failure(search('a'));

      expect(error.status).toBe(400);
      expect(problemOf(error)).toEqual(expect.objectContaining({ status: 400, code: 'SEARCH_TERM_TOO_SHORT' }));
    });

    it('[US4-AC2] 400 SEARCH_TERM_TOO_SHORT sin q o con q vacío (como el backend)', async () => {
      for (const request of [http.get('/api/v1/clients/search'), http.get('/api/v1/clients/search', { params: { q: '' } })]) {
        const error = await failure(firstValueFrom(request));
        expect(error.status).toBe(400);
        expect(problemOf(error)).toEqual(expect.objectContaining({ status: 400, code: 'SEARCH_TERM_TOO_SHORT' }));
      }
    });
  });
});

describe('mockApiInterceptor: vehículos (T057)', () => {
  const VIN = '1HGCM82633A004352';
  let http: HttpClient;
  let owner: ClientDetail;

  beforeEach(async () => {
    http = setup(true).http;
    owner = await firstValueFrom(http.post<ClientDetail>('/api/v1/clients', NATURAL));
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  function vehicle(extra: Partial<VehicleCreate> = {}): VehicleCreate {
    return {
      ownerClientId: owner.id,
      plate: 'PBA1234',
      vin: null,
      brand: 'Toyota',
      model: 'Corolla',
      year: 2020,
      color: 'Blanco',
      bodyType: 'sedan',
      initialMileage: 45200,
      ...extra,
    };
  }

  /** Motorcycle plates are 2 letters, 3 digits and 1 letter (AB123C). */
  function bodyTypeOf(plate: string): VehicleCreate['bodyType'] {
    return /^[A-Z]{2}[0-9]{3}[A-Z]$/.test(plate) ? 'motorcycle' : 'sedan';
  }

  function create(body: unknown): Promise<HttpResponse<VehicleDetail>> {
    return firstValueFrom(http.post<VehicleDetail>('/api/v1/vehicles', body, { observe: 'response' }));
  }

  async function createAll(plateList: string[]): Promise<VehicleDetail[]> {
    const responses = await Promise.all(
      plateList.map((plate) => create(vehicle({ plate, bodyType: bodyTypeOf(plate) }))),
    );
    return responses.map((response) => response.body as VehicleDetail);
  }

  function search(q: string): Promise<HttpResponse<VehicleSearchResponse>> {
    return firstValueFrom(
      http.get<VehicleSearchResponse>('/api/v1/vehicles/search', { params: { q }, observe: 'response' }),
    );
  }

  function plates(response: HttpResponse<VehicleSearchResponse>): string[] {
    return (response.body?.items ?? []).map((item) => item.plate);
  }

  describe('POST /api/v1/vehicles', () => {
    it('[US3-AC1] 201 con VehicleDetail normalizado, propietario y Location', async () => {
      const response = await create(vehicle({ plate: 'pba-1234', vin: VIN.toLowerCase() }));

      expect(response.status).toBe(201);
      const detail = response.body as VehicleDetail;
      expect(detail).toEqual(
        expect.objectContaining({
          plate: 'PBA1234',
          vin: VIN,
          brand: 'Toyota',
          model: 'Corolla',
          year: 2020,
          color: 'Blanco',
          bodyType: 'sedan',
          initialMileage: 45200,
          version: 1,
        }),
      );
      expect(detail.owner).toEqual(expect.objectContaining({ id: owner.id, displayName: 'José Andrés Núñez' }));
      expect(response.headers.get('Location')).toBe(`/api/v1/vehicles/${detail.id}`);
    });

    it('[US3-AC2] 400 VALIDATION_ERROR con INVALID_PLATE en plate', async () => {
      const error = await failure(create(vehicle({ plate: 'PB1234' })));

      expect(error.status).toBe(400);
      expect(problemOf(error)).toEqual(expect.objectContaining({ status: 400, code: 'VALIDATION_ERROR' }));
      expect(fieldCodes(error)).toContainEqual({ field: 'plate', code: 'INVALID_PLATE' });
    });

    it('[US3-AC3] 409 PLATE_ALREADY_EXISTS con existingId para la misma placa escrita de otra forma', async () => {
      const first = (await create(vehicle())).body as VehicleDetail;

      const error = await failure(create(vehicle({ plate: 'pba 1234' })));

      expect(error.status).toBe(409);
      expect(problemOf(error)).toEqual(
        expect.objectContaining({ status: 409, code: 'PLATE_ALREADY_EXISTS', existingId: first.id }),
      );
    });

    it('[US3-AC5] 409 VIN_ALREADY_EXISTS con existingId', async () => {
      const first = (await create(vehicle({ vin: VIN }))).body as VehicleDetail;

      const error = await failure(create(vehicle({ plate: 'GYE0123', vin: VIN })));

      expect(error.status).toBe(409);
      expect(problemOf(error)).toEqual(
        expect.objectContaining({ status: 409, code: 'VIN_ALREADY_EXISTS', existingId: first.id }),
      );
    });

    it('[US3-AC11] 404 CLIENT_NOT_FOUND si el propietario no existe', async () => {
      const error = await failure(create(vehicle({ ownerClientId: UNKNOWN_ID })));

      expect(error.status).toBe(404);
      expect(problemOf(error)).toEqual(expect.objectContaining({ status: 404, code: 'CLIENT_NOT_FOUND' }));
    });
  });

  describe('GET /api/v1/vehicles/{vehicleId}', () => {
    it('[US3-AC1] 200 con el vehículo creado', async () => {
      const created = (await create(vehicle())).body as VehicleDetail;

      const response = await firstValueFrom(
        http.get<VehicleDetail>(`/api/v1/vehicles/${created.id}`, { observe: 'response' }),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual(created);
    });

    it('[US1-AC9] 404 NOT_FOUND para un id que no existe', async () => {
      const error = await failure(firstValueFrom(http.get(`/api/v1/vehicles/${UNKNOWN_ID}`)));

      expect(error.status).toBe(404);
      expect(problemOf(error)).toEqual(expect.objectContaining({ status: 404, code: 'NOT_FOUND' }));
    });
  });

  describe('GET /api/v1/vehicles/search', () => {
    it('[US1-AC1] 200 con el vehículo como primer resultado y todos los campos de VehicleSearchResponse', async () => {
      const created = (await create(vehicle({ vin: VIN }))).body as VehicleDetail;

      const response = await search('PBA1234');

      expect(response.status).toBe(200);
      expect(response.body?.hasMore).toBe(false);
      const expected: VehicleSearchItem = {
        id: created.id,
        plate: 'PBA1234',
        brand: 'Toyota',
        model: 'Corolla',
        year: 2020,
        vin: VIN,
        color: 'Blanco',
        bodyType: 'sedan',
        initialMileage: 45200,
        owner: {
          id: owner.id,
          clientType: 'natural',
          documentType: 'cedula',
          documentNumber: '1710034065',
          displayName: 'José Andrés Núñez',
          phone: '+593991234567',
          email: 'jose.nunez@example.com',
        },
      };
      expect(response.body?.items[0]).toEqual(expected);
    });

    it('[US1-AC2] pba-1234, "PBA 1234" y " pba1234 " dan el mismo resultado', async () => {
      const created = (await create(vehicle())).body as VehicleDetail;

      for (const q of ['pba-1234', 'PBA 1234', ' pba1234 ']) {
        const response = await search(q);
        expect(response.status).toBe(200);
        expect(response.body?.items[0]?.id).toBe(created.id);
      }
    });

    it('[US1-AC3] el fragmento BA12 encuentra PBA1234 y PBA1299, sin GYE0123', async () => {
      await createAll(['PBA1234', 'PBA1299', 'GYE0123']);

      const response = await search('BA12');

      expect(plates(response)).toEqual(['PBA1234', 'PBA1299']);
    });

    it('[US1-AC4] la coincidencia exacta va antes que las que empiezan por el término', async () => {
      await createAll(['PBA1234', 'PBA1230', 'PBA123']);

      const response = await search('PBA123');

      expect(plates(response)).toEqual(['PBA123', 'PBA1230', 'PBA1234']);
    });

    it('[US1-AC4] las que empiezan por el término van antes que las que solo lo contienen', async () => {
      await createAll(['PBA1299', 'PBA1234', 'BA123C']);

      const response = await search('BA12');

      expect(plates(response)).toEqual(['BA123C', 'PBA1234', 'PBA1299']);
    });

    it('[US1-AC4] con 25 coincidencias devuelve 20, ordenadas por placa, y hasMore true', async () => {
      const all = Array.from({ length: 25 }, (_, i) => `ABC${1000 + i}`);
      await createAll(all);

      const response = await search('ABC10');

      expect(response.body?.items).toHaveLength(20);
      expect(response.body?.hasMore).toBe(true);
      expect(plates(response)).toEqual(all.slice(0, 20));
    });

    it('[US1-AC4] con exactamente 20 coincidencias hasMore es false', async () => {
      await createAll(Array.from({ length: 20 }, (_, i) => `ABC${1000 + i}`));

      const response = await search('ABC10');

      expect(response.body?.items).toHaveLength(20);
      expect(response.body?.hasMore).toBe(false);
    });

    it('[US1-AC5] 400 SEARCH_TERM_TOO_SHORT con 1 carácter válido o solo símbolos', async () => {
      for (const q of ['P', '*%', 'p-']) {
        const error = await failure(search(q));
        expect(error.status).toBe(400);
        expect(problemOf(error)).toEqual(expect.objectContaining({ status: 400, code: 'SEARCH_TERM_TOO_SHORT' }));
      }
    });

    it('[FR-002] en la búsqueda los símbolos se descartan: PBA*12 encuentra PBA1234', async () => {
      const created = (await create(vehicle())).body as VehicleDetail;

      const response = await search('PBA*12');

      expect(response.status).toBe(200);
      expect(response.body?.items.map((item) => item.id)).toContain(created.id);
    });

    it('[US1-AC5] 400 SEARCH_TERM_TOO_SHORT sin q o con q vacío (como el backend)', async () => {
      for (const request of [http.get('/api/v1/vehicles/search'), http.get('/api/v1/vehicles/search', { params: { q: '' } })]) {
        const error = await failure(firstValueFrom(request));
        expect(error.status).toBe(400);
        expect(problemOf(error)).toEqual(expect.objectContaining({ status: 400, code: 'SEARCH_TERM_TOO_SHORT' }));
      }
    });

    it('[contrato] 400 VALIDATION_ERROR en q con más de 40 caracteres (maxLength)', async () => {
      const tooLong = await failure(search('A'.repeat(41)));
      expect(tooLong.status).toBe(400);
      expect(problemOf(tooLong).code).toBe('VALIDATION_ERROR');
      expect(fieldCodes(tooLong).map(({ field }) => field)).toContain('q');
    });

    it('[US1-AC6] una placa inexistente devuelve 200 con items vacío y hasMore false', async () => {
      await create(vehicle());

      const response = await search('GYE0123');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], hasMore: false });
    });

    it('[US1-AC7] el VIN completo (en minúsculas o con guion) encuentra el vehículo; un fragmento no', async () => {
      const created = (await create(vehicle({ vin: VIN }))).body as VehicleDetail;

      for (const q of [VIN, VIN.toLowerCase(), `${VIN.slice(0, 8)}-${VIN.slice(8)}`]) {
        const response = await search(q);
        expect(response.body?.items[0]?.id).toBe(created.id);
      }

      const fragment = await search(VIN.slice(0, 10));
      expect(fragment.body).toEqual({ items: [], hasMore: false });
    });
  });
});
