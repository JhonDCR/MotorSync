// T049: formulario de nuevo vehículo (US3 + edge case "conexión inestable").
// Según research R8, el componente se prueba con VehiclesApiService y ClientsApiService simulados.
//
// Contrato para el implementer (T050), archivo features/vehicles/vehicle-form.page.ts:
//   export class VehicleFormPage (standalone), ruta `vehicles/new` en app.routes.ts (loadComponent), declarada
//   ANTES de `vehicles/:id`. Tras crear, navega a `/vehicles/{id}`.
//   Validadores de shared/validators/vehicle.validators.ts (T046); mensajes con fieldErrorMessage/problemMessage
//   de core/api/problem.ts (la placa con el contexto { bodyType } de la carrocería elegida).
//   VehiclesApiService (T048) y ClientsApiService (T026): los errores con cuerpo Problem llegan como el Problem;
//   los de red como HttpErrorResponse con status 0.
//
// Parámetros de consulta (se leen con ActivatedRoute al abrir el formulario):
//   ?plate=   precarga la placa, normalizada si se puede (US1-AC6 → US3-AC9)
//   ?clientId= preselecciona al propietario: ClientsApiService.getById(clientId). Un 404 deja el propietario
//             vacío y muestra error-ownerClientId "Cliente no encontrado".
//
// "Registrar cliente nuevo" sin perder lo escrito (US3-AC9). Mecanismo elegido: borrador en sessionStorage.
//   1. register-new-client guarda el valor del formulario (plate, vin, brand, model, year, color, bodyType,
//      initialMileage) en sessionStorage, clave 'motorsync.vehicle-form-draft', y navega a
//      /clients/new?returnTo=/vehicles/new.
//   2. ClientFormPage (cambio en T050, pruebas en client-form.page.spec.ts) acepta ?returnTo= solo si es una ruta
//      interna (empieza por "/" y no por "//"); tras crear el cliente navega a {returnTo}?clientId={id} en lugar de
//      a /clients/{id}. Con returnTo muestra además cancel-return, un <a> con href {returnTo} para volver sin crear.
//   3. Al abrir /vehicles/new, si hay borrador, VehicleFormPage lo restaura y lo borra de sessionStorage (se usa una
//      sola vez). Después aplica ?plate= y ?clientId=, que tienen prioridad sobre el borrador. Un guardado con
//      éxito también borra el borrador.
//
// Selectores (data-testid):
//   plate, vin, brand, model, year, color, initial-mileage   <input> (placa y VIN con autocapitalize="characters")
//   body-type             <select> con exactamente estas opciones y en este orden: Sedán (sedan), SUV (suv),
//                         Pickup (pickup), Moto (motorcycle), Otro (other). Por defecto: Sedán.
//   owner-search          <input> para buscar el propietario por documento o nombre
//   owner-search-button   botón que llama a ClientsApiService.search(<término sin espacios al inicio ni al final>)
//   owner-option          un botón por resultado, con displayName y documentNumber; al pulsarlo se elige
//   owner-no-results      "No se encontró ningún cliente" si la búsqueda no devuelve resultados
//   owner-selected        propietario elegido: displayName y documentNumber (owner-search y owner-option no se
//                         muestran mientras hay propietario elegido)
//   owner-change          botón que quita el propietario elegido y vuelve a mostrar owner-search
//   register-new-client   acción "Registrar cliente nuevo" (visible al menos mientras no hay propietario elegido)
//   save                  botón Guardar (submit del formulario)
//   error-<campo>         mensaje junto al campo, <campo> con el nombre del contrato: error-plate, error-vin,
//                         error-brand, error-model, error-year, error-color, error-bodyType, error-initialMileage,
//                         error-ownerClientId. El <input> con error lleva aria-invalid="true". Los errores se muestran
//                         cuando el campo se tocó (blur) o tras intentar guardar.
//   duplicate-message + open-existing-vehicle   409 PLATE_ALREADY_EXISTS / VIN_ALREADY_EXISTS: mensaje y <a>
//                         "Abrir vehículo existente" con href /vehicles/{existingId}
//   network-error + retry fallo de red (status 0): mensaje y botón "Reintentar"
// Al perder el foco, plate (y vin) muestran el valor normalizado si la normalización no falla (US3-AC2).
// Al cambiar body-type se revalida la placa con el formato de la nueva carrocería (US3-AC14).
// Cuerpo enviado (VehicleCreate): plate y vin normalizados (vin vacío → null), brand/model/color sin espacios al
// inicio ni al final, year e initialMileage como number, sin tenantId.
//
// T080 (PR3, US4): modo edición, contrato para el implementer (T081).
//   Ruta `vehicles/:id/edit` en app.routes.ts (loadComponent de VehicleFormPage, title "Editar vehículo"), declarada
//   ANTES de `vehicles/:id`. El id sale del parámetro de ruta `id`. En `vehicles/new` nada cambia.
//   Al abrir: VehiclesApiService.getById(id) y precarga plate, vin (null → ''), brand, model, year, color, body-type
//   e initial-mileage. El <h1> dice "Editar vehículo". El propietario se muestra en owner-selected (displayName y
//   documento) pero NO se cambia aquí (se usa la transferencia de la ficha): no se renderizan owner-search,
//   owner-change ni register-new-client.
//   Guardar llama a VehiclesApiService.update(id, body: VehicleUpdate) (nunca a create) y navega a /vehicles/{id}.
//   body: version = la cargada; campos normalizados como en el alta (plate y vin normalizados, vin '' → null, year e
//   initialMileage como number). Puede llevar campos sin cambios, pero nunca ownerClientId ni tenantId. Si plate o
//   vin van en el body y no cambiaron, son los valores guardados.
//   Motivo (FR-019): el campo `reason` (<textarea>, label con "Motivo" y "obligatorio"/"opcional") aparece SOLO si la
//   placa o el VIN, comparados ya normalizados, difieren de lo guardado (pba-1234 = PBA1234; '' = null; quitar un VIN
//   guardado sí es un cambio). Reglas del rol (current-session), recorte, error-reason y mensaje: iguales que en
//   client-form.page.spec.ts (asesor o sin sesión: obligatorio; admin: opcional; si se informa, 10 a 500).
//   La placa se revalida con la carrocería elegida (US3-AC14) igual que en el alta.
//   409 VERSION_CONFLICT: version-conflict (role="alert") con "El registro cambió", el formulario se rellena con
//   problem.current y el siguiente guardado usa esa versión. 409 PLATE/VIN_ALREADY_EXISTS: como en el alta.
//   404 al cargar: load-error con "No se encontró ningún vehículo" y sin botón save.
//   US4-AC17: ningún botón ni enlace para eliminar, borrar ni desactivar.
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError, type Observable } from 'rxjs';
import type {
  ClientDetail,
  ClientSearchResponse,
  ClientSummary,
  Problem,
  VehicleCreate,
  VehicleDetail,
  VehicleUpdate,
} from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { signInAs, signOut } from '../../../testing/fake-jwt';
import { VehicleFormPage } from './vehicle-form.page';

@Component({ template: '' })
class StubPage {}

