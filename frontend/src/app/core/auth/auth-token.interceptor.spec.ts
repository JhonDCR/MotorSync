import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AUTH_TOKEN_STORAGE_KEY, authTokenInterceptor } from './auth-token.interceptor';

// research.md R2: el token de desarrollo se pega en /dev-token y se guarda en localStorage.
// El interceptor lo lee en cada request (no lo cachea) y añade Authorization: Bearer <token>.
describe('authTokenInterceptor', () => {
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

  it('[FR-022] usa la clave de localStorage motorsync.token', () => {
    expect(AUTH_TOKEN_STORAGE_KEY).toBe('motorsync.token');
  });

  it('[FR-022] añade Authorization: Bearer con el token guardado', () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'abc.def.ghi');

    http.get('/api/v1/vehicles/search?q=PBA1234').subscribe();

    const req = httpMock.expectOne('/api/v1/vehicles/search?q=PBA1234');
    expect(req.request.headers.get('Authorization')).toBe('Bearer abc.def.ghi');
    req.flush({ items: [], hasMore: false });
  });

  it('[FR-022] lee el token en cada request (un token pegado después se usa sin recargar)', () => {
    http.get('/api/v1/clients/search?q=ana').subscribe();
    const first = httpMock.expectOne('/api/v1/clients/search?q=ana');
    expect(first.request.headers.has('Authorization')).toBe(false);
    first.flush({ items: [], hasMore: false });

    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'nuevo.token.jwt');
    http.get('/api/v1/clients/search?q=ana').subscribe();
    const second = httpMock.expectOne('/api/v1/clients/search?q=ana');
    expect(second.request.headers.get('Authorization')).toBe('Bearer nuevo.token.jwt');
    second.flush({ items: [], hasMore: false });
  });

  it('[FR-022] sin token guardado no añade la cabecera Authorization', () => {
    http.get('/api/v1/clients/search?q=ana').subscribe();

    const req = httpMock.expectOne('/api/v1/clients/search?q=ana');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({ items: [], hasMore: false });
  });

  it('[FR-022] con un token vacío o solo espacios no añade la cabecera Authorization', () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, '   ');

    http.get('/api/v1/clients/search?q=ana').subscribe();

    const req = httpMock.expectOne('/api/v1/clients/search?q=ana');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({ items: [], hasMore: false });
  });

  it('[FR-022] nunca envía X-Tenant-Id: el taller sale solo del token', () => {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'abc.def.ghi');

    http.post('/api/v1/clients', { type: 'natural' }).subscribe();

    const req = httpMock.expectOne('/api/v1/clients');
    expect(req.request.headers.has('X-Tenant-Id')).toBe(false);
    req.flush({});
  });
});
