// T064 (003, PR3, US4): SupportApiService contra specs/003-soporte-plataforma/contracts/openapi.yaml.
//
// Contrato para el implementer-frontend (T065), archivo core/api/support-api.service.ts:
//   @Injectable({ providedIn: 'root' }) export class SupportApiService {
//     listWorkshops(q?: string, page?: number): Observable<WorkshopListResponse>
//       // GET /api/v1/support/workshops; query `q` y `page` SOLO si vienen.
//     listWorkshopAccounts(workshopId: string): Observable<WorkshopAccountsResponse>
//       // GET /api/v1/support/workshops/{workshopId}/accounts, con el id URL-encoded.
//     listAccessLog(filters?: { workshopId?: string; agentId?: string; page?: number }): Observable<AccessLogResponse>
//       // GET /api/v1/support/access-log; solo los filtros presentes.
//   }
//   - Son GET normales de soporte: sin `withCredentials` (la cookie HttpOnly es solo para /support/auth/*).
//   - Errores con toProblem (Problem tipado o HttpErrorResponse ante fallo de red).
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Observable } from 'rxjs';
import { problemFlush } from '../../../testing/auth-fixtures';
import {
  accessLogResponseFixture,
  SUPPORT_ACCESS_LOG_URL,
  SUPPORT_WORKSHOPS_URL,
  supportProblem,
  WORKSHOP_ID,
  workshopAccountsResponseFixture,
  workshopAccountsUrl,
  workshopListResponseFixture,
  type AccessLogResponseFixture,
  type WorkshopAccountsResponseFixture,
  type WorkshopListResponseFixture,
} from '../../../testing/support-fixtures';
import type {
  AccessLogResponse,
  Problem,
  WorkshopAccountsResponse,
  WorkshopListResponse,
} from './api.models';
import { SupportApiService } from './support-api.service';

/** Tipos del contrato que T065 debe implementar; en la fase roja el servicio real aún no los tiene. */
interface AccessLogFilters {
  workshopId?: string;
  agentId?: string;
  page?: number;
}

interface SupportWorkshopsApi {
  listWorkshops(q?: string, page?: number): Observable<WorkshopListResponse>;
  listWorkshopAccounts(workshopId: string): Observable<WorkshopAccountsResponse>;
  listAccessLog(filters?: AccessLogFilters): Observable<AccessLogResponse>;
}