const OWNER_ID = '7d1f0c1e-3b8a-4a52-9a43-2f1d8e0b6c11';
const NEW_CLIENT_ID = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const VEHICLE_ID = 'b2222222-2222-4222-8222-222222222222';
const EXISTING_ID = 'c3333333-3333-4333-8333-333333333333';

const CAR_PLATE_MESSAGE = 'Placa inválida: para autos use 3 letras y 3 o 4 dígitos (ej. PBA1234)';
const MOTORCYCLE_PLATE_MESSAGE = 'Placa inválida: para motos use 2 letras, 3 dígitos y 1 letra (ej. AB123C)';

function owner(extra: Partial<ClientSummary> = {}): ClientSummary {
  return {
    id: OWNER_ID,
    clientType: 'natural',
    documentType: 'cedula',
    documentNumber: '1710034065',
    displayName: 'Ana Pérez',
    phone: '0991234567',
    email: null,
    ...extra,
  };
}

function clientDetail(extra: Partial<ClientDetail> = {}): ClientDetail {
  return {
    ...owner(),
    firstNames: 'Ana',
    lastNames: 'Pérez',
    businessName: null,
    version: 1,
    vehicles: [],
    createdAt: '2026-10-21T15:00:00.000Z',
    updatedAt: '2026-10-21T15:00:00.000Z',
    updatedBy: '11111111-1111-4111-8111-111111111111',
    updatedByName: 'Asesor Uno',
    ...extra,
  };
}

const VEHICLE: VehicleDetail = {
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
  owner: owner(),
  createdAt: '2026-10-21T15:00:00.000Z',
  updatedAt: '2026-10-21T15:00:00.000Z',
  updatedBy: '11111111-1111-4111-8111-111111111111',
  updatedByName: 'Asesor Uno',
};

const SEARCH_RESULTS: ClientSearchResponse = {
  items: [
    owner(),
    owner({ id: NEW_CLIENT_ID, documentNumber: '0912345675', displayName: 'Carlos Ruiz' }),
  ],
  hasMore: false,
};

function problem(status: number, code: Problem['code'], extra: Partial<Problem> = {}): Problem {
  return { type: 'about:blank', title: 'Error', status, code, ...extra };
}

const networkError = () => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: '/api/v1/vehicles' });

