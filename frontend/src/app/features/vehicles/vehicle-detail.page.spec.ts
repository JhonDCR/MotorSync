// T051: ficha del vehículo (US3-AC1, FR-017, 404 de US1-AC9/FR-023, edge case "conexión inestable").
// Según research R8, el componente se prueba con VehiclesApiService simulado.
//
// Contrato para el implementer (T052), archivo features/vehicles/vehicle-detail.page.ts:
//   export class VehicleDetailPage (standalone), ruta `vehicles/:id` en app.routes.ts (loadComponent), declarada
//   DESPUÉS de `vehicles/new` para que "new" no se lea como un id.
//   El id se lee del parámetro de ruta `id` con ActivatedRoute (app.config no usa withComponentInputBinding)
//   y se pide con VehiclesApiService.getById(id) (T048). Si cambia el parámetro, se vuelve a cargar.
// Selectores (data-testid):
//   vehicle-plate         placa normalizada, tal como llega
//   vehicle-brand, vehicle-model, vehicle-year, vehicle-color
//   vehicle-body-type     etiqueta en español: Sedán, SUV, Pickup, Moto, Otro
//   vehicle-vin           VIN; si es null no se muestra el texto "null" (por ejemplo "Sin VIN")
//   vehicle-mileage       initialMileage (puede llevar separador de miles y "km")
//   owner-name            <a> con el displayName del propietario actual, href /clients/{owner.id}
//   owner-document, owner-phone, owner-email   datos del propietario; email null no muestra "null"
//   last-modified         "Última modificación por {updatedByName} el {fecha}" con un <time datetime="{updatedAt}">
//                         y la fecha en formato dd/MM/yyyy (más la hora, opcional)
//   not-found             404: "No se encontró ningún vehículo" (problemMessage con resource 'vehicle'); sin ficha
//   back-to-search        <a> de vuelta a la pantalla inicial, href /
//   load-error + retry    fallo de red: mensaje y botón "Reintentar" que vuelve a pedir la ficha
// Sin acciones de eliminar ni desactivar (FR-021).
//
// T080 (PR3, US4): historial de propietarios y transferencia, contrato para el implementer (T081).
//   Además de getById, la ficha pide VehiclesApiService.getOwnershipHistory(id) y lo muestra en el orden recibido
//   (la API ya lo da del más reciente al más antiguo). Un fallo del historial no impide ver la ficha.
//   (En el describe de T051 el mock incluye getOwnershipHistory con items vacíos; sus casos no cambian.)
// Selectores nuevos (data-testid):
//   edit-vehicle               <a> "Editar" con href /vehicles/{id}/edit
//   transfer-ownership         botón "Transferir propietario": abre <app-transfer-ownership-dialog> (TransferOwnership
//                              Dialog, data-testid transfer-dialog) con el vehículo cargado
//   ownership-history          <section> "Historial de propietarios", de solo lectura: sin <button> ni acciones de
//                              editar, eliminar o borrar
//   ownership-change           un elemento por cambio, con:
//     ownership-previous       displayName del propietario anterior
//     ownership-new            displayName del nuevo propietario
//     ownership-date           <time datetime="{occurredAt}"> con la fecha dd/MM/yyyy (y hora opcional)
//     ownership-actor          actorName del usuario que lo hizo
//     ownership-reason         el motivo; si es null, un texto como "Sin motivo" (nunca "null")
//   ownership-history-empty    "Sin cambios de propietario" si items está vacío
//   ownership-history-error    mensaje si getOwnershipHistory falla (el resto de la ficha se ve)
// Al recibir `transferred` del diálogo: lo cierra, muestra el nuevo propietario (owner-name) y vuelve a pedir el
// historial. Al recibir `cancelled`: lo cierra sin cambios.
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError, type Observable } from 'rxjs';
import type {
  BodyType,
  ClientSummary,
  OwnershipChange,
  OwnershipHistoryResponse,
  OwnershipTransferRequest,
  Problem,
  VehicleDetail,
} from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { signInAs } from '../../../testing/fake-jwt';
import { VehicleDetailPage } from './vehicle-detail.page';

type HistoryFn = (vehicleId: string) => Observable<OwnershipHistoryResponse>;
type TransferFn = (vehicleId: string, body: OwnershipTransferRequest) => Observable<VehicleDetail>;

@Component({ template: '' })
class StubPage {}

const VEHICLE_ID = 'b2222222-2222-4222-8222-222222222222';
const OTHER_VEHICLE_ID = 'c3333333-3333-4333-8333-333333333333';
const OWNER_ID = '7d1f0c1e-3b8a-4a52-9a43-2f1d8e0b6c11';