describe('SupportApiService workshops and access log (T064)', () => {
  let service: SupportWorkshopsApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SupportApiService) as unknown as SupportWorkshopsApi;
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('listWorkshops', () => {
    it('[US4-AC1] hace GET /api/v1/support/workshops sin query cuando no hay q ni page y devuelve WorkshopListResponse', () => {
      const list = workshopListResponseFixture();
      let result: WorkshopListResponseFixture | undefined;
      service.listWorkshops().subscribe((res: WorkshopListResponseFixture) => (result = res));

      const req = httpMock.expectOne(SUPPORT_WORKSHOPS_URL);
      expect(req.request.method).toBe('GET');
      expect(req.request.urlWithParams).toBe(SUPPORT_WORKSHOPS_URL);
      expect(req.request.params.keys()).toEqual([]);
      expect(req.request.withCredentials).toBe(false);
      req.flush(list);

      expect(result).toEqual(list);
    });

    it('[US4-AC1][US4-AC2] envía q y page solo cuando vienen, con el valor de q tal cual', () => {
      service.listWorkshops('andrade').subscribe();
      let req = httpMock.expectOne(
        (request) => request.url === SUPPORT_WORKSHOPS_URL && request.params.has('q'),
      );
      expect(req.request.params.get('q')).toBe('andrade');
      expect(req.request.params.has('page')).toBe(false);
      req.flush(workshopListResponseFixture());

      service.listWorkshops(undefined, 2).subscribe();
      req = httpMock.expectOne(
        (request) => request.url === SUPPORT_WORKSHOPS_URL && request.params.get('page') === '2',
      );
      expect(req.request.params.has('q')).toBe(false);
      req.flush(workshopListResponseFixture({ page: 2 }));

      service.listWorkshops('179-001-234-5001', 3).subscribe();
      req = httpMock.expectOne(
        (request) =>
          request.url === SUPPORT_WORKSHOPS_URL &&
          request.params.get('q') === '179-001-234-5001' &&
          request.params.get('page') === '3',
      );
      expect(req.request.params.keys().sort()).toEqual(['page', 'q']);
      req.flush(workshopListResponseFixture({ page: 3 }));
    });

    it('[US4-AC1] propaga 400 VALIDATION_ERROR como Problem tipado', () => {
      const body = supportProblem(400, 'VALIDATION_ERROR', {
        errors: [{ field: 'page', code: 'VALIDATION_ERROR', message: 'Debe ser un entero mayor o igual a 1' }],
      });
      let received: unknown;
      service.listWorkshops(undefined, 0).subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne((request) => request.url === SUPPORT_WORKSHOPS_URL && request.params.get('page') === '0')
        .flush(body, problemFlush(400));

      expect(received).toEqual(body);
      expect(received).not.toBeInstanceOf(HttpErrorResponse);
    });

    it('[US4-AC1] un fallo de red (status 0) se propaga como HttpErrorResponse', () => {
      let received: unknown;
      service.listWorkshops().subscribe({ error: (err: unknown) => (received = err) });

      httpMock
        .expectOne(SUPPORT_WORKSHOPS_URL)
        .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

      expect(received).toBeInstanceOf(HttpErrorResponse);
    });
  });

  describe('listWorkshopAccounts', () => {
    it('[US4-AC3] hace GET /api/v1/support/workshops/:workshopId/accounts y devuelve WorkshopAccountsResponse', () => {
      const accounts = workshopAccountsResponseFixture();
      let result: WorkshopAccountsResponseFixture | undefined;
      service
        .listWorkshopAccounts(WORKSHOP_ID)
        .subscribe((res: WorkshopAccountsResponseFixture) => (result = res));

      const req = httpMock.expectOne(workshopAccountsUrl(WORKSHOP_ID));
      expect(req.request.method).toBe('GET');
      expect(req.request.url).toBe(`${SUPPORT_WORKSHOPS_URL}/${WORKSHOP_ID}/accounts`);
      expect(req.request.withCredentials).toBe(false);
      req.flush(accounts);

      expect(result).toEqual(accounts);
    });

    it('[US4-AC3] URL-encodea el id del taller en la ruta', () => {
      const workshopId = 'taller/andrade 1';
      service.listWorkshopAccounts(workshopId).subscribe();

      const req = httpMock.expectOne(
        `${SUPPORT_WORKSHOPS_URL}/taller%2Fandrade%201/accounts`,
      );
      expect(req.request.method).toBe('GET');
      req.flush(workshopAccountsResponseFixture());
    });

    it('[US4-AC7] propaga 404 NOT_FOUND como Problem tipado', () => {
      const notFound = supportProblem(404, 'NOT_FOUND');
      let received: Problem | undefined;
      service
        .listWorkshopAccounts(WORKSHOP_ID)
        .subscribe({ error: (err: Problem) => (received = err) });

      httpMock.expectOne(workshopAccountsUrl(WORKSHOP_ID)).flush(notFound, problemFlush(404));

      expect(received).toEqual(notFound);
      expect(received?.code).toBe('NOT_FOUND');
    });
  });

  describe('listAccessLog', () => {
    it('[US4-AC8] hace GET /api/v1/support/access-log sin filtros y devuelve AccessLogResponse', () => {
      const log = accessLogResponseFixture();
      let result: AccessLogResponseFixture | undefined;
      service.listAccessLog().subscribe((res: AccessLogResponseFixture) => (result = res));

      const req = httpMock.expectOne(SUPPORT_ACCESS_LOG_URL);
      expect(req.request.method).toBe('GET');
      expect(req.request.urlWithParams).toBe(SUPPORT_ACCESS_LOG_URL);
      expect(req.request.params.keys()).toEqual([]);
      expect(req.request.withCredentials).toBe(false);
      req.flush(log);

      expect(result).toEqual(log);
    });

    it('[US4-AC8] envía solo los filtros presentes y los combina', () => {
      service.listAccessLog({ workshopId: WORKSHOP_ID }).subscribe();
      let req = httpMock.expectOne(
        (request) => request.url === SUPPORT_ACCESS_LOG_URL && request.params.has('workshopId'),
      );
      expect(req.request.params.get('workshopId')).toBe(WORKSHOP_ID);
      expect(req.request.params.has('agentId')).toBe(false);
      expect(req.request.params.has('page')).toBe(false);
      req.flush(accessLogResponseFixture());

      service.listAccessLog({ agentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }).subscribe();
      req = httpMock.expectOne(
        (request) => request.url === SUPPORT_ACCESS_LOG_URL && request.params.has('agentId'),
      );
      expect(req.request.params.has('workshopId')).toBe(false);
      expect(req.request.params.has('page')).toBe(false);
      req.flush(accessLogResponseFixture());

      service.listAccessLog({ page: 2 }).subscribe();
      req = httpMock.expectOne(
        (request) => request.url === SUPPORT_ACCESS_LOG_URL && request.params.get('page') === '2',
      );
      expect(req.request.params.has('workshopId')).toBe(false);
      expect(req.request.params.has('agentId')).toBe(false);
      req.flush(accessLogResponseFixture({ page: 2 }));

      service
        .listAccessLog({ workshopId: WORKSHOP_ID, agentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', page: 3 })
        .subscribe();
      req = httpMock.expectOne(
        (request) =>
          request.url === SUPPORT_ACCESS_LOG_URL &&
          request.params.get('workshopId') === WORKSHOP_ID &&
          request.params.get('agentId') === 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' &&
          request.params.get('page') === '3',
      );
      expect(req.request.params.keys().sort()).toEqual(['agentId', 'page', 'workshopId']);
      req.flush(accessLogResponseFixture({ page: 3 }));
    });

    it('[US4-AC8] propaga 400 VALIDATION_ERROR (workshopId que no es uuid) como Problem tipado', () => {
      const body = supportProblem(400, 'VALIDATION_ERROR', {
        errors: [{ field: 'workshopId', code: 'VALIDATION_ERROR', message: 'Debe ser un uuid' }],
      });
      let received: Problem | undefined;
      service
        .listAccessLog({ workshopId: 'no-es-uuid' })
        .subscribe({ error: (err: Problem) => (received = err) });

      httpMock
        .expectOne(
          (request) =>
            request.url === SUPPORT_ACCESS_LOG_URL && request.params.get('workshopId') === 'no-es-uuid',
        )
        .flush(body, problemFlush(400));

      expect(received).toEqual(body);
      expect(received?.code).toBe('VALIDATION_ERROR');
    });
  });
});