describe('VehicleFormPage (T049)', () => {
  let harness: RouterTestingHarness;
  let vehiclesApi: {
    create: ReturnType<typeof vi.fn<VehiclesApiService['create']>>;
    getById: ReturnType<typeof vi.fn<VehiclesApiService['getById']>>;
    search: ReturnType<typeof vi.fn<VehiclesApiService['search']>>;
  };
  let clientsApi: {
    create: ReturnType<typeof vi.fn<ClientsApiService['create']>>;
    getById: ReturnType<typeof vi.fn<ClientsApiService['getById']>>;
    search: ReturnType<typeof vi.fn<ClientsApiService['search']>>;
  };

  beforeEach(async () => {
    sessionStorage.clear();
    vehiclesApi = {
      create: vi.fn<VehiclesApiService['create']>(() => of(VEHICLE)),
      getById: vi.fn<VehiclesApiService['getById']>(() => of(VEHICLE)),
      search: vi.fn<VehiclesApiService['search']>(() => of({ items: [], hasMore: false })),
    };
    clientsApi = {
      create: vi.fn<ClientsApiService['create']>(() => of(clientDetail())),
      getById: vi.fn<ClientsApiService['getById']>(() => of(clientDetail())),
      search: vi.fn<ClientsApiService['search']>(() => of(SEARCH_RESULTS)),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'clients', component: StubPage },
          { path: 'clients/new', component: StubPage },
          { path: 'clients/:id', component: StubPage },
          { path: 'vehicles/new', component: VehicleFormPage },
          { path: 'vehicles/:id', component: StubPage },
        ]),
        { provide: VehiclesApiService, useValue: vehiclesApi },
        { provide: ClientsApiService, useValue: clientsApi },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
  });

  // --- utilidades de interacción (comportamiento observable en el DOM) ---

  async function open(url = '/vehicles/new'): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
  }

  async function settle(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  function root(): HTMLElement {
    return harness.routeNativeElement ?? (harness.fixture.nativeElement as HTMLElement);
  }

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return root().querySelector<T>(`[data-testid="${testId}"]`);
  }

  function queryAll<T extends HTMLElement = HTMLElement>(testId: string): T[] {
    return Array.from(root().querySelectorAll<T>(`[data-testid="${testId}"]`));
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = query<T>(testId);
    if (element === null) {
      throw new Error(`No existe [data-testid="${testId}"]`);
    }
    return element;
  }

  function text(testId: string): string {
    return get(testId).textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  function value(testId: string): string {
    return get<HTMLInputElement>(testId).value;
  }

  async function type(testId: string, input: string): Promise<void> {
    const element = get<HTMLInputElement>(testId);
    element.value = input;
    element.dispatchEvent(new Event('input'));
    await settle();
  }

  async function blur(testId: string): Promise<void> {
    get<HTMLInputElement>(testId).dispatchEvent(new Event('blur'));
    await settle();
  }

  async function click(testId: string): Promise<void> {
    get(testId).click();
    await settle();
  }

  function bodyTypeLabels(): string[] {
    return Array.from(get<HTMLSelectElement>('body-type').options).map((option) => option.textContent?.trim() ?? '');
  }

  /** Elige la carrocería por su etiqueta visible (no depende de value ni de ngValue). */
  async function chooseBodyType(label: string): Promise<void> {
    const select = get<HTMLSelectElement>('body-type');
    const index = bodyTypeLabels().indexOf(label);
    if (index < 0) {
      throw new Error(`No existe la carrocería "${label}"`);
    }
    select.selectedIndex = index;
    select.dispatchEvent(new Event('change'));
    await settle();
  }

  function selectedBodyTypeLabel(): string {
    const select = get<HTMLSelectElement>('body-type');
    return select.options[select.selectedIndex]?.textContent?.trim() ?? '';
  }

  async function chooseOwner(term = 'ana', index = 0): Promise<void> {
    await type('owner-search', term);
    await click('owner-search-button');
    queryAll('owner-option')[index].click();
    await settle();
  }

  async function fillValidVehicle(): Promise<void> {
    await type('plate', 'PBA1234');
    await type('brand', 'Toyota');
    await type('model', 'Hilux');
    await type('year', '2022');
    await type('color', 'Blanco');
    await chooseBodyType('Pickup');
    await type('initial-mileage', '45000');
  }

  function sentBody(call = 0): VehicleCreate {
    return vehiclesApi.create.mock.calls[call][0];
  }

  function currentUrl(): string {
    return TestBed.inject(Router).url;
  }

  // --- US3-AC1: registro con propietario ---

  it('[US3-AC1] registra un vehículo para el propietario elegido y navega a su ficha', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await click('save');

    expect(vehiclesApi.create).toHaveBeenCalledTimes(1);
    expect(sentBody()).toEqual({
      ownerClientId: OWNER_ID,
      plate: 'PBA1234',
      vin: null,
      brand: 'Toyota',
      model: 'Hilux',
      year: 2022,
      color: 'Blanco',
      bodyType: 'pickup',
      initialMileage: 45000,
    });
    expect(currentUrl()).toBe(`/vehicles/${VEHICLE_ID}`);
  });

  it('[US3-AC1] quita espacios al inicio y al final de marca, modelo y color', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('brand', '  Toyota ');
    await type('model', ' Hilux  ');
    await type('color', ' Blanco ');
    await click('save');

    expect(sentBody()).toEqual(expect.objectContaining({ brand: 'Toyota', model: 'Hilux', color: 'Blanco' }));
  });

  it('[US3-AC1] sin datos marca cada obligatorio faltante (incluido el propietario) y no envía', async () => {
    await open();
    await click('save');

    expect(vehiclesApi.create).not.toHaveBeenCalled();
    for (const [field, input] of [
      ['plate', 'plate'],
      ['brand', 'brand'],
      ['model', 'model'],
      ['year', 'year'],
      ['color', 'color'],
      ['initialMileage', 'initial-mileage'],
    ]) {
      expect(text(`error-${field}`).length, `error-${field}`).toBeGreaterThan(0);
      expect(get(input).getAttribute('aria-invalid'), input).toBe('true');
    }
    expect(text('error-ownerClientId').length).toBeGreaterThan(0);
    expect(query('error-vin')).toBeNull();
  });

  it('[US3-AC1] marca, modelo o color hechos solo de espacios cuentan como faltantes', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('brand', '   ');
    await click('save');

    expect(vehiclesApi.create).not.toHaveBeenCalled();
    expect(text('error-brand').length).toBeGreaterThan(0);
  });

  it('[US3-AC1] una marca de más de 60 caracteres marca el campo y no se envía', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('brand', 'M'.repeat(61));
    await click('save');

    expect(vehiclesApi.create).not.toHaveBeenCalled();
    expect(text('error-brand').length).toBeGreaterThan(0);
  });

  // --- US3-AC2: placa normalizada ---

  it('[US3-AC2] al salir de la placa "pba-1234" muestra "PBA1234" y la envía normalizada', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('plate', 'pba-1234');
    await blur('plate');

    expect(value('plate')).toBe('PBA1234');

    await click('save');
    expect(sentBody().plate).toBe('PBA1234');
  });

  it('[US3-AC2] la placa " pba 1234 " se envía como "PBA1234" aunque no se haya salido del campo', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('plate', ' pba 1234 ');
    await click('save');

    expect(sentBody().plate).toBe('PBA1234');
  });

  // --- US3-AC3 / US3-AC5: duplicados ---

  it('[US3-AC3] un 409 PLATE_ALREADY_EXISTS indica que la placa ya está registrada y ofrece "Abrir vehículo existente"', async () => {
    vehiclesApi.create.mockReturnValueOnce(
      throwError(() => problem(409, 'PLATE_ALREADY_EXISTS', { existingId: EXISTING_ID })),
    );
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('plate', 'pba 1234');
    await click('save');

    expect(text('duplicate-message')).toMatch(/placa ya está registrada/i);
    expect(text('duplicate-message')).not.toMatch(/otro taller/i);
    const link = get<HTMLAnchorElement>('open-existing-vehicle');
    expect(link.textContent?.trim()).toMatch(/abrir vehículo existente/i);
    expect(link.getAttribute('href')).toBe(`/vehicles/${EXISTING_ID}`);
    expect(currentUrl()).not.toBe(`/vehicles/${VEHICLE_ID}`);

    link.click();
    await settle();
    expect(currentUrl()).toBe(`/vehicles/${EXISTING_ID}`);
  });

  it('[US3-AC5] un 409 VIN_ALREADY_EXISTS indica que el VIN ya está registrado y ofrece "Abrir vehículo existente"', async () => {
    vehiclesApi.create.mockReturnValueOnce(
      throwError(() => problem(409, 'VIN_ALREADY_EXISTS', { existingId: EXISTING_ID })),
    );
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('vin', '1HGCM82633A004352');
    await click('save');

    expect(text('duplicate-message')).toMatch(/VIN ya está registrado/i);
    expect(get<HTMLAnchorElement>('open-existing-vehicle').getAttribute('href')).toBe(`/vehicles/${EXISTING_ID}`);
  });

  // --- US3-AC4 / US3-AC6: VIN ---

  it('[US3-AC4] un VIN válido se envía en mayúsculas, sin espacios ni guiones', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('vin', '1hgcm-82633 a004352');
    await click('save');

    expect(vehiclesApi.create).toHaveBeenCalledTimes(1);
    expect(sentBody().vin).toBe('1HGCM82633A004352');
  });

  it.each([
    ['1HGCM82633A00435', '16 caracteres'],
    ['1HGCM82633I004352', 'contiene I'],
    ['1HGCM82633O004352', 'contiene O'],
    ['1HGCM82633Q004352', 'contiene Q'],
    ['1HGCM*82633A004352', 'símbolo no permitido'],
  ])('[US3-AC4] el VIN %s (%s) muestra "VIN inválido" junto al campo y no se envía', async (vin) => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('vin', vin);
    await click('save');

    expect(vehiclesApi.create).not.toHaveBeenCalled();
    expect(text('error-vin')).toBe('VIN inválido');
    expect(get('vin').getAttribute('aria-invalid')).toBe('true');
  });

  it('[US3-AC6] sin VIN se guarda y se envía vin null', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('vin', '   ');
    await click('save');

    expect(vehiclesApi.create).toHaveBeenCalledTimes(1);
    expect(sentBody().vin).toBeNull();
    expect(query('error-vin')).toBeNull();
  });

  // --- US3-AC7: año y kilometraje ---

  it.each([
    ['1949', 'anterior a 1950'],
    ['2028', 'posterior al año en curso + 1'],
    ['2020.5', 'no entero'],
  ])('[US3-AC7] el año %s (%s) muestra "Año inválido" y no se envía', async (year) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T15:00:00.000Z'));
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('year', year);
    await click('save');

    expect(vehiclesApi.create).not.toHaveBeenCalled();
    expect(text('error-year')).toBe('Año inválido');
    expect(get('year').getAttribute('aria-invalid')).toBe('true');
  });

  it('[US3-AC7] el año en curso + 1 se acepta', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T15:00:00.000Z'));
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('year', '2027');
    await click('save');

    expect(vehiclesApi.create).toHaveBeenCalledTimes(1);
    expect(sentBody().year).toBe(2027);
  });

  it.each([
    ['-1', 'negativo'],
    ['1500.5', 'no entero'],
    ['10000000', 'mayor que 9 999 999'],
  ])('[US3-AC7] el kilometraje %s (%s) muestra "Kilometraje inválido" y no se envía', async (mileage) => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('initial-mileage', mileage);
    await click('save');

    expect(vehiclesApi.create).not.toHaveBeenCalled();
    expect(text('error-initialMileage')).toBe('Kilometraje inválido');
    expect(get('initial-mileage').getAttribute('aria-invalid')).toBe('true');
  });

  it.each([
    ['0', 0],
    ['9999999', 9999999],
  ])('[US3-AC7] el kilometraje %s se acepta y se envía como número', async (mileage, expected) => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('initial-mileage', mileage);
    await click('save');

    expect(vehiclesApi.create).toHaveBeenCalledTimes(1);
    expect(sentBody().initialMileage).toBe(expected);
  });

  it('[US3-AC7] los errors[] de un 400 del servidor se muestran junto a su campo', async () => {
    vehiclesApi.create.mockReturnValueOnce(
      throwError(() =>
        problem(400, 'VALIDATION_ERROR', {
          errors: [
            { field: 'year', code: 'INVALID_YEAR', message: 'x' },
            { field: 'initialMileage', code: 'INVALID_MILEAGE', message: 'x' },
          ],
        }),
      ),
    );
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await click('save');

    expect(text('error-year')).toBe('Año inválido');
    expect(text('error-initialMileage')).toBe('Kilometraje inválido');
    expect(currentUrl()).not.toBe(`/vehicles/${VEHICLE_ID}`);
  });

  // --- US3-AC8: carrocería ---

  it('[US3-AC8] el selector de carrocería ofrece solo Sedán, SUV, Pickup, Moto y Otro, con Sedán por defecto', async () => {
    await open();

    expect(get('body-type').tagName).toBe('SELECT');
    expect(bodyTypeLabels()).toEqual(['Sedán', 'SUV', 'Pickup', 'Moto', 'Otro']);
    expect(selectedBodyTypeLabel()).toBe('Sedán');
  });

  it.each([
    ['Sedán', 'sedan'],
    ['SUV', 'suv'],
    ['Pickup', 'pickup'],
    ['Otro', 'other'],
  ])('[US3-AC8] elegir "%s" envía bodyType %s', async (label, bodyType) => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await chooseBodyType(label);
    await click('save');

    expect(sentBody().bodyType).toBe(bodyType);
  });

  it('[US3-AC8] elegir "Moto" envía bodyType motorcycle', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await chooseBodyType('Moto');
    await type('plate', 'AB123C');
    await click('save');

    expect(sentBody().bodyType).toBe('motorcycle');
    expect(sentBody().plate).toBe('AB123C');
  });

  // --- US3-AC9: placa precargada y propietario ---

  it('[US3-AC9] ?plate= precarga la placa', async () => {
    await open('/vehicles/new?plate=PBA1234');

    expect(value('plate')).toBe('PBA1234');
  });

  it('[US3-AC9] ?plate= con formato sucio se precarga normalizada', async () => {
    await open('/vehicles/new?plate=pba-1234');

    expect(value('plate')).toBe('PBA1234');
  });

  it('[US3-AC9] con la placa precargada, al elegir propietario y completar los datos se guarda con esa placa', async () => {
    await open('/vehicles/new?plate=GYE0123');
    await chooseOwner();
    await type('brand', 'Kia');
    await type('model', 'Rio');
    await type('year', '2019');
    await type('color', 'Rojo');
    await type('initial-mileage', '80000');
    await click('save');

    expect(sentBody()).toEqual(expect.objectContaining({ plate: 'GYE0123', ownerClientId: OWNER_ID, bodyType: 'sedan' }));
  });

  it('[US3-AC9] ?clientId= preselecciona al propietario', async () => {
    await open(`/vehicles/new?clientId=${OWNER_ID}`);

    expect(clientsApi.getById).toHaveBeenCalledWith(OWNER_ID);
    expect(text('owner-selected')).toContain('Ana Pérez');
    expect(text('owner-selected')).toContain('1710034065');
    expect(query('owner-search')).toBeNull();

    await fillValidVehicle();
    await click('save');
    expect(sentBody().ownerClientId).toBe(OWNER_ID);
  });

  it('[US3-AC11] ?clientId= de un cliente inexistente o de otro taller deja el propietario vacío e indica "Cliente no encontrado"', async () => {
    clientsApi.getById.mockReturnValue(throwError(() => problem(404, 'NOT_FOUND')));
    await open(`/vehicles/new?clientId=${OWNER_ID}`);

    expect(query('owner-selected')).toBeNull();
    expect(query('owner-search')).not.toBeNull();
    expect(text('error-ownerClientId')).toContain('Cliente no encontrado');
  });

  it('[US3-AC9] busca al propietario con la búsqueda de clientes y muestra cada resultado con nombre y documento', async () => {
    await open();
    await type('owner-search', '  nunez ');
    await click('owner-search-button');

    expect(clientsApi.search).toHaveBeenCalledWith('nunez');
    const options = queryAll('owner-option');
    expect(options).toHaveLength(2);
    expect(options[0].textContent).toContain('Ana Pérez');
    expect(options[0].textContent).toContain('1710034065');
    expect(options[1].textContent).toContain('Carlos Ruiz');
    expect(options[1].textContent).toContain('0912345675');
  });

  it('[US3-AC9] al elegir un resultado queda como propietario y es el que se envía', async () => {
    await open();
    await chooseOwner('ruiz', 1);

    expect(text('owner-selected')).toContain('Carlos Ruiz');
    expect(queryAll('owner-option')).toHaveLength(0);
    expect(query('owner-search')).toBeNull();

    await fillValidVehicle();
    await click('save');
    expect(sentBody().ownerClientId).toBe(NEW_CLIENT_ID);
  });

  it('[US3-AC9] "Cambiar" quita el propietario elegido y vuelve a mostrar la búsqueda', async () => {
    await open();
    await chooseOwner();
    await click('owner-change');

    expect(query('owner-selected')).toBeNull();
    expect(query('owner-search')).not.toBeNull();

    await fillValidVehicle();
    await click('save');
    expect(vehiclesApi.create).not.toHaveBeenCalled();
    expect(text('error-ownerClientId').length).toBeGreaterThan(0);
  });

  it('[US3-AC9] una búsqueda sin resultados indica "No se encontró ningún cliente" y ofrece registrar uno nuevo', async () => {
    clientsApi.search.mockReturnValue(of({ items: [], hasMore: false }));
    await open();
    await type('owner-search', 'Zoila');
    await click('owner-search-button');

    expect(text('owner-no-results')).toContain('No se encontró ningún cliente');
    expect(query('register-new-client')).not.toBeNull();
  });

  it('[US3-AC9] "Registrar cliente nuevo" lleva a /clients/new con returnTo=/vehicles/new', async () => {
    await open();
    await type('plate', 'pba-1234');
    await click('register-new-client');

    const url = TestBed.inject(Router).parseUrl(currentUrl());
    expect(url.root.children['primary']?.segments.map((s) => s.path)).toEqual(['clients', 'new']);
    expect(url.queryParams['returnTo']).toBe('/vehicles/new');
  });

  it('[US3-AC9] al volver de registrar el cliente se recupera lo escrito y el cliente nuevo queda como propietario', async () => {
    clientsApi.getById.mockReturnValue(
      of(clientDetail({ id: NEW_CLIENT_ID, displayName: 'Carlos Ruiz', documentNumber: '0912345675' })),
    );
    await open('/vehicles/new?plate=ab-123-c');
    await chooseBodyType('Moto');
    await type('vin', '1HGCM82633A004352');
    await type('brand', 'Honda');
    await type('model', 'CB190R');
    await type('year', '2021');
    await type('color', 'Negro');
    await type('initial-mileage', '12000');
    await click('register-new-client');
    expect(currentUrl()).toMatch(/^\/clients\/new/);

    // ClientFormPage, tras crear el cliente, vuelve a {returnTo}?clientId={id}.
    await open(`/vehicles/new?clientId=${NEW_CLIENT_ID}`);

    expect(value('plate')).toBe('AB123C');
    expect(value('vin')).toBe('1HGCM82633A004352');
    expect(value('brand')).toBe('Honda');
    expect(value('model')).toBe('CB190R');
    expect(value('year')).toBe('2021');
    expect(value('color')).toBe('Negro');
    expect(value('initial-mileage')).toBe('12000');
    expect(selectedBodyTypeLabel()).toBe('Moto');
    expect(clientsApi.getById).toHaveBeenCalledWith(NEW_CLIENT_ID);
    expect(text('owner-selected')).toContain('Carlos Ruiz');

    await click('save');
    expect(sentBody()).toEqual({
      ownerClientId: NEW_CLIENT_ID,
      plate: 'AB123C',
      vin: '1HGCM82633A004352',
      brand: 'Honda',
      model: 'CB190R',
      year: 2021,
      color: 'Negro',
      bodyType: 'motorcycle',
      initialMileage: 12000,
    });
  });

  it('[US3-AC9] si se vuelve sin crear el cliente, también se recupera lo escrito', async () => {
    await open();
    await type('plate', 'GYE0123');
    await type('brand', 'Kia');
    await click('register-new-client');

    await open('/vehicles/new');

    expect(value('plate')).toBe('GYE0123');
    expect(value('brand')).toBe('Kia');
    expect(query('owner-selected')).toBeNull();
  });

  it('[US3-AC9] lo escrito se recupera una sola vez: al abrir de nuevo el formulario está vacío', async () => {
    await open();
    await type('brand', 'Kia');
    await click('register-new-client');
    await open('/vehicles/new');
    expect(value('brand')).toBe('Kia');

    await harness.navigateByUrl('/clients');
    await open('/vehicles/new');

    expect(value('brand')).toBe('');
  });

  it('[US3-AC9] tras guardar con éxito no queda nada que recuperar', async () => {
    await open();
    await type('brand', 'Kia');
    await click('register-new-client');
    await open(`/vehicles/new?clientId=${OWNER_ID}`);
    await fillValidVehicle();
    await click('save');
    expect(currentUrl()).toBe(`/vehicles/${VEHICLE_ID}`);

    await open('/vehicles/new');

    expect(value('plate')).toBe('');
    expect(value('brand')).toBe('');
  });

  // --- US3-AC12 / US3-AC13: mensajes según la carrocería ---

  it.each(['PB1234', 'PBA12', 'PBA12345', '1234PBA', 'AB123C'])(
    '[US3-AC12] con carrocería de auto la placa %s muestra el mensaje de autos y no se envía',
    async (plate) => {
      await open();
      await chooseOwner();
      await fillValidVehicle();
      await chooseBodyType('SUV');
      await type('plate', plate);
      await click('save');

      expect(vehiclesApi.create).not.toHaveBeenCalled();
      expect(text('error-plate')).toBe(CAR_PLATE_MESSAGE);
      expect(get('plate').getAttribute('aria-invalid')).toBe('true');
    },
  );

  it.each(['PBA123', 'PBA1234'])('[US3-AC12] con carrocería de auto la placa %s se acepta', async (plate) => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await chooseBodyType('Otro');
    await type('plate', plate);
    await click('save');

    expect(vehiclesApi.create).toHaveBeenCalledTimes(1);
    expect(query('error-plate')).toBeNull();
  });

  it.each(['PBA1234', 'AB1234'])(
    '[US3-AC13] con carrocería moto la placa %s muestra el mensaje de motos y no se envía',
    async (plate) => {
      await open();
      await chooseOwner();
      await fillValidVehicle();
      await chooseBodyType('Moto');
      await type('plate', plate);
      await click('save');

      expect(vehiclesApi.create).not.toHaveBeenCalled();
      expect(text('error-plate')).toBe(MOTORCYCLE_PLATE_MESSAGE);
    },
  );

  it('[US3-AC13] con carrocería moto la placa AB123C se acepta', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await chooseBodyType('Moto');
    await type('plate', 'AB123C');
    await click('save');

    expect(vehiclesApi.create).toHaveBeenCalledTimes(1);
  });

  it('[US3-AC13] un INVALID_PLATE del servidor se traduce con el mensaje de la carrocería elegida', async () => {
    vehiclesApi.create.mockReturnValueOnce(
      throwError(() =>
        problem(400, 'VALIDATION_ERROR', { errors: [{ field: 'plate', code: 'INVALID_PLATE', message: 'x' }] }),
      ),
    );
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await chooseBodyType('Moto');
    await type('plate', 'AB123C');
    await click('save');

    expect(text('error-plate')).toBe(MOTORCYCLE_PLATE_MESSAGE);
  });

  // --- US3-AC14: revalidar al cambiar la carrocería ---

  it('[US3-AC14] AB123C como moto es válida y al cambiar a Sedán se marca con el mensaje de autos sin pulsar Guardar', async () => {
    await open();
    await chooseBodyType('Moto');
    await type('plate', 'AB123C');
    await blur('plate');
    expect(query('error-plate')).toBeNull();

    await chooseBodyType('Sedán');

    expect(text('error-plate')).toBe(CAR_PLATE_MESSAGE);
    expect(get('plate').getAttribute('aria-invalid')).toBe('true');
  });

  it('[US3-AC14] PBA1234 como sedán es válida y al cambiar a Moto se marca con el mensaje de motos', async () => {
    await open();
    await type('plate', 'PBA1234');
    await blur('plate');
    expect(query('error-plate')).toBeNull();

    await chooseBodyType('Moto');

    expect(text('error-plate')).toBe(MOTORCYCLE_PLATE_MESSAGE);
  });

  it('[US3-AC14] tras un error de placa, cambiar a la carrocería correcta lo quita y permite guardar', async () => {
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('plate', 'AB123C');
    await click('save');
    expect(text('error-plate')).toBe(CAR_PLATE_MESSAGE);

    await chooseBodyType('Moto');
    expect(query('error-plate')).toBeNull();

    await click('save');
    expect(vehiclesApi.create).toHaveBeenCalledTimes(1);
    expect(sentBody()).toEqual(expect.objectContaining({ plate: 'AB123C', bodyType: 'motorcycle' }));
  });

  it.each(['PBA*1234', 'PBA.1234', '#PBA1234'])(
    '[US3-AC14] la placa %s se rechaza como "Placa inválida" en lugar de limpiarse en silencio',
    async (plate) => {
      await open();
      await chooseOwner();
      await fillValidVehicle();
      await type('plate', plate);
      await blur('plate');

      expect(value('plate')).toBe(plate);

      await click('save');
      expect(vehiclesApi.create).not.toHaveBeenCalled();
      expect(text('error-plate')).toMatch(/^Placa inválida/);
    },
  );

  // --- US3-AC11: propietario rechazado por el servidor ---

  it('[US3-AC11] un 404 CLIENT_NOT_FOUND al guardar indica "Cliente no encontrado" junto al propietario', async () => {
    vehiclesApi.create.mockReturnValueOnce(throwError(() => problem(404, 'CLIENT_NOT_FOUND')));
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await click('save');

    expect(text('error-ownerClientId')).toContain('Cliente no encontrado');
    expect(currentUrl()).not.toBe(`/vehicles/${VEHICLE_ID}`);
  });

  // --- Edge case: conexión inestable ---

  it('[edge case conexión inestable] un fallo de red conserva lo escrito y ofrece "Reintentar"', async () => {
    vehiclesApi.create.mockReturnValueOnce(throwError(networkError));
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await type('vin', '1HGCM82633A004352');
    await click('save');

    expect(query('network-error')).not.toBeNull();
    expect(text('retry')).toBe('Reintentar');
    expect(value('plate')).toBe('PBA1234');
    expect(value('vin')).toBe('1HGCM82633A004352');
    expect(value('brand')).toBe('Toyota');
    expect(value('model')).toBe('Hilux');
    expect(value('year')).toBe('2022');
    expect(value('color')).toBe('Blanco');
    expect(value('initial-mileage')).toBe('45000');
    expect(selectedBodyTypeLabel()).toBe('Pickup');
    expect(text('owner-selected')).toContain('Ana Pérez');
    expect(currentUrl()).not.toBe(`/vehicles/${VEHICLE_ID}`);
  });

  it('[edge case conexión inestable] "Reintentar" reenvía los mismos datos y, si se guarda, navega a la ficha', async () => {
    vehiclesApi.create.mockReturnValueOnce(throwError(networkError)).mockReturnValueOnce(of(VEHICLE));
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await click('save');
    await click('retry');

    expect(vehiclesApi.create).toHaveBeenCalledTimes(2);
    expect(sentBody(1)).toEqual(sentBody(0));
    expect(currentUrl()).toBe(`/vehicles/${VEHICLE_ID}`);
  });

  it('[edge case conexión inestable][US3-AC3] un reintento que recibe 409 ofrece abrir el vehículo existente', async () => {
    vehiclesApi.create
      .mockReturnValueOnce(throwError(networkError))
      .mockReturnValueOnce(throwError(() => problem(409, 'PLATE_ALREADY_EXISTS', { existingId: EXISTING_ID })));
    await open();
    await chooseOwner();
    await fillValidVehicle();
    await click('save');
    await click('retry');

    expect(vehiclesApi.create).toHaveBeenCalledTimes(2);
    expect(text('duplicate-message')).toMatch(/placa ya está registrada/i);
    expect(get<HTMLAnchorElement>('open-existing-vehicle').getAttribute('href')).toBe(`/vehicles/${EXISTING_ID}`);
    expect(query('network-error')).toBeNull();
  });
});

