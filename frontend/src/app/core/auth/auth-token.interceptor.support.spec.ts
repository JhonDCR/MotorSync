// T037 (003, PR1, US2): separación estricta de tokens en authTokenInterceptor (research R4, FR-008).
//
// Contrato para el implementer-frontend (T038), archivo core/auth/auth-token.interceptor.ts:
//   - Para peticiones a `/api/v1/support/**` (relativas o con origen): adjunta `Authorization: Bearer <support token>`
//     leído de `localStorage.getItem('motorsync.support.token')`. Si solo existe `motorsync.token` (taller), NO
//     adjunta cabecera `Authorization` a `/api/v1/support/**`.
//   - Para el resto de peticiones (`/api/v1/vehicles/**`, `/api/v1/clients/**`, `/api/v1/users/**`, `/api/v1/auth/**`):
//     adjunta `Authorization: Bearer <workshop token>` leído de `localStorage.getItem('motorsync.token')`. Si solo
//     existe `motorsync.support.token`, NO adjunta cabecera `Authorization` a las rutas de taller.
//   - Nunca mezcla ni envía ambos tokens.
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ME_URL } from '../../../testing/auth-fixtures';
import {
  SUPPORT_ME_URL,
  SUPPORT_TICKETS_URL,
  SUPPORT_TOKEN_STORAGE_KEY,
} from '../../../testing/support-fixtures';
import { AUTH_TOKEN_STORAGE_KEY, authTokenInterceptor } from './auth-token.interceptor';

const WORKSHOP_TOKEN = 'jwt.taller.activo';
const SUPPORT_TOKEN = 'jwt.soporte.activo';

describe('authTokenInterceptor — separación de tokens de taller y de soporte (T037)', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authTokenInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
    localStorage.clear();
  });

  it('[US2-AC5][FR-008] cuando existen ambos tokens en localStorage, envía motorsync.support.token a /api/v1/support/** y motorsync.token a rutas del taller', () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, WORKSHOP_TOKEN);
    localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, SUPPORT_TOKEN);

    http.get(SUPPORT_TICKETS_URL).subscribe();
    http.get(SUPPORT_ME_URL).subscribe();
    http.get('/api/v1/vehicles/search?q=PBA1234').subscribe();
    http.get(ME_URL).subscribe();

    const supportTicketsReq = httpMock.expectOne(SUPPORT_TICKETS_URL);
    expect(supportTicketsReq.request.headers.get('Authorization')).toBe(`Bearer ${SUPPORT_TOKEN}`);
    supportTicketsReq.flush({ items: [] });

    const supportMeReq = httpMock.expectOne(SUPPORT_ME_URL);
    expect(supportMeReq.request.headers.get('Authorization')).toBe(`Bearer ${SUPPORT_TOKEN}`);
    supportMeReq.flush({});

    const vehiclesReq = httpMock.expectOne('/api/v1/vehicles/search?q=PBA1234');
    expect(vehiclesReq.request.headers.get('Authorization')).toBe(`Bearer ${WORKSHOP_TOKEN}`);
    vehiclesReq.flush({ items: [], hasMore: false });

    const workshopMeReq = httpMock.expectOne(ME_URL);
    expect(workshopMeReq.request.headers.get('Authorization')).toBe(`Bearer ${WORKSHOP_TOKEN}`);
    workshopMeReq.flush({});
  });

  it('[US2-AC5][FR-008] si solo existe motorsync.token (taller), las peticiones a /api/v1/support/** van SIN cabecera Authorization', () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, WORKSHOP_TOKEN);

    http.get(SUPPORT_TICKETS_URL).subscribe();

    const req = httpMock.expectOne(SUPPORT_TICKETS_URL);
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({ items: [] });
  });

  it('[US2-AC5][FR-008] si solo existe motorsync.support.token (soporte), las peticiones a rutas de taller van SIN cabecera Authorization', () => {
    localStorage.setItem(SUPPORT_TOKEN_STORAGE_KEY, SUPPORT_TOKEN);

    http.get('/api/v1/clients/search?q=ana').subscribe();
    http.get('/api/v1/users').subscribe();

    const clientsReq = httpMock.expectOne('/api/v1/clients/search?q=ana');
    expect(clientsReq.request.headers.has('Authorization')).toBe(false);
    clientsReq.flush({ items: [], hasMore: false });

    const usersReq = httpMock.expectOne('/api/v1/users');
    expect(usersReq.request.headers.has('Authorization')).toBe(false);
    usersReq.flush({ items: [] });
  });
});
