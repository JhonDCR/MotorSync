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
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import type { BodyType, Problem, VehicleDetail } from '../../core/api/api.models';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { VehicleDetailPage } from './vehicle-detail.page';

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
  let api: { getById: ReturnType<typeof vi.fn<VehiclesApiService['getById']>> };

  beforeEach(async () => {
    api = { getById: vi.fn<VehiclesApiService['getById']>(() => of(detail())) };
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