describe('VehicleFormPage en modo edición, vehicles/:id/edit (T080, US4)', () => {
  type UpdateVehicle = (vehicleId: string, body: VehicleUpdate) => Observable<VehicleDetail>;

  const REASON_MESSAGE = 'El motivo es obligatorio (entre 10 y 500 caracteres)';
  const VALID_REASON = 'Cambio de placa por pérdida de la anterior';
  const STORED_VIN = '1HGCM82633A004352';
  const OTHER_VIN = '2HGFG12688H500123';

  const STORED: VehicleDetail = { ...VEHICLE, version: 4 };

  let harness: RouterTestingHarness;
  let vehiclesApi: {
    create: ReturnType<typeof vi.fn<VehiclesApiService['create']>>;
    getById: ReturnType<typeof vi.fn<VehiclesApiService['getById']>>;
    search: ReturnType<typeof vi.fn<VehiclesApiService['search']>>;
    update: ReturnType<typeof vi.fn<UpdateVehicle>>;
  };
  let clientsApi: {
    create: ReturnType<typeof vi.fn<ClientsApiService['create']>>;
    getById: ReturnType<typeof vi.fn<ClientsApiService['getById']>>;
    search: ReturnType<typeof vi.fn<ClientsApiService['search']>>;
  };

  beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
    signInAs('asesor');
    vehiclesApi = {
      create: vi.fn<VehiclesApiService['create']>(() => of(VEHICLE)),
      getById: vi.fn<VehiclesApiService['getById']>(() => of(STORED)),
      search: vi.fn<VehiclesApiService['search']>(() => of({ items: [], hasMore: false })),
      update: vi.fn<UpdateVehicle>((_id, body) => of({ ...STORED, version: body.version + 1 })),
    };
    clientsApi = {
      create: vi.fn<ClientsApiService['create']>(() => of(clientDetail())),
      getById: vi.fn<ClientsApiService['getById']>(() => of(clientDetail())),
      search: vi.fn<ClientsApiService['search']>(() => of(SEARCH_RESULTS)),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'clients/:id', component: StubPage },
          { path: 'vehicles/:id/edit', component: VehicleFormPage },
          { path: 'vehicles/:id', component: StubPage },
        ]),
        { provide: VehiclesApiService, useValue: vehiclesApi },
        { provide: ClientsApiService, useValue: clientsApi },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  // --- utilidades (comportamiento observable en el DOM) ---

  async function settle(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  async function openEdit(vehicleId = VEHICLE_ID): Promise<void> {
    await harness.navigateByUrl(`/vehicles/${vehicleId}/edit`);
    await settle();
  }

  function root(): HTMLElement {
    return harness.routeNativeElement ?? (harness.fixture.nativeElement as HTMLElement);
  }

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return root().querySelector<T>(`[data-testid="${testId}"]`);
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = query<T>(testId);
    if (element === null) {
      throw new Error(`No existe [data-testid="${testId}"]`);
    }
    return element;
  }

  function text(testId: string): string {
    return get(testId).textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  function value(testId: string): string {
    return get<HTMLInputElement>(testId).value;
  }

  async function type(testId: string, input: string): Promise<void> {
    const element = get<HTMLInputElement | HTMLTextAreaElement>(testId);
    element.value = input;
    element.dispatchEvent(new Event('input'));
    await settle();
  }

  async function click(testId: string): Promise<void> {
    get(testId).click();
    await settle();
  }

  function bodyTypeLabels(): string[] {
    return Array.from(get<HTMLSelectElement>('body-type').options).map((option) => option.textContent?.trim() ?? '');
  }

  async function chooseBodyType(label: string): Promise<void> {
    const select = get<HTMLSelectElement>('body-type');
    const index = bodyTypeLabels().indexOf(label);
    if (index < 0) {
      throw new Error(`No existe la carrocería "${label}"`);
    }
    select.selectedIndex = index;
    select.dispatchEvent(new Event('change'));
    await settle();
  }

  function selectedBodyTypeLabel(): string {
    const select = get<HTMLSelectElement>('body-type');
    return select.options[select.selectedIndex]?.textContent?.trim() ?? '';
  }

  function sentUpdate(call = 0): [string, VehicleUpdate] {
    return vehiclesApi.update.mock.calls[call];
  }

  function currentUrl(): string {
    return TestBed.inject(Router).url;
  }

  function reasonLabel(): string {
    const label = root().querySelector('label[for="reason"]') ?? get('reason').closest('label');
    return label?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  // --- US4-AC6: carga y edición de datos no identificadores ---

  it('[US4-AC6] carga el vehículo del parámetro de ruta y precarga el formulario', async () => {
    vehiclesApi.getById.mockReturnValue(of({ ...STORED, vin: STORED_VIN }));
    await openEdit();

    expect(vehiclesApi.getById).toHaveBeenCalledWith(VEHICLE_ID);
    expect(root().querySelector('h1')?.textContent).toMatch(/editar vehículo/i);
    expect(value('plate')).toBe('PBA1234');
    expect(value('vin')).toBe(STORED_VIN);
    expect(value('brand')).toBe('Toyota');
    expect(value('model')).toBe('Hilux');
    expect(value('year')).toBe('2022');
    expect(value('color')).toBe('Blanco');
    expect(selectedBodyTypeLabel()).toBe('Pickup');
    expect(value('initial-mileage')).toBe('45000');
  });

  it('[US4-AC6] un VIN null se precarga vacío', async () => {
    await openEdit();

    expect(value('plate')).toBe('PBA1234');
    expect(value('vin')).toBe('');
  });

  it('[US4-AC6] muestra el propietario pero no permite cambiarlo desde la edición', async () => {
    await openEdit();

    expect(text('owner-selected')).toContain('Ana Pérez');
    expect(query('owner-search')).toBeNull();
    expect(query('owner-change')).toBeNull();
    expect(query('register-new-client')).toBeNull();
  });

  it('[US4-AC6] edita marca, modelo, año, color, carrocería y kilometraje: llama a update y navega a la ficha', async () => {
    await openEdit();
    await type('brand', ' Toyota ');
    await type('model', 'Fortuner');
    await type('year', '2023');
    await type('color', '  Rojo  ');
    await chooseBodyType('SUV');
    await type('initial-mileage', '46000');
    await click('save');

    expect(vehiclesApi.create).not.toHaveBeenCalled();
    expect(vehiclesApi.update).toHaveBeenCalledTimes(1);
    const [id, body] = sentUpdate();
    expect(id).toBe(VEHICLE_ID);
    expect(body).toEqual(
      expect.objectContaining({
        version: 4,
        brand: 'Toyota',
        model: 'Fortuner',
        year: 2023,
        color: 'Rojo',
        bodyType: 'suv',
        initialMileage: 46000,
      }),
    );
    expect(Object.keys(body)).not.toContain('ownerClientId');
    expect(Object.keys(body)).not.toContain('tenantId');
    expect(Object.keys(body)).not.toContain('reason');
    if (body.plate !== undefined) {
      expect(body.plate).toBe('PBA1234');
    }
    if (body.vin !== undefined) {
      expect(body.vin).toBeNull();
    }
    expect(currentUrl()).toBe(`/vehicles/${VEHICLE_ID}`);
  });

  // --- US4-AC11: solo placa y VIN piden motivo ---

  it('[US4-AC11] editar el color no muestra el campo "Motivo"', async () => {
    await openEdit();
    expect(value('plate')).toBe('PBA1234');
    await type('color', 'Negro');

    expect(query('reason')).toBeNull();
  });

  it('[US4-AC11] la misma placa escrita de otra forma (pba-1234) no cuenta como cambio', async () => {
    await openEdit();
    await type('plate', 'pba-1234');

    expect(query('reason')).toBeNull();
    await click('save');

    expect(vehiclesApi.update).toHaveBeenCalledTimes(1);
    expect(Object.keys(sentUpdate()[1])).not.toContain('reason');
  });

  it('[US4-AC11] el mismo VIN en minúsculas no cuenta como cambio', async () => {
    vehiclesApi.getById.mockReturnValue(of({ ...STORED, vin: STORED_VIN }));
    await openEdit();
    await type('vin', STORED_VIN.toLowerCase());

    expect(query('reason')).toBeNull();
  });

  it('[US4-AC11] cambiar la placa muestra el campo "Motivo" y volver a la guardada lo oculta', async () => {
    await openEdit();
    await type('plate', 'PBB4321');

    expect(query('reason')).not.toBeNull();
    expect(reasonLabel()).toMatch(/motivo/i);

    await type('plate', 'PBA1234');
    expect(query('reason')).toBeNull();
  });

  it('[US4-AC11] informar un VIN donde no había pide motivo', async () => {
    await openEdit();
    await type('vin', OTHER_VIN);

    expect(query('reason')).not.toBeNull();
  });

  // --- US4-AC15: asesor, motivo obligatorio ---

  it('[US4-AC15] asesor: cambiar la placa sin motivo no guarda e indica el mensaje junto al campo', async () => {
    await openEdit();
    await type('plate', 'PBB4321');
    await click('save');

    expect(vehiclesApi.update).not.toHaveBeenCalled();
    expect(text('error-reason')).toBe(REASON_MESSAGE);
    expect(get('reason').getAttribute('aria-invalid')).toBe('true');
    expect(reasonLabel()).toMatch(/obligatorio/i);
    expect(currentUrl()).toBe(`/vehicles/${VEHICLE_ID}/edit`);
  });

  it('[US4-AC15] asesor: cambiar el VIN sin motivo no guarda', async () => {
    vehiclesApi.getById.mockReturnValue(of({ ...STORED, vin: STORED_VIN }));
    await openEdit();
    await type('vin', OTHER_VIN);
    await click('save');

    expect(vehiclesApi.update).not.toHaveBeenCalled();
    expect(text('error-reason')).toBe(REASON_MESSAGE);
  });

  it('[US4-AC15][US4-AC11] asesor: quitar el VIN guardado pide motivo y, con motivo, envía vin null', async () => {
    vehiclesApi.getById.mockReturnValue(of({ ...STORED, vin: STORED_VIN }));
    await openEdit();
    await type('vin', '');

    expect(query('reason')).not.toBeNull();
    await type('reason', 'VIN registrado por error en otro vehículo');
    await click('save');

    expect(vehiclesApi.update).toHaveBeenCalledTimes(1);
    expect(sentUpdate()[1]).toEqual(
      expect.objectContaining({ version: 4, vin: null, reason: 'VIN registrado por error en otro vehículo' }),
    );
  });

  it.each([
    ['solo espacios', '            '],
    ['9 caracteres sin contar los espacios de los extremos', '   123456789   '],
    ['501 caracteres', 'x'.repeat(501)],
  ])('[US4-AC15] asesor: un motivo de %s no guarda', async (_label, reason) => {
    await openEdit();
    await type('plate', 'PBB4321');
    await type('reason', reason);
    await click('save');

    expect(vehiclesApi.update).not.toHaveBeenCalled();
    expect(text('error-reason')).toBe(REASON_MESSAGE);
  });

  it('[US4-AC15][US4-AC11] asesor: con motivo válido envía la placa normalizada y el motivo recortado', async () => {
    await openEdit();
    await type('plate', 'pbb-4321');
    await type('reason', `  ${VALID_REASON}  `);
    await click('save');

    expect(vehiclesApi.update).toHaveBeenCalledTimes(1);
    expect(sentUpdate()[1]).toEqual(expect.objectContaining({ version: 4, plate: 'PBB4321', reason: VALID_REASON }));
    expect(currentUrl()).toBe(`/vehicles/${VEHICLE_ID}`);
  });

  it('[US4-AC15] sin sesión se aplica la regla del asesor (motivo obligatorio)', async () => {
    signOut();
    await openEdit();
    await type('plate', 'PBB4321');
    await click('save');

    expect(vehiclesApi.update).not.toHaveBeenCalled();
    expect(text('error-reason')).toBe(REASON_MESSAGE);
  });

  it('[US4-AC15] un 400 REASON_REQUIRED del servidor se muestra en error-reason', async () => {
    vehiclesApi.update.mockReturnValueOnce(
      throwError(() =>
        problem(400, 'VALIDATION_ERROR', { errors: [{ field: 'reason', code: 'REASON_REQUIRED', message: 'x' }] }),
      ),
    );
    await openEdit();
    await type('plate', 'PBB4321');
    await type('reason', VALID_REASON);
    await click('save');

    expect(text('error-reason')).toBe(REASON_MESSAGE);
    expect(currentUrl()).toBe(`/vehicles/${VEHICLE_ID}/edit`);
  });

  // --- US4-AC16: administrador, motivo opcional ---

  it('[US4-AC16] admin: cambia la placa sin motivo y se envía sin reason', async () => {
    signInAs('admin');
    await openEdit();
    await type('plate', 'PBB4321');

    expect(reasonLabel()).toMatch(/opcional/i);
    await click('save');

    expect(vehiclesApi.update).toHaveBeenCalledTimes(1);
    expect(sentUpdate()[1].plate).toBe('PBB4321');
    expect(sentUpdate()[1].reason).toBeUndefined();
  });

  it('[US4-AC16] admin: un motivo de solo espacios cuenta como omitido', async () => {
    signInAs('admin');
    await openEdit();
    await type('vin', OTHER_VIN);
    await type('reason', '      ');
    await click('save');

    expect(vehiclesApi.update).toHaveBeenCalledTimes(1);
    expect(sentUpdate()[1].vin).toBe(OTHER_VIN);
    expect(sentUpdate()[1].reason).toBeUndefined();
  });

  it.each([
    ['5 caracteres', 'corto'],
    ['501 caracteres', 'x'.repeat(501)],
  ])('[US4-AC16] admin: un motivo de %s se rechaza con el mismo mensaje que para el asesor', async (_label, reason) => {
    signInAs('admin');
    await openEdit();
    await type('plate', 'PBB4321');
    await type('reason', reason);
    await click('save');

    expect(vehiclesApi.update).not.toHaveBeenCalled();
    expect(text('error-reason')).toBe(REASON_MESSAGE);
  });

  // --- US4-AC5: mismas reglas que en el registro ---

  it('[US4-AC5] una placa con formato inválido muestra el mensaje de autos y no llama a update', async () => {
    await openEdit();
    await type('plate', 'PB1234');
    await type('reason', VALID_REASON);
    await click('save');

    expect(vehiclesApi.update).not.toHaveBeenCalled();
    expect(text('error-plate')).toBe(CAR_PLATE_MESSAGE);
  });

  it('[US4-AC5][US3-AC14] cambiar la carrocería a Moto revalida la placa guardada', async () => {
    await openEdit();
    await chooseBodyType('Moto');

    expect(text('error-plate')).toBe(MOTORCYCLE_PLATE_MESSAGE);
    await click('save');
    expect(vehiclesApi.update).not.toHaveBeenCalled();
  });

  it('[US4-AC5] un VIN inválido muestra "VIN inválido" y no llama a update', async () => {
    await openEdit();
    await type('vin', '1HGCM82633A00435');
    await type('reason', VALID_REASON);
    await click('save');

    expect(vehiclesApi.update).not.toHaveBeenCalled();
    expect(text('error-vin')).toBe('VIN inválido');
  });

  it('[US4-AC5] un 409 PLATE_ALREADY_EXISTS ofrece abrir el vehículo existente', async () => {
    vehiclesApi.update.mockReturnValueOnce(
      throwError(() => problem(409, 'PLATE_ALREADY_EXISTS', { existingId: EXISTING_ID })),
    );
    await openEdit();
    await type('plate', 'GYE0123');
    await type('reason', VALID_REASON);
    await click('save');

    expect(text('duplicate-message')).toMatch(/placa ya está registrada/i);
    expect(get<HTMLAnchorElement>('open-existing-vehicle').getAttribute('href')).toBe(`/vehicles/${EXISTING_ID}`);
    expect(currentUrl()).toBe(`/vehicles/${VEHICLE_ID}/edit`);
  });

  // --- US4-AC12: concurrencia ---

  it('[US4-AC12] un 409 VERSION_CONFLICT avisa "El registro cambió" y muestra los datos actuales', async () => {
    const current: VehicleDetail = { ...STORED, color: 'Gris', initialMileage: 47000, version: 5 };
    vehiclesApi.update.mockReturnValueOnce(throwError(() => problem(409, 'VERSION_CONFLICT', { current })));
    await openEdit();
    await type('color', 'Rojo');
    await click('save');

    expect(text('version-conflict')).toMatch(/el registro cambió/i);
    expect(get('version-conflict').getAttribute('role')).toBe('alert');
    expect(value('color')).toBe('Gris');
    expect(value('initial-mileage')).toBe('47000');
    expect(currentUrl()).toBe(`/vehicles/${VEHICLE_ID}/edit`);
  });

  it('[US4-AC12] tras el conflicto se puede repetir la edición con la versión actual', async () => {
    const current: VehicleDetail = { ...STORED, color: 'Gris', version: 5 };
    vehiclesApi.update.mockReturnValueOnce(throwError(() => problem(409, 'VERSION_CONFLICT', { current })));
    await openEdit();
    await type('color', 'Rojo');
    await click('save');
    await type('color', 'Rojo');
    await click('save');

    expect(vehiclesApi.update).toHaveBeenCalledTimes(2);
    expect(sentUpdate(0)[1].version).toBe(4);
    expect(sentUpdate(1)[1]).toEqual(expect.objectContaining({ version: 5, color: 'Rojo' }));
    expect(currentUrl()).toBe(`/vehicles/${VEHICLE_ID}`);
  });

  // --- US4-AC13: vehículo de otro taller o inexistente ---

  it('[US4-AC13] un 404 al cargar indica "No se encontró ningún vehículo" y no ofrece guardar', async () => {
    vehiclesApi.getById.mockReturnValue(throwError(() => problem(404, 'NOT_FOUND')));
    await openEdit();

    expect(text('load-error')).toContain('No se encontró ningún vehículo');
    expect(query('save')).toBeNull();
  });

  // --- US4-AC17: sin eliminación ---

  it.each(['asesor', 'admin'] as const)('[US4-AC17] %s: la edición no ofrece eliminar ni desactivar el vehículo', async (role) => {
    signInAs(role);
    await openEdit();
    expect(value('plate')).toBe('PBA1234');

    const labels = Array.from(root().querySelectorAll('button, a, [role="button"]')).map(
      (element) => `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`,
    );
    expect(labels.join(' ')).not.toMatch(/eliminar|borrar|desactivar|dar de baja/i);
    expect(root().querySelector('[data-testid*="delete"], [data-testid*="deactivate"]')).toBeNull();
  });
});
