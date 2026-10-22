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
import { HttpClient, HttpErrorResponse, HttpResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import type { ClientCreate, ClientDetail, ClientSearchResponse, Problem } from './api.models';
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
  });
});
