// T051 (003, PR2, US3): SupportApiService.generateTemporaryPassword contra
// specs/003-soporte-plataforma/contracts/openapi.yaml (/support/tickets/{ticketId}/temporary-password).
//
// Contrato para el implementer-frontend (T052), archivo core/api/support-api.service.ts:
//   generateTemporaryPassword(
//     ticketId: string,
//     verificationNoteOrRequest: string | GenerateTemporaryPasswordRequest,
//   ): Observable<TemporaryPasswordResponse>
//   - POST /api/v1/support/tickets/:ticketId/temporary-password con body `{ verificationNote }` (200).
//   - Solo envía la clave `verificationNote` (nunca `userId` ni `tenantId`; US3-AC9).
//   - Errores con toProblem (Problem tipado o HttpErrorResponse ante fallo de red).
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Observable } from 'rxjs';
import { problemFlush } from '../../../testing/auth-fixtures';
import {
  SUPPORT_TEMP_PASSWORD,
  SUPPORT_TICKETS_URL,
  supportProblem,
  TICKET_ID,
  ticketDetailFixture,
  type GenerateTemporaryPasswordRequestFixture,
  type TemporaryPasswordResponseFixture,
} from '../../../testing/support-fixtures';
import type { Problem } from './api.models';
import { SupportApiService } from './support-api.service';

interface SupportApiWithTemporaryPassword {
  generateTemporaryPassword(
    ticketId: string,
    verificationNoteOrRequest: string | GenerateTemporaryPasswordRequestFixture,
  ): Observable<TemporaryPasswordResponseFixture>;
}

const VERIFICATION_NOTE = 'Videollamada por WhatsApp con cédula en mano y confirmación del RUC 1790012345001';
const TEMP_PASSWORD_URL = `${SUPPORT_TICKETS_URL}/${TICKET_ID}/temporary-password`;

function temporaryPasswordResponseFixture(
  overrides: Partial<TemporaryPasswordResponseFixture> = {},
): TemporaryPasswordResponseFixture {
  return {
    temporaryPassword: SUPPORT_TEMP_PASSWORD,
    temporaryPasswordExpiresAt: '2026-10-28T15:00:00.000Z',
    sessionsClosed: 2,
    ticket: ticketDetailFixture({
      id: TICKET_ID,
      status: 'resolved',
      resolution: {
        verificationNote: VERIFICATION_NOTE,
        resolvedByName: 'Pedro Soporte',
        resolvedAt: '2026-10-25T15:00:00.000Z',
      },
    }),
    ...overrides,
  };
}

describe('SupportApiService.generateTemporaryPassword (T051)', () => {
  let service: SupportApiWithTemporaryPassword;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SupportApiService) as unknown as SupportApiWithTemporaryPassword;
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('[US3-AC1][US3-AC2][US3-AC9] hace POST /api/v1/support/tickets/:ticketId/temporary-password con { verificationNote } y devuelve TemporaryPasswordResponse (200)', () => {
    const response = temporaryPasswordResponseFixture();
    let result: TemporaryPasswordResponseFixture | undefined;

    service
      .generateTemporaryPassword(TICKET_ID, VERIFICATION_NOTE)
      .subscribe((res: TemporaryPasswordResponseFixture) => (result = res));

    const req = httpMock.expectOne(TEMP_PASSWORD_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ verificationNote: VERIFICATION_NOTE });
    expect(Object.keys(req.request.body as object)).toEqual(['verificationNote']);
    req.flush(response);

    expect(result).toEqual(response);
  });

  it('[US3-AC3] propaga 400 VALIDATION_ERROR con REQUIRED en verificationNote como Problem tipado', () => {
    const body = supportProblem(400, 'VALIDATION_ERROR', {
      errors: [{ field: 'verificationNote', code: 'REQUIRED', message: 'Campo obligatorio' }],
    });
    let received: unknown;

    service.generateTemporaryPassword(TICKET_ID, '   ').subscribe({ error: (err: unknown) => (received = err) });

    httpMock.expectOne(TEMP_PASSWORD_URL).flush(body, problemFlush(400));

    expect(received).toEqual(body);
    expect(received).not.toBeInstanceOf(HttpErrorResponse);
  });

  it('[US3-AC5][US3-AC8][US3-AC12] propaga 409 TICKET_NOT_OPEN, 409 ACCOUNT_INACTIVE y 404 NOT_FOUND como Problem tipado', () => {
    const notOpen = supportProblem(409, 'TICKET_NOT_OPEN');
    let notOpenReceived: Problem | undefined;
    service
      .generateTemporaryPassword(TICKET_ID, VERIFICATION_NOTE)
      .subscribe({ error: (err: Problem) => (notOpenReceived = err) });
    httpMock.expectOne(TEMP_PASSWORD_URL).flush(notOpen, problemFlush(409));
    expect(notOpenReceived).toEqual(notOpen);

    const inactive = supportProblem(409, 'ACCOUNT_INACTIVE');
    let inactiveReceived: Problem | undefined;
    service
      .generateTemporaryPassword(TICKET_ID, VERIFICATION_NOTE)
      .subscribe({ error: (err: Problem) => (inactiveReceived = err) });
    httpMock.expectOne(TEMP_PASSWORD_URL).flush(inactive, problemFlush(409));
    expect(inactiveReceived).toEqual(inactive);

    const notFound = supportProblem(404, 'NOT_FOUND');
    let notFoundReceived: Problem | undefined;
    service
      .generateTemporaryPassword(TICKET_ID, VERIFICATION_NOTE)
      .subscribe({ error: (err: Problem) => (notFoundReceived = err) });
    httpMock.expectOne(TEMP_PASSWORD_URL).flush(notFound, problemFlush(404));
    expect(notFoundReceived).toEqual(notFound);
  });

  it('[FR-009] un fallo de red (status 0) se propaga como HttpErrorResponse', () => {
    let received: unknown;
    service
      .generateTemporaryPassword(TICKET_ID, VERIFICATION_NOTE)
      .subscribe({ error: (err: unknown) => (received = err) });

    httpMock.expectOne(TEMP_PASSWORD_URL).error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

    expect(received).toBeInstanceOf(HttpErrorResponse);
  });
});
