// T033 (parte 2): ficha del cliente (US4-AC3, FR-017, 404 de FR-023, edge case "conexión inestable").
// Según research R8, el componente se prueba con ClientsApiService simulado.
//
// Contrato para el implementer (T034), archivo features/clients/client-detail.page.ts:
//   export class ClientDetailPage (standalone), ruta `clients/:id` en app.routes.ts (loadComponent).
//   El id se lee del parámetro de ruta `id` con ActivatedRoute (app.config no usa withComponentInputBinding)
//   y se pide con ClientsApiService.getById(id). Si cambia el parámetro, se vuelve a cargar.
// Selectores (data-testid):
//   client-name           displayName
//   client-document       documentNumber (normalizado, tal como llega)
//   client-phone          phone
//   client-email          email; si es null no se muestra el texto "null" (puede omitirse o decir "Sin correo")
//   vehicle-item          un <a> por vehículo, en el orden del servidor, href /vehicles/{id}; muestra placa,
//                         marca, modelo y año
//   no-vehicles           "Este cliente no tiene vehículos registrados" (solo si vehicles está vacío)
//   register-vehicle      <a> para registrar un vehículo, href /vehicles/new?clientId={id} (al menos cuando
//                         la lista está vacía)
//   last-modified         "Última modificación por {updatedByName} el {fecha}" con un <time datetime="{updatedAt}">
//                         y la fecha en formato dd/MM/yyyy (más la hora, opcional)
//   not-found             404: "Cliente no encontrado" (problemMessage con resource 'client'); no se muestra la ficha
//   back-to-search        <a> de vuelta a la búsqueda, href /clients (en el 404)
//   load-error + retry    fallo de red: mensaje y botón "Reintentar" que vuelve a pedir la ficha
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import type { ClientDetail, Problem, VehicleSummary } from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { ClientDetailPage } from './client-detail.page';

@Component({ template: '' })
class StubPage {}

const CLIENT_ID = '7d1f0c1e-3b8a-4a52-9a43-2f1d8e0b6c11';
const OTHER_CLIENT_ID = '0b9e7a51-6a0c-4f0e-8d1b-5c2a9e3f4d22';

const VEHICLES: VehicleSummary[] = [
  { id: 'a1111111-1111-4111-8111-111111111111', plate: 'ABC123', brand: 'Chevrolet', model: 'Aveo', year: 2015 },
  { id: 'b2222222-2222-4222-8222-222222222222', plate: 'PBA1234', brand: 'Toyota', model: 'Hilux', year: 2022 },
];

function detail(extra: Partial<ClientDetail> = {}): ClientDetail {
  return {
    id: CLIENT_ID,
    clientType: 'natural',
    documentType: 'cedula',
    documentNumber: '1712345678',
    displayName: 'José Andrés Núñez',
    firstNames: 'José Andrés',
    lastNames: 'Núñez',
    businessName: null,
    phone: '0991234567',
    email: 'jose.nunez@example.com',
    version: 3,
    vehicles: VEHICLES,
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

const networkError = () => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: '/api/v1/clients' });