function detail(extra: Partial<VehicleDetail> = {}): VehicleDetail {
  return {
    id: VEHICLE_ID,
    plate: 'PBA1234',
    brand: 'Toyota',
    model: 'Hilux',
    year: 2022,
    vin: '1HGCM82633A004352',
    color: 'Blanco perla',
    bodyType: 'pickup',
    initialMileage: 45000,
    version: 2,
    owner: {
      id: OWNER_ID,
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: '1710034065',
      displayName: 'Ana Pérez',
      phone: '0991234567',
      email: 'ana.perez@example.com',
    },
    createdAt: '2026-10-01T13:00:00.000Z',
    updatedAt: '2026-10-21T15:30:00.000Z',
    updatedBy: '11111111-1111-4111-8111-111111111111',
    updatedByName: 'Asesor Uno',
    ...extra,
  };
}

function problem(status: number, code: Problem['code']): Problem {
  return { type: 'about:blank', title: 'Error', status, code };
}

const networkError = () => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: '/api/v1/vehicles' });

describe('VehicleDetailPage (T051)', () => {
  let harness: RouterTestingHarness;
  let api: {
    getById: ReturnType<typeof vi.fn<VehiclesApiService['getById']>>;
    getOwnershipHistory: ReturnType<typeof vi.fn<HistoryFn>>;
  };

  beforeEach(async () => {
    api = {
      getById: vi.fn<VehiclesApiService['getById']>(() => of(detail())),
      getOwnershipHistory: vi.fn<HistoryFn>(() => of({ items: [] })),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: StubPage },
          { path: 'clients/:id', component: StubPage },
          { path: 'vehicles/:id', component: VehicleDetailPage },
        ]),
        { provide: VehiclesApiService, useValue: api },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  // --- utilidades (comportamiento observable en el DOM) ---

  async function open(vehicleId = VEHICLE_ID): Promise<void> {
    await harness.navigateByUrl(`/vehicles/${vehicleId}`);
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

  // --- US3-AC1: datos del vehículo ---

  it('[US3-AC1] pide la ficha del vehículo del parámetro de ruta', async () => {
    await open();
    expect(api.getById).toHaveBeenCalledWith(VEHICLE_ID);
  });

  it('[US3-AC1] muestra placa, marca, modelo, año, color, VIN, carrocería y kilometraje inicial', async () => {
    await open();

    expect(text('vehicle-plate')).toContain('PBA1234');
    expect(text('vehicle-brand')).toContain('Toyota');
    expect(text('vehicle-model')).toContain('Hilux');
    expect(text('vehicle-year')).toContain('2022');
    expect(text('vehicle-color')).toContain('Blanco perla');
    expect(text('vehicle-vin')).toContain('1HGCM82633A004352');
    expect(text('vehicle-body-type')).toContain('Pickup');
    expect(text('vehicle-mileage').replace(/\D/g, '')).toBe('45000');
  });

  it.each<[BodyType, string]>([
    ['sedan', 'Sedán'],
    ['suv', 'SUV'],
    ['pickup', 'Pickup'],
    ['motorcycle', 'Moto'],
    ['other', 'Otro'],
  ])('[US3-AC8] la carrocería %s se muestra como "%s"', async (bodyType, label) => {
    api.getById.mockReturnValue(of(detail({ bodyType, plate: bodyType === 'motorcycle' ? 'AB123C' : 'PBA1234' })));
    await open();

    expect(text('vehicle-body-type')).toBe(label);
  });

  it('[US3-AC6] un vehículo sin VIN no muestra "null"', async () => {
    api.getById.mockReturnValue(of(detail({ vin: null })));
    await open();

    expect(text('vehicle-plate')).toContain('PBA1234');
    expect(root().textContent).not.toContain('null');
  });

  // --- US3-AC1: propietario actual ---

  it('[US3-AC1] muestra nombre, documento, teléfono y correo del propietario actual', async () => {
    await open();

    expect(text('owner-name')).toContain('Ana Pérez');
    expect(text('owner-document')).toContain('1710034065');
    expect(text('owner-phone')).toContain('0991234567');
    expect(text('owner-email')).toContain('ana.perez@example.com');
  });

  it('[US3-AC1] un propietario sin correo no muestra "null"', async () => {
    const base = detail();
    api.getById.mockReturnValue(of(detail({ owner: { ...base.owner, email: null } })));
    await open();

    expect(text('owner-name')).toContain('Ana Pérez');
    expect(root().textContent).not.toContain('null');
  });

  it('[US3-AC1] el nombre del propietario enlaza a su ficha /clients/{id} y la abre', async () => {
    await open();

    const link = get<HTMLAnchorElement>('owner-name');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(`/clients/${OWNER_ID}`);

    link.click();
    await settle();
    expect(TestBed.inject(Router).url).toBe(`/clients/${OWNER_ID}`);
  });

  // --- FR-017 ---

  it('[FR-017] muestra "Última modificación por X el Y" con el usuario y la fecha de updatedAt', async () => {
    await open();

    const stamp = text('last-modified');
    expect(stamp).toMatch(/última modificación por Asesor Uno el \d{2}\/\d{2}\/\d{4}/i);
    expect(stamp).toContain('21/10/2026');
    const time = get('last-modified').querySelector('time');
    expect(time).not.toBeNull();
    expect(time?.getAttribute('datetime')).toBe('2026-10-21T15:30:00.000Z');
  });

  // --- FR-021 ---

  it('[FR-021] la ficha no ofrece eliminar ni desactivar el vehículo', async () => {
    await open();

    const labels = Array.from(root().querySelectorAll('button, a')).map((el) => el.textContent ?? '');
    expect(labels.join(' ')).not.toMatch(/eliminar|borrar|desactivar/i);
  });

  // --- 404 (no existe o es de otro taller: US1-AC9, FR-023) ---

  it('[US1-AC9] un 404 muestra "No se encontró ningún vehículo", sin datos del vehículo ni del propietario', async () => {
    api.getById.mockReturnValue(throwError(() => problem(404, 'NOT_FOUND')));
    await open(OTHER_VEHICLE_ID);

    expect(text('not-found')).toContain('No se encontró ningún vehículo');
    expect(query('vehicle-plate')).toBeNull();
    expect(query('owner-name')).toBeNull();
    expect(query('last-modified')).toBeNull();
    expect(get<HTMLAnchorElement>('back-to-search').getAttribute('href')).toBe('/');
  });

  // --- edge case "conexión inestable" ---

  it('[edge case conexión inestable] un fallo de red muestra un mensaje y "Reintentar" vuelve a pedir la ficha', async () => {
    api.getById.mockReturnValueOnce(throwError(networkError));
    await open();

    expect(query('load-error')).not.toBeNull();
    expect(query('vehicle-plate')).toBeNull();
    expect(query('not-found')).toBeNull();
    expect(text('retry')).toBe('Reintentar');

    get('retry').click();
    await settle();

    expect(api.getById).toHaveBeenCalledTimes(2);
    expect(api.getById).toHaveBeenLastCalledWith(VEHICLE_ID);
    expect(query('load-error')).toBeNull();
    expect(text('vehicle-plate')).toContain('PBA1234');
  });

  // --- navegación entre fichas ---

  it('[US3-AC1] al cambiar el parámetro de ruta carga la ficha del otro vehículo', async () => {
    await open();
    api.getById.mockReturnValue(of(detail({ id: OTHER_VEHICLE_ID, plate: 'GYE0123', brand: 'Kia' })));

    await open(OTHER_VEHICLE_ID);

    expect(api.getById).toHaveBeenLastCalledWith(OTHER_VEHICLE_ID);
    expect(text('vehicle-plate')).toContain('GYE0123');
  });
});

describe('VehicleDetailPage: historial de propietarios y transferencia (T080, US4)', () => {
  const CARLOS_ID = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
  const REASON = 'Venta del vehículo con contrato notariado';

  const CARLOS: ClientSummary = {
    id: CARLOS_ID,
    clientType: 'natural',
    documentType: 'cedula',
    documentNumber: '0912345675',
    displayName: 'Carlos Ruiz',
    phone: '0987654321',
    email: null,
  };

  function change(extra: Partial<OwnershipChange>): OwnershipChange {
    return {
      id: 'd4444444-4444-4444-8444-444444444444',
      occurredAt: '2026-10-21T18:00:00.000Z',
      previousOwner: { clientId: CARLOS_ID, displayName: 'Carlos Ruiz', documentNumber: '0912345675' },
      newOwner: { clientId: OWNER_ID, displayName: 'Ana Pérez', documentNumber: '1710034065' },
      actorUserId: '22222222-2222-4222-8222-222222222222',
      actorName: 'Admin Uno',
      actorRole: 'admin',
      reason: null,
      ...extra,
    };
  }

  // Del más reciente al más antiguo, como lo devuelve la API.
  const HISTORY: OwnershipHistoryResponse = {
    items: [
      change({}),
      change({
        id: 'e5555555-5555-4555-8555-555555555555',
        occurredAt: '2026-09-15T14:00:00.000Z',
        previousOwner: { clientId: OWNER_ID, displayName: 'Ana Pérez', documentNumber: '1710034065' },
        newOwner: { clientId: CARLOS_ID, displayName: 'Carlos Ruiz', documentNumber: '0912345675' },
        actorUserId: '11111111-1111-4111-8111-111111111111',
        actorName: 'Asesor Uno',
        actorRole: 'asesor',
        reason: REASON,
      }),
    ],
  };

  let harness: RouterTestingHarness;
  let vehiclesApi: {
    getById: ReturnType<typeof vi.fn<VehiclesApiService['getById']>>;
    getOwnershipHistory: ReturnType<typeof vi.fn<HistoryFn>>;
    transferOwnership: ReturnType<typeof vi.fn<TransferFn>>;
  };
  let clientsApi: { search: ReturnType<typeof vi.fn<ClientsApiService['search']>> };

  beforeEach(async () => {
    localStorage.clear();
    signInAs('asesor');
    vehiclesApi = {
      getById: vi.fn<VehiclesApiService['getById']>(() => of(detail())),
      getOwnershipHistory: vi.fn<HistoryFn>(() => of(HISTORY)),
      transferOwnership: vi.fn<TransferFn>(() => of(detail({ owner: CARLOS, version: 3 }))),
    };
    clientsApi = { search: vi.fn<ClientsApiService['search']>(() => of({ items: [CARLOS], hasMore: false })) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: StubPage },
          { path: 'clients/:id', component: StubPage },
          { path: 'vehicles/:id/edit', component: StubPage },
          { path: 'vehicles/:id', component: VehicleDetailPage },
        ]),
        { provide: VehiclesApiService, useValue: vehiclesApi },
        { provide: ClientsApiService, useValue: clientsApi },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // --- utilidades (comportamiento observable en el DOM) ---

  async function open(vehicleId = VEHICLE_ID): Promise<void> {
    await harness.navigateByUrl(`/vehicles/${vehicleId}`);
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

  function query<T extends HTMLElement = HTMLElement>(testId: string, within: ParentNode = root()): T | null {
    return within.querySelector<T>(`[data-testid="${testId}"]`);
  }

  function queryAll<T extends HTMLElement = HTMLElement>(testId: string, within: ParentNode = root()): T[] {
    return Array.from(within.querySelectorAll<T>(`[data-testid="${testId}"]`));
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string, within: ParentNode = root()): T {
    const element = query<T>(testId, within);
    if (element === null) {
      throw new Error(`No existe [data-testid="${testId}"]`);
    }
    return element;
  }

  function text(testId: string, within: ParentNode = root()): string {
    return get(testId, within).textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  async function type(testId: string, value: string): Promise<void> {
    const element = get<HTMLInputElement | HTMLTextAreaElement>(testId);
    element.value = value;
    element.dispatchEvent(new Event('input'));
    await settle();
  }

  async function click(testId: string): Promise<void> {
    get(testId).click();
    await settle();
  }

  function actionLabels(): string {
    return Array.from(root().querySelectorAll('button, a, [role="button"]'))
      .map((element) => `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`)
      .join(' ');
  }

  // --- US4-AC10: historial de propietarios ---

  it('[US4-AC10] pide el historial de propietarios del vehículo de la ruta', async () => {
    await open();

    expect(vehiclesApi.getOwnershipHistory).toHaveBeenCalledWith(VEHICLE_ID);
    expect(get('ownership-history').textContent).toMatch(/historial de propietarios/i);
  });

  it('[US4-AC10] muestra cada cambio con anterior, nuevo, fecha, usuario y motivo, del más reciente al más antiguo', async () => {
    await open();

    const items = queryAll('ownership-change', get('ownership-history'));
    expect(items).toHaveLength(2);

    const [latest, oldest] = items;
    expect(text('ownership-previous', latest)).toContain('Carlos Ruiz');
    expect(text('ownership-new', latest)).toContain('Ana Pérez');
    expect(text('ownership-date', latest)).toContain('21/10/2026');
    expect(get('ownership-date', latest).querySelector('time')?.getAttribute('datetime') ??
      get('ownership-date', latest).getAttribute('datetime')).toBe('2026-10-21T18:00:00.000Z');
    expect(text('ownership-actor', latest)).toContain('Admin Uno');

    expect(text('ownership-previous', oldest)).toContain('Ana Pérez');
    expect(text('ownership-new', oldest)).toContain('Carlos Ruiz');
    expect(text('ownership-date', oldest)).toContain('15/09/2026');
    expect(text('ownership-actor', oldest)).toContain('Asesor Uno');
    expect(text('ownership-reason', oldest)).toContain(REASON);
  });

  it('[US4-AC10][US4-AC16] un cambio sin motivo no muestra "null"', async () => {
    await open();

    const latest = queryAll('ownership-change')[0];
    expect(text('ownership-reason', latest).length).toBeGreaterThan(0);
    expect(get('ownership-history').textContent).not.toContain('null');
  });

  it('[US4-AC10] sin cambios de propietario lo indica', async () => {
    vehiclesApi.getOwnershipHistory.mockReturnValue(of({ items: [] }));
    await open();

    expect(text('ownership-history-empty')).toMatch(/sin cambios de propietario/i);
    expect(queryAll('ownership-change')).toHaveLength(0);
  });

  it('[US4-AC10] el historial es de solo lectura: no tiene botones ni acciones de editar o borrar', async () => {
    await open();

    const section = get('ownership-history');
    expect(section.querySelectorAll('button')).toHaveLength(0);
    expect(section.textContent).not.toMatch(/editar|eliminar|borrar/i);
  });

  it('[US4-AC10] si el historial no se puede cargar, la ficha se sigue viendo', async () => {
    vehiclesApi.getOwnershipHistory.mockReturnValue(
      throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' })),
    );
    await open();

    expect(text('vehicle-plate')).toContain('PBA1234');
    expect(query('ownership-history-error')).not.toBeNull();
  });

  // --- US4-AC6: acceso a la edición ---

  it('[US4-AC6] ofrece editar el vehículo con un enlace a /vehicles/{id}/edit', async () => {
    await open();

    const link = get<HTMLAnchorElement>('edit-vehicle');
    expect(link.getAttribute('href')).toBe(`/vehicles/${VEHICLE_ID}/edit`);
  });

  // --- US4-AC7: transferencia desde la ficha ---

  it('[US4-AC7] "Transferir propietario" abre el diálogo de transferencia', async () => {
    await open();
    expect(query('transfer-dialog')).toBeNull();

    await click('transfer-ownership');

    expect(query('transfer-dialog')).not.toBeNull();
    expect(text('transfer-current-owner')).toContain('Ana Pérez');
  });

  it('[US4-AC7] tras transferir muestra el nuevo propietario, cierra el diálogo y recarga el historial', async () => {
    await open();
    await click('transfer-ownership');
    await type('transfer-search', 'carlos');
    await click('transfer-search-button');
    queryAll('transfer-option')[0].click();
    await settle();
    await type('transfer-reason', REASON);
    await click('transfer-continue');
    await click('transfer-confirm');

    expect(vehiclesApi.transferOwnership).toHaveBeenCalledWith(VEHICLE_ID, {
      newOwnerClientId: CARLOS_ID,
      version: 2,
      reason: REASON,
    });
    expect(query('transfer-dialog')).toBeNull();
    expect(text('owner-name')).toContain('Carlos Ruiz');
    expect(get<HTMLAnchorElement>('owner-name').getAttribute('href')).toBe(`/clients/${CARLOS_ID}`);
    expect(vehiclesApi.getOwnershipHistory).toHaveBeenCalledTimes(2);
  });

  it('[FR-018] cancelar el diálogo lo cierra sin transferir', async () => {
    await open();
    await click('transfer-ownership');
    await click('transfer-cancel');

    expect(query('transfer-dialog')).toBeNull();
    expect(vehiclesApi.transferOwnership).not.toHaveBeenCalled();
    expect(text('owner-name')).toContain('Ana Pérez');
  });

  // --- US4-AC17: sin eliminación, para cualquier rol ---

  it.each(['asesor', 'admin'] as const)('[US4-AC17] %s: la ficha y el diálogo no ofrecen eliminar ni desactivar', async (role) => {
    signInAs(role);
    await open();
    expect(query('edit-vehicle')).not.toBeNull();
    expect(actionLabels()).not.toMatch(/eliminar|borrar|desactivar|dar de baja/i);

    await click('transfer-ownership');
    expect(query('transfer-dialog')).not.toBeNull();
    expect(actionLabels()).not.toMatch(/eliminar|borrar|desactivar|dar de baja/i);
    expect(root().querySelector('[data-testid*="delete"], [data-testid*="deactivate"]')).toBeNull();
  });
});
