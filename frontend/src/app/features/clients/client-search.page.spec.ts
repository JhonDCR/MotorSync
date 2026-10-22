// T033 (parte 1): búsqueda de clientes (US4-AC1, US4-AC2, FR-003 en la vista, SEARCH_TERM_TOO_SHORT).
// Según research R8, el componente se prueba con ClientsApiService simulado; R9 fija debounceTime(250) + switchMap.
//
// Contrato para el implementer (T034), archivo features/clients/client-search.page.ts:
//   export class ClientSearchPage (standalone), ruta `clients` en app.routes.ts (loadComponent).
//   La ruta `clients/new` (ClientFormPage) debe seguir resolviendo al formulario: declárela ANTES de `clients/:id`.
//   Usa ClientsApiService.search(q). q es el término sin espacios al inicio ni al final.
//   Mientras se escribe: debounceTime(250) y switchMap (una búsqueda nueva cancela la anterior). Un error no
//   detiene la búsqueda: la siguiente escritura vuelve a buscar.
//   Con menos de 2 caracteres (tras trim) no llama a la API; con 1 carácter muestra search-too-short.
//   Si la API responde 400 SEARCH_TERM_TOO_SHORT, también muestra search-too-short.
// Selectores (data-testid):
//   search-input       <input> del término (type="search")
//   client-result      un <a> por resultado, en el orden del servidor, href /clients/{id}; muestra displayName y
//                      documentNumber
//   search-empty       "Sin resultados" cuando items está vacío (solo tras una búsqueda hecha)
//   search-has-more    aviso con "más resultados" cuando hasMore es true (ausente si es false)
//   search-too-short   "Escriba al menos 2 caracteres"
//   search-error       mensaje si la búsqueda falla (por ejemplo, red)
//   new-client         <a> "Registrar cliente", href /clients/new
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, Subject, throwError } from 'rxjs';
import type { ClientDetail, ClientSearchResponse, ClientSummary, Problem } from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { routes } from '../../app.routes';
import { ClientDetailPage } from './client-detail.page';
import { ClientFormPage } from './client-form.page';
import { ClientSearchPage } from './client-search.page';

@Component({ template: '' })
class StubPage {}

const DEBOUNCE_MS = 250;

function summary(extra: Partial<ClientSummary> = {}): ClientSummary {
  return {
    id: '7d1f0c1e-3b8a-4a52-9a43-2f1d8e0b6c11',
    clientType: 'natural',
    documentType: 'cedula',
    documentNumber: '1712345678',
    displayName: 'José Andrés Núñez',
    phone: '0991234567',
    email: null,
    ...extra,
  };
}

const JOSE = summary();
const MARIA = summary({
  id: '0b9e7a51-6a0c-4f0e-8d1b-5c2a9e3f4d22',
  documentNumber: '1710034065',
  displayName: 'Maria Nunez',
});
const COMPANY = summary({
  id: '5c3a1f2e-8b7d-4c6e-9f0a-1b2c3d4e5f66',
  clientType: 'company',
  documentType: 'ruc',
  documentNumber: '1790012345001',
  displayName: 'Transportes Núñez S.A.',
});

function problem(status: number, code: Problem['code']): Problem {
  return { type: 'about:blank', title: 'Error', status, code };
}

const networkError = () => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: '/api/v1/clients/search' });