describe('ClientDetailPage (T033)', () => {
  let harness: RouterTestingHarness;
  let api: { getById: ReturnType<typeof vi.fn<ClientsApiService['getById']>> };

  beforeEach(async () => {
    api = { getById: vi.fn<ClientsApiService['getById']>(() => of(detail())) };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'clients', component: StubPage },
          { path: 'clients/:id', component: ClientDetailPage },
          { path: 'vehicles/new', component: StubPage },
          { path: 'vehicles/:id', component: StubPage },
        ]),
        { provide: ClientsApiService, useValue: api },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  // --- utilidades (comportamiento observable en el DOM) ---

  async function open(clientId = CLIENT_ID): Promise<void> {
    await harness.navigateByUrl(`/clients/${clientId}`);
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

  // --- US4-AC3: datos de contacto ---

  it('[US4-AC3] pide la ficha del cliente del parámetro de ruta', async () => {
    await open();
    expect(api.getById).toHaveBeenCalledWith(CLIENT_ID);
  });

  it('[US4-AC3] muestra nombre, documento, teléfono y correo del cliente', async () => {
    await open();

    expect(text('client-name')).toContain('José Andrés Núñez');
    expect(text('client-document')).toContain('1712345678');
    expect(text('client-phone')).toContain('0991234567');
    expect(text('client-email')).toContain('jose.nunez@example.com');
  });

  it('[US4-AC3] un cliente sin correo no muestra "null"', async () => {
    api.getById.mockReturnValue(of(detail({ email: null })));
    await open();

    expect(text('client-name')).toContain('José Andrés Núñez');
    expect(root().textContent).not.toContain('null');
  });

  it('[US4-AC3] una empresa muestra su razón social y RUC', async () => {
    api.getById.mockReturnValue(
      of(
        detail({
          clientType: 'company',
          documentType: 'ruc',
          documentNumber: '1790012345001',
          displayName: 'Transportes Núñez S.A.',
          firstNames: null,
          lastNames: null,
          businessName: 'Transportes Núñez S.A.',
        }),
      ),
    );
    await open();

    expect(text('client-name')).toContain('Transportes Núñez S.A.');
    expect(text('client-document')).toContain('1790012345001');
  });

  // --- US4-AC3: vehículos ---

  it('[US4-AC3] lista los vehículos con placa, marca, modelo y año, en el orden del servidor', async () => {
    await open();

    const items = queryAll('vehicle-item');
    expect(items).toHaveLength(2);
    const [first, second] = items.map((item) => item.textContent ?? '');
    for (const value of ['ABC123', 'Chevrolet', 'Aveo', '2015']) {
      expect(first).toContain(value);
    }
    for (const value of ['PBA1234', 'Toyota', 'Hilux', '2022']) {
      expect(second).toContain(value);
    }
    expect(query('no-vehicles')).toBeNull();
  });

  it('[US4-AC3] cada vehículo enlaza a su ficha /vehicles/{id} y la abre', async () => {
    await open();

    const links = queryAll<HTMLAnchorElement>('vehicle-item');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(VEHICLES.map((v) => `/vehicles/${v.id}`));

    links[1].click();
    await settle();
    expect(TestBed.inject(Router).url).toBe(`/vehicles/${VEHICLES[1].id}`);
  });

  it('[US4-AC3] sin vehículos muestra "Este cliente no tiene vehículos registrados" y la acción para registrar uno', async () => {
    api.getById.mockReturnValue(of(detail({ vehicles: [] })));
    await open();

    expect(queryAll('vehicle-item')).toHaveLength(0);
    expect(text('no-vehicles')).toContain('Este cliente no tiene vehículos registrados');
    const register = get<HTMLAnchorElement>('register-vehicle');
    expect(register.getAttribute('href')).toBe(`/vehicles/new?clientId=${CLIENT_ID}`);
  });

  it('[US4-AC3] la acción para registrar un vehículo lleva a /vehicles/new con el cliente preseleccionado', async () => {
    api.getById.mockReturnValue(of(detail({ vehicles: [] })));
    await open();

    get('register-vehicle').click();
    await settle();
    expect(TestBed.inject(Router).url).toBe(`/vehicles/new?clientId=${CLIENT_ID}`);
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

  // --- 404 (no existe o es de otro taller: FR-023) ---

  it('[FR-023] un 404 muestra "Cliente no encontrado", no muestra ficha y ofrece volver a la búsqueda', async () => {
    api.getById.mockReturnValue(throwError(() => problem(404, 'NOT_FOUND')));
    await open(OTHER_CLIENT_ID);

    expect(text('not-found')).toContain('Cliente no encontrado');
    expect(query('client-name')).toBeNull();
    expect(queryAll('vehicle-item')).toHaveLength(0);
    expect(query('no-vehicles')).toBeNull();
    expect(get<HTMLAnchorElement>('back-to-search').getAttribute('href')).toBe('/clients');
  });

  // --- edge case "conexión inestable" ---

  it('[edge case conexión inestable] un fallo de red muestra un mensaje y "Reintentar" vuelve a pedir la ficha', async () => {
    api.getById.mockReturnValueOnce(throwError(networkError));
    await open();

    expect(query('load-error')).not.toBeNull();
    expect(query('client-name')).toBeNull();
    expect(query('not-found')).toBeNull();

    get('retry').click();
    await settle();

    expect(api.getById).toHaveBeenCalledTimes(2);
    expect(api.getById).toHaveBeenLastCalledWith(CLIENT_ID);
    expect(query('load-error')).toBeNull();
    expect(text('client-name')).toContain('José Andrés Núñez');
  });

  // --- navegación entre fichas ---

  it('[US4-AC3] al cambiar el parámetro de ruta carga la ficha del otro cliente', async () => {
    await open();
    api.getById.mockReturnValue(of(detail({ id: OTHER_CLIENT_ID, displayName: 'Maria Nunez', vehicles: [] })));

    await open(OTHER_CLIENT_ID);

    expect(api.getById).toHaveBeenLastCalledWith(OTHER_CLIENT_ID);
    expect(text('client-name')).toContain('Maria Nunez');
  });
});
