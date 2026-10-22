// T055: búsqueda de vehículos por placa o VIN (US1-AC1 a US1-AC8 en la vista, FR-026).
// Según research R8, el componente se prueba con VehiclesApiService simulado; R9 fija debounceTime(250) + switchMap.
//
// Contrato para el implementer (T056), archivo features/vehicles/vehicle-search.page.ts:
//   export class VehicleSearchPage (standalone), ruta '' (pathMatch: 'full') en app.routes.ts (loadComponent).
//   Usa VehiclesApiService.search(q). q es el término normalizado con normalizePlateForSearch
//   (shared/identifiers/plate.ts): mayúsculas y solo [A-Z0-9]. Sirve igual para placa y para VIN completo.
//   Mientras se escribe: debounceTime(250) y switchMap (una búsqueda nueva cancela la anterior). Un error no
//   detiene la búsqueda: la siguiente escritura vuelve a buscar.
//   Campo vacío (o solo espacios): no llama a la API ni muestra mensajes.
//   Con menos de 2 caracteres tras normalizar (p. ej. "P", "*%", "p-"): no llama a la API y muestra
//   search-too-short. Si la API responde 400 SEARCH_TERM_TOO_SHORT, también lo muestra.
// Selectores (data-testid):
//   search-input       <input> del término, type="search", inputmode="text", autocapitalize="characters"
//   vehicle-result     un <a> por resultado, en el orden del servidor, href /vehicles/{id}. Muestra placa, marca,
//                      modelo, año, color, carrocería en español (BODY_TYPE_LABELS de body-type.ts), kilometraje y,
//                      del propietario, displayName, documentNumber, phone y email (si no es null)
//   search-has-more    aviso con "más resultados" cuando hasMore es true (ausente si es false)
//   search-empty       "No se encontró ningún vehículo" cuando items está vacío (solo tras una búsqueda hecha)
//   register-vehicle   <a> "Registrar vehículo", href /vehicles/new?plate=<término normalizado>. Solo con
//                      search-empty y si el término normalizado tiene forma de placa completa de auto (ABC1234,
//                      ABC123) o de moto (AB123C), según isValidPlate. Con un fragmento o un VIN no aparece.
//   search-too-short   "Escriba al menos 2 caracteres"
//   search-error       mensaje si la búsqueda falla (por ejemplo, red)
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, Subject, throwError } from 'rxjs';
import type { Problem, VehicleSearchItem, VehicleSearchResponse } from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { routes } from '../../app.routes';
import { VehicleSearchPage } from './vehicle-search.page';

@Component({ template: '' })
class StubPage {}

const DEBOUNCE_MS = 250;
const VIN = '1HGCM82633A004352';

function item(extra: Partial<VehicleSearchItem> = {}): VehicleSearchItem {
  return {
    id: '3f6b2a10-1c4d-4e8f-9a7b-6c5d4e3f2a11',
    plate: 'PBA1234',
    brand: 'Toyota',
    model: 'Corolla',
    year: 2020,
    vin: VIN,
    color: 'Blanco',
    bodyType: 'sedan',
    initialMileage: 45200,
    owner: {
      id: '7d1f0c1e-3b8a-4a52-9a43-2f1d8e0b6c11',
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: '1712345678',
      displayName: 'José Andrés Núñez',
      phone: '0991234567',
      email: 'jose.nunez@example.com',
    },
    ...extra,
  };
}

const PBA1234 = item();
const PBA1299 = item({
  id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c22',
  plate: 'PBA1299',
  brand: 'Kia',
  model: 'Rio',
  year: 2017,
  vin: null,
  color: 'Rojo',
  bodyType: 'suv',
  initialMileage: 120500,
});
const MOTO = item({
  id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d33',
  plate: 'BA123C',
  brand: 'Yamaha',
  model: 'FZ25',
  year: 2023,
  vin: null,
  color: 'Azul',
  bodyType: 'motorcycle',
  initialMileage: 3500,
});

function problem(status: number, code: Problem['code']): Problem {
  return { type: 'about:blank', title: 'Error', status, code };
}

const networkError = () => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: '/api/v1/vehicles/search' });

/** Text without thousands separators, so that 45200 matches "45200", "45.200" or "45 200". */
const digitsOf = (value: string | null | undefined) => (value ?? '').replace(/(\d)[.,\s](?=\d{3})/g, '$1');