describe('ClientSearchPage (T033)', () => {
  let fixture: ComponentFixture<ClientSearchPage>;
  let api: { search: ReturnType<typeof vi.fn<ClientsApiService['search']>> };

  beforeEach(async () => {
    api = { search: vi.fn<ClientsApiService['search']>(() => of({ items: [], hasMore: false })) };
    await TestBed.configureTestingModule({
      imports: [ClientSearchPage],
      providers: [
        provideRouter([
          { path: 'clients/new', component: StubPage },
          { path: 'clients/:id', component: StubPage },
        ]),
        { provide: ClientsApiService, useValue: api },
      ],
    }).compileComponents();
    vi.useFakeTimers();
    fixture = TestBed.createComponent(ClientSearchPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- utilidades (comportamiento observable en el DOM) ---

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
  }

  function queryAll<T extends HTMLElement = HTMLElement>(testId: string): T[] {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<T>(`[data-testid="${testId}"]`));
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = query<T>(testId);
    if (element === null) {
      throw new Error(`No existe [data-testid="${testId}"]`);
    }
    return element;
  }

  function text(testId: string): string {
    return get(testId).textContent?.trim() ?? '';
  }

  /** Escribe en el buscador sin dejar pasar el debounce. */
  function type(value: string): void {
    const input = get<HTMLInputElement>('search-input');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function wait(ms: number): void {
    vi.advanceTimersByTime(ms);
    fixture.detectChanges();
  }

  /** Escribe y deja pasar el debounce completo. */
  function search(value: string): void {
    type(value);
    wait(DEBOUNCE_MS);
  }

  function respond(response: ClientSearchResponse): void {
    api.search.mockReturnValue(of(response));
  }

  const digitsOnly = (value: string) => value.replace(/[\s-]/g, '');

  // --- búsqueda mientras se escribe (R9) ---

  it('[US4-AC2] busca mientras se escribe con debounceTime(250): una sola llamada con el último término', () => {
    type('nu');
    wait(100);
    type('nun');
    wait(100);
    type('nunez');
    wait(DEBOUNCE_MS - 1);
    expect(api.search).not.toHaveBeenCalled();

    wait(1);
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith('nunez');
  });

  it('[US4-AC2] envía el término sin espacios al inicio ni al final', () => {
    search('  nunez  ');
    expect(api.search).toHaveBeenCalledWith('nunez');
  });

  it('[US4-AC2] una búsqueda nueva cancela la anterior (switchMap) y su respuesta tardía no se muestra', () => {
    const first = new Subject<ClientSearchResponse>();
    const second = new Subject<ClientSearchResponse>();
    api.search.mockReturnValueOnce(first).mockReturnValueOnce(second);

    search('nunez');
    expect(first.observed).toBe(true);

    search('perez');
    expect(api.search).toHaveBeenNthCalledWith(2, 'perez');
    expect(first.observed).toBe(false);

    second.next({ items: [MARIA], hasMore: false });
    second.complete();
    fixture.detectChanges();
    first.next({ items: [JOSE, COMPANY], hasMore: true });
    fixture.detectChanges();

    const results = queryAll('client-result');
    expect(results).toHaveLength(1);
    expect(results[0].textContent).toContain('Maria Nunez');
    expect(query('search-has-more')).toBeNull();
  });

  // --- US4-AC1 ---

  it('[US4-AC1] buscar por documento 1712345678 muestra a ese cliente como primer resultado', () => {
    respond({ items: [JOSE, MARIA], hasMore: false });
    search('1712345678');

    expect(api.search).toHaveBeenCalledWith('1712345678');
    const results = queryAll('client-result');
    expect(results).toHaveLength(2);
    expect(results[0].textContent).toContain('José Andrés Núñez');
    expect(results[0].textContent).toContain('1712345678');
  });

  it('[US4-AC1] buscar con guion (171234567-8) consulta el mismo documento y muestra al cliente primero', () => {
    respond({ items: [JOSE], hasMore: false });
    search('171234567-8');

    expect(api.search).toHaveBeenCalledTimes(1);
    expect(digitsOnly(api.search.mock.calls[0][0])).toBe('1712345678');
    expect(queryAll('client-result')[0].textContent).toContain('José Andrés Núñez');
  });

  // --- US4-AC2 ---

  it('[US4-AC2] buscar "nunez" muestra con y sin tildes, y empresas por razón social, en el orden del servidor', () => {
    respond({ items: [JOSE, MARIA, COMPANY], hasMore: false });
    search('nunez');

    const results = queryAll('client-result');
    expect(results.map((r) => r.textContent?.trim() ?? '')).toEqual([
      expect.stringContaining('José Andrés Núñez'),
      expect.stringContaining('Maria Nunez'),
      expect.stringContaining('Transportes Núñez S.A.'),
    ]);
  });

  it('[US4-AC3] cada resultado enlaza a la ficha del cliente /clients/{id}', () => {
    respond({ items: [JOSE, MARIA], hasMore: false });
    search('nunez');

    const links = queryAll<HTMLAnchorElement>('client-result');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/clients/${JOSE.id}`, `/clients/${MARIA.id}`]);
  });

  // --- FR-003: límite de 20 y aviso de más resultados ---

  it('[FR-003] con hasMore true muestra el aviso de "más resultados"', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      summary({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, displayName: `Cliente Nunez ${i}` }),
    );
    respond({ items, hasMore: true });
    search('nunez');

    expect(queryAll('client-result')).toHaveLength(20);
    expect(text('search-has-more')).toMatch(/más resultados/i);
  });

  it('[FR-003] con hasMore false no muestra el aviso de "más resultados"', () => {
    respond({ items: [JOSE], hasMore: false });
    search('nunez');

    expect(queryAll('client-result')).toHaveLength(1);
    expect(query('search-has-more')).toBeNull();
  });

  // --- estado vacío ---

  it('[US4-AC2] sin coincidencias muestra "Sin resultados"', () => {
    respond({ items: [], hasMore: false });
    search('zzzz');

    expect(queryAll('client-result')).toHaveLength(0);
    expect(text('search-empty')).toMatch(/sin resultados/i);
  });

  it('[US4-AC2] antes de buscar no muestra "Sin resultados" ni resultados', () => {
    expect(query('search-empty')).toBeNull();
    expect(queryAll('client-result')).toHaveLength(0);
  });

  // --- término demasiado corto (SEARCH_TERM_TOO_SHORT) ---

  it('[SEARCH_TERM_TOO_SHORT] con 1 carácter no llama a la API y pide al menos 2 caracteres', () => {
    search('n');

    expect(api.search).not.toHaveBeenCalled();
    expect(text('search-too-short')).toContain('Escriba al menos 2 caracteres');
    expect(query('search-empty')).toBeNull();
  });

  it('[SEARCH_TERM_TOO_SHORT] un carácter rodeado de espacios cuenta como 1 carácter y no llama a la API', () => {
    search('  n  ');
    expect(api.search).not.toHaveBeenCalled();
    expect(query('search-too-short')).not.toBeNull();
  });

  it('[SEARCH_TERM_TOO_SHORT] al acortar el término por debajo de 2 caracteres se ocultan los resultados anteriores', () => {
    respond({ items: [JOSE], hasMore: true });
    search('nunez');
    expect(queryAll('client-result')).toHaveLength(1);

    search('n');
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(queryAll('client-result')).toHaveLength(0);
    expect(query('search-has-more')).toBeNull();
    expect(query('search-too-short')).not.toBeNull();
  });

  it('[SEARCH_TERM_TOO_SHORT] con el campo vacío no llama a la API ni muestra mensajes', () => {
    search('nu');
    search('');
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(query('search-too-short')).toBeNull();
    expect(query('search-empty')).toBeNull();
  });

  it('[SEARCH_TERM_TOO_SHORT] si el servidor responde 400 SEARCH_TERM_TOO_SHORT muestra "Escriba al menos 2 caracteres"', () => {
    api.search.mockReturnValue(throwError(() => problem(400, 'SEARCH_TERM_TOO_SHORT')));
    search('--');

    expect(text('search-too-short')).toContain('Escriba al menos 2 caracteres');
    expect(queryAll('client-result')).toHaveLength(0);
  });

  // --- errores ---

  it('[edge case conexión inestable] un fallo de red muestra un mensaje y la siguiente escritura vuelve a buscar', () => {
    api.search.mockReturnValueOnce(throwError(networkError));
    search('nunez');
    expect(query('search-error')).not.toBeNull();

    respond({ items: [MARIA], hasMore: false });
    search('nune');
    expect(api.search).toHaveBeenCalledTimes(2);
    expect(query('search-error')).toBeNull();
    expect(queryAll('client-result')).toHaveLength(1);
  });

  // --- acción "Registrar cliente" ---

  it('[US2] ofrece "Registrar cliente" que enlaza y navega a /clients/new', async () => {
    const link = get<HTMLAnchorElement>('new-client');
    expect(link.textContent).toContain('Registrar cliente');
    expect(link.getAttribute('href')).toBe('/clients/new');

    vi.useRealTimers();
    link.click();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/clients/new');
  });
});

describe('Rutas de clientes en app.routes (T033/T034)', () => {
  const DETAIL: ClientDetail = {
    ...summary(),
    firstNames: 'José Andrés',
    lastNames: 'Núñez',
    businessName: null,
    version: 1,
    vehicles: [],
    createdAt: '2026-10-21T15:00:00.000Z',
    updatedAt: '2026-10-21T15:00:00.000Z',
    updatedBy: '11111111-1111-4111-8111-111111111111',
    updatedByName: 'Asesor Uno',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        {
          provide: ClientsApiService,
          useValue: {
            create: vi.fn(() => of(DETAIL)),
            getById: vi.fn(() => of(DETAIL)),
            search: vi.fn(() => of({ items: [], hasMore: false })),
          },
        },
      ],
    });
  });

  it('[US4-AC1] /clients abre la búsqueda de clientes', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/clients');
    expect(page).toBeInstanceOf(ClientSearchPage);
  });

  it('[US4-AC3] /clients/:id abre la ficha del cliente', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl(`/clients/${DETAIL.id}`);
    expect(page).toBeInstanceOf(ClientDetailPage);
  });

  it('[US2] /clients/new sigue abriendo el formulario y no la ficha', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('/clients/new');
    expect(page).toBeInstanceOf(ClientFormPage);
  });
});