describe('VehicleSearchPage (T055)', () => {
  let fixture: ComponentFixture<VehicleSearchPage>;
  let api: { search: ReturnType<typeof vi.fn<VehiclesApiService['search']>> };

  beforeEach(async () => {
    api = { search: vi.fn<VehiclesApiService['search']>(() => of({ items: [], hasMore: false })) };
    await TestBed.configureTestingModule({
      imports: [VehicleSearchPage],
      providers: [
        provideRouter([
          { path: 'vehicles/new', component: StubPage },
          { path: 'vehicles/:id', component: StubPage },
        ]),
        { provide: VehiclesApiService, useValue: api },
      ],
    }).compileComponents();
    vi.useFakeTimers();
    fixture = TestBed.createComponent(VehicleSearchPage);
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

  function respond(response: VehicleSearchResponse): void {
    api.search.mockReturnValue(of(response));
  }

  // --- campo de búsqueda (FR-025, FR-026) ---

  it('[FR-026] el campo de búsqueda es type="search" con inputmode="text" y autocapitalize="characters"', () => {
    const input = get<HTMLInputElement>('search-input');
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('type')).toBe('search');
    expect(input.getAttribute('inputmode')).toBe('text');
    expect(input.getAttribute('autocapitalize')).toBe('characters');
  });

  // --- búsqueda mientras se escribe (FR-026, R9) ---

  it('[FR-026] busca mientras se escribe con debounceTime(250): una sola llamada con el último término', () => {
    type('pb');
    wait(100);
    type('pba');
    wait(100);
    type('pba1');
    wait(DEBOUNCE_MS - 1);
    expect(api.search).not.toHaveBeenCalled();

    wait(1);
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith('PBA1');
  });

  it('[FR-026] una búsqueda nueva cancela la anterior (switchMap) y su respuesta tardía no se muestra', () => {
    const first = new Subject<VehicleSearchResponse>();
    const second = new Subject<VehicleSearchResponse>();
    api.search.mockReturnValueOnce(first).mockReturnValueOnce(second);

    search('BA12');
    expect(first.observed).toBe(true);

    search('PBA129');
    expect(api.search).toHaveBeenNthCalledWith(2, 'PBA129');
    expect(first.observed).toBe(false);

    second.next({ items: [PBA1299], hasMore: false });
    second.complete();
    fixture.detectChanges();
    first.next({ items: [PBA1234, PBA1299], hasMore: true });
    fixture.detectChanges();

    const results = queryAll('vehicle-result');
    expect(results).toHaveLength(1);
    expect(results[0].textContent).toContain('PBA1299');
    expect(query('search-has-more')).toBeNull();
  });

  // --- US1-AC1 ---

  it('[US1-AC1] buscar PBA1234 muestra la tarjeta con los datos del vehículo y del propietario', () => {
    respond({ items: [PBA1234], hasMore: false });
    search('PBA1234');

    expect(api.search).toHaveBeenCalledWith('PBA1234');
    const results = queryAll('vehicle-result');
    expect(results).toHaveLength(1);
    const card = results[0].textContent ?? '';
    for (const expected of [
      'PBA1234',
      'Toyota',
      'Corolla',
      '2020',
      'Blanco',
      'Sedán',
      'José Andrés Núñez',
      '1712345678',
      '0991234567',
      'jose.nunez@example.com',
    ]) {
      expect(card).toContain(expected);
    }
    expect(digitsOf(card)).toContain('45200');
  });

  it('[US1-AC1] muestra los resultados en el orden del servidor, con la carrocería en español', () => {
    respond({ items: [MOTO, PBA1234, PBA1299], hasMore: false });
    search('BA12');

    const results = queryAll('vehicle-result');
    expect(results.map((r) => r.textContent ?? '')).toEqual([
      expect.stringContaining('BA123C'),
      expect.stringContaining('PBA1234'),
      expect.stringContaining('PBA1299'),
    ]);
    expect(results[0].textContent).toContain('Moto');
    expect(results[2].textContent).toContain('SUV');
  });

  it('[US1-AC1] cada resultado enlaza a la ficha del vehículo /vehicles/{id}', () => {
    respond({ items: [PBA1234, PBA1299], hasMore: false });
    search('BA12');

    const links = queryAll<HTMLAnchorElement>('vehicle-result');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([`/vehicles/${PBA1234.id}`, `/vehicles/${PBA1299.id}`]);
  });

  // --- US1-AC2 ---

  it.each(['pba-1234', 'PBA 1234', ' pba1234 '])('[US1-AC2] "%s" se normaliza a PBA1234 antes de buscar', (raw) => {
    respond({ items: [PBA1234], hasMore: false });
    search(raw);

    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith('PBA1234');
    expect(queryAll('vehicle-result')[0].textContent).toContain('PBA1234');
  });

  it('[FR-002] en la búsqueda los símbolos se descartan: PBA*12 busca PBA12', () => {
    search('PBA*12');
    expect(api.search).toHaveBeenCalledWith('PBA12');
  });

  // --- US1-AC4 ---

  it('[US1-AC4] con hasMore true muestra el aviso de "más resultados"', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, plate: `ABC${1000 + i}` }),
    );
    respond({ items, hasMore: true });
    search('ABC10');

    expect(queryAll('vehicle-result')).toHaveLength(20);
    expect(text('search-has-more')).toMatch(/más resultados/i);
  });

  it('[US1-AC4] con hasMore false no muestra el aviso de "más resultados"', () => {
    respond({ items: [PBA1234], hasMore: false });
    search('PBA1234');

    expect(queryAll('vehicle-result')).toHaveLength(1);
    expect(query('search-has-more')).toBeNull();
  });

  // --- US1-AC5 ---

  it.each(['P', 'p-', '*%', '  p  '])('[US1-AC5] con "%s" (menos de 2 caracteres válidos) no llama a la API y lo indica', (raw) => {
    search(raw);

    expect(api.search).not.toHaveBeenCalled();
    expect(text('search-too-short')).toContain('Escriba al menos 2 caracteres');
    expect(query('search-empty')).toBeNull();
  });

  it('[US1-AC5] al acortar el término por debajo de 2 caracteres se ocultan los resultados anteriores', () => {
    respond({ items: [PBA1234], hasMore: true });
    search('PBA1234');
    expect(queryAll('vehicle-result')).toHaveLength(1);

    search('P');
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(queryAll('vehicle-result')).toHaveLength(0);
    expect(query('search-has-more')).toBeNull();
    expect(query('search-too-short')).not.toBeNull();
  });

  it('[US1-AC5] con el campo vacío no llama a la API ni muestra mensajes', () => {
    search('PB');
    search('');
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(query('search-too-short')).toBeNull();
    expect(query('search-empty')).toBeNull();
    expect(query('register-vehicle')).toBeNull();
  });

  it('[US1-AC5] si el servidor responde 400 SEARCH_TERM_TOO_SHORT muestra "Escriba al menos 2 caracteres"', () => {
    api.search.mockReturnValue(throwError(() => problem(400, 'SEARCH_TERM_TOO_SHORT')));
    search('PB');

    expect(text('search-too-short')).toContain('Escriba al menos 2 caracteres');
    expect(queryAll('vehicle-result')).toHaveLength(0);
  });

  // --- US1-AC6 ---

  it('[US1-AC6] antes de buscar no muestra "No se encontró ningún vehículo" ni la acción de registrar', () => {
    expect(query('search-empty')).toBeNull();
    expect(query('register-vehicle')).toBeNull();
    expect(queryAll('vehicle-result')).toHaveLength(0);
  });

  it('[US1-AC6] una placa completa de auto sin resultados muestra el mensaje y "Registrar vehículo" con la placa normalizada', () => {
    search('gye-0123');

    expect(api.search).toHaveBeenCalledWith('GYE0123');
    expect(text('search-empty')).toContain('No se encontró ningún vehículo');
    const register = get<HTMLAnchorElement>('register-vehicle');
    expect(register.textContent).toContain('Registrar vehículo');
    expect(register.getAttribute('href')).toBe('/vehicles/new?plate=GYE0123');
  });

  it('[US1-AC6] una placa de auto de 3 dígitos sin resultados también ofrece "Registrar vehículo"', () => {
    search('abc 123');

    expect(get<HTMLAnchorElement>('register-vehicle').getAttribute('href')).toBe('/vehicles/new?plate=ABC123');
  });

  it('[US1-AC6] una placa completa de moto sin resultados ofrece "Registrar vehículo" con la placa normalizada', () => {
    search('ab-123-c');

    expect(text('search-empty')).toContain('No se encontró ningún vehículo');
    expect(get<HTMLAnchorElement>('register-vehicle').getAttribute('href')).toBe('/vehicles/new?plate=AB123C');
  });

  it('[US1-AC6] "Registrar vehículo" navega a vehicles/new?plate=<normalizada>', async () => {
    search('pba 1234');
    const link = get<HTMLAnchorElement>('register-vehicle');

    vi.useRealTimers();
    link.click();
    await fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/vehicles/new?plate=PBA1234');
  });

  it('[US1-AC6] con un fragmento sin resultados solo se muestra el mensaje, sin "Registrar vehículo"', () => {
    search('BA12');

    expect(text('search-empty')).toContain('No se encontró ningún vehículo');
    expect(query('register-vehicle')).toBeNull();
  });

  it('[US1-AC6] con resultados no se muestra el mensaje ni "Registrar vehículo"', () => {
    respond({ items: [PBA1234], hasMore: false });
    search('PBA1234');

    expect(query('search-empty')).toBeNull();
    expect(query('register-vehicle')).toBeNull();
  });

  // --- US1-AC7: VIN completo ---

  it('[US1-AC7] buscar por el VIN completo (minúsculas, con guion) consulta el VIN normalizado y muestra el vehículo', () => {
    respond({ items: [PBA1234], hasMore: false });
    search(`${VIN.slice(0, 8).toLowerCase()}-${VIN.slice(8).toLowerCase()}`);

    expect(api.search).toHaveBeenCalledWith(VIN);
    const results = queryAll('vehicle-result');
    expect(results).toHaveLength(1);
    expect(results[0].textContent).toContain('PBA1234');
    expect(results[0].textContent).toContain('José Andrés Núñez');
  });

  it('[US1-AC7] un VIN sin resultados muestra el mensaje sin "Registrar vehículo" (no es una placa)', () => {
    search(VIN);

    expect(text('search-empty')).toContain('No se encontró ningún vehículo');
    expect(query('register-vehicle')).toBeNull();
  });

  // --- US1-AC8 (multi-tenant, vista) ---

  it('[US1-AC8] una placa de otro taller (items vacío) se ve exactamente igual que una inexistente', () => {
    // La API responde igual (200, items: []) para PBA1234 registrada solo en el taller B y para una placa que no existe.
    const root = fixture.nativeElement as HTMLElement;
    const render = (raw: string): string => {
      search(raw);
      return (root.textContent ?? '').replace(/\s+/g, ' ').trim();
    };

    const otherTenant = render('PBA1234');
    expect(text('search-empty')).toContain('No se encontró ningún vehículo');
    expect(query('search-error')).toBeNull();
    expect(otherTenant).not.toMatch(/acceso|denegad|permiso|otro taller/i);

    const missingPlate = render('PBA1235');
    expect(missingPlate).toBe(otherTenant);
    expect(get<HTMLAnchorElement>('register-vehicle').getAttribute('href')).toBe('/vehicles/new?plate=PBA1235');
  });

  it('[US1-AC8] un fragmento solo presente en otro taller muestra "No se encontró ningún vehículo"', () => {
    search('BA12');

    expect(queryAll('vehicle-result')).toHaveLength(0);
    expect(text('search-empty')).toContain('No se encontró ningún vehículo');
    expect(query('search-error')).toBeNull();
  });

  // --- errores ---

  it('[edge case conexión inestable] un fallo de red muestra un mensaje y la siguiente escritura vuelve a buscar', () => {
    api.search.mockReturnValueOnce(throwError(networkError));
    search('PBA1234');
    expect(query('search-error')).not.toBeNull();
    expect(query('search-empty')).toBeNull();

    respond({ items: [PBA1234], hasMore: false });
    search('PBA123');
    expect(api.search).toHaveBeenCalledTimes(2);
    expect(query('search-error')).toBeNull();
    expect(queryAll('vehicle-result')).toHaveLength(1);
  });
});

describe('Ruta de búsqueda de vehículos en app.routes (T055/T056)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        {
          provide: VehiclesApiService,
          useValue: {
            create: vi.fn(),
            getById: vi.fn(),
            search: vi.fn(() => of({ items: [], hasMore: false })),
          },
        },
        {
          provide: ClientsApiService,
          useValue: { create: vi.fn(), getById: vi.fn(), search: vi.fn(() => of({ items: [], hasMore: false })) },
        },
      ],
    });
  });

  it('[FR-026] la ruta inicial "" es la búsqueda por placa (sin redirigir)', async () => {
    const harness = await RouterTestingHarness.create();
    const page = await harness.navigateByUrl('');
    expect(TestBed.inject(Router).url).toBe('/');
    expect(page).toBeInstanceOf(VehicleSearchPage);
  });
});
