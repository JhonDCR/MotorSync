// T004: Historial clínico de vehículo (US1, US2, US3).
// Ruta `vehicles/:id/history` en app.routes.ts, export class VehicleHistoryComponent (standalone).
// Criterios cubiertos:
//   - [US2-AC1..AC4] Renderiza datos del vehículo y tarjetas de métricas (history-plate, metric-current-mileage,
//     metric-mileage-delta, metric-total-checkins, metric-total-work-orders, metric-delivered-work-orders,
//     metric-total-invested, metric-last-visit, history-owner).
//   - [US1-AC1..AC2] Renderiza los eventos del timeline cronológico con fecha, tipo y resumen (timeline-list,
//     timeline-event, event-kind, event-date, event-summary).
//   - [US3-AC2] Filtros en cliente: checkin, budget, work_order, ownership_transfer, todos.
//   - [US3-AC3] Enlaces a detalles de cada entidad (/checkins/:id, /budgets/:id, /work-orders/:id).
//   - [US3-AC4] Botón de imprimir (print-history) que invoca window.print().
//   - [US3-AC5] Manejo de error 404: not-found y back-to-search.
//   - [edge case] Manejo de error de red con botón reintentar (retry).
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError, type Observable } from 'rxjs';
import type { Problem } from '../../../core/api/api.models';
import { VehiclesApiService } from '../../../core/api/vehicles-api.service';
import { VehicleHistoryComponent } from './vehicle-history.component';

export interface VehicleHeader {
  id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
  color: string;
  bodyType: string;
  vin: string | null;
  initialMileage: number;
}

export interface VehicleOwner {
  id: string;
  displayName: string;
  documentType: 'cedula' | 'ruc' | 'passport';
  documentNumber: string;
  phone?: string | null;
}

export interface VehicleMetrics {
  currentMileage: number;
  mileageDelta: number;
  totalCheckins: number;
  totalWorkOrders: number;
  totalDeliveredWorkOrders: number;
  totalInvested: string;
  lastVisitAt: string | null;
}

export interface TimelineEvent {
  id: string;
  kind: 'checkin' | 'budget' | 'work_order' | 'ownership_transfer';
  occurredAt: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface VehicleClinicalHistory {
  vehicle: VehicleHeader;
  owner: VehicleOwner;
  metrics: VehicleMetrics;
  timeline: TimelineEvent[];
}

@Component({ template: '' })
class StubPage {}

const VEHICLE_ID = 'b2222222-2222-4222-8222-222222222222';
const OTHER_VEHICLE_ID = 'c3333333-3333-4333-8333-333333333333';
const OWNER_ID = '7d1f0c1e-3b8a-4a52-9a43-2f1d8e0b6c11';
const CHECKIN_ID = 'c1111111-1111-4111-8111-111111111111';
const BUDGET_ID = 'd2222222-2222-4222-8222-222222222222';
const WORK_ORDER_ID = 'e3333333-3333-4333-8333-333333333333';
const TRANSFER_ID = 'f4444444-4444-4444-8444-444444444444';

function clinicalHistory(extra: Partial<VehicleClinicalHistory> = {}): VehicleClinicalHistory {
  return {
    vehicle: {
      id: VEHICLE_ID,
      plate: 'PBA1234',
      brand: 'Toyota',
      model: 'Hilux',
      year: 2022,
      color: 'Blanco',
      bodyType: 'pickup',
      vin: '1HGCM82633A004352',
      initialMileage: 45000,
    },
    owner: {
      id: OWNER_ID,
      displayName: 'Ana Pérez',
      documentType: 'cedula',
      documentNumber: '1710034065',
      phone: '0991234567',
    },
    metrics: {
      currentMileage: 52000,
      mileageDelta: 7000,
      totalCheckins: 3,
      totalWorkOrders: 2,
      totalDeliveredWorkOrders: 2,
      totalInvested: '450.00',
      lastVisitAt: '2026-10-21T18:00:00.000Z',
    },
    timeline: [
      {
        id: WORK_ORDER_ID,
        kind: 'work_order',
        occurredAt: '2026-10-21T18:00:00.000Z',
        summary: 'Orden de trabajo #2 entregada',
        data: {
          id: WORK_ORDER_ID,
          number: 2,
          status: 'entregada',
          itemsCount: 3,
        },
      },
      {
        id: BUDGET_ID,
        kind: 'budget',
        occurredAt: '2026-10-21T16:00:00.000Z',
        summary: 'Presupuesto #2 aprobado ($250.00)',
        data: {
          id: BUDGET_ID,
          number: 2,
          status: 'aprobado',
          total: '250.00',
        },
      },
      {
        id: CHECKIN_ID,
        kind: 'checkin',
        occurredAt: '2026-10-21T15:00:00.000Z',
        summary: 'Check-in de recepción con 52.000 km',
        data: {
          id: CHECKIN_ID,
          mileage: 52000,
          fuelLevel: '1/2',
        },
      },
      {
        id: TRANSFER_ID,
        kind: 'ownership_transfer',
        occurredAt: '2026-09-15T14:00:00.000Z',
        summary: 'Transferencia de propietario de Carlos Ruiz a Ana Pérez',
        data: {
          id: TRANSFER_ID,
          previousOwner: { displayName: 'Carlos Ruiz', documentNumber: '0912345675' },
          newOwner: { displayName: 'Ana Pérez', documentNumber: '1710034065' },
        },
      },
    ],
    ...extra,
  };
}

function problem(status: number, code: Problem['code']): Problem {
  return { type: 'about:blank', title: 'Error', status, code };
}

const networkError = () => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: '/api/v1/vehicles' });

describe('VehicleHistoryComponent (T004)', () => {
  let harness: RouterTestingHarness;
  let vehiclesApi: {
    getHistory: ReturnType<typeof vi.fn<(vehicleId: string) => Observable<VehicleClinicalHistory>>>;
  };

  beforeEach(async () => {
    vehiclesApi = {
      getHistory: vi.fn<(vehicleId: string) => Observable<VehicleClinicalHistory>>(() =>
        of(clinicalHistory()),
      ),
    };

    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: '', component: StubPage },
          { path: 'vehicles', component: StubPage },
          { path: 'vehicles/:id', component: StubPage },
          { path: 'vehicles/:id/history', component: VehicleHistoryComponent },
          { path: 'checkins/:id', component: StubPage },
          { path: 'budgets/:id', component: StubPage },
          { path: 'work-orders/:id', component: StubPage },
        ]),
        { provide: VehiclesApiService, useValue: vehiclesApi },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  // --- utilidades para el DOM ---

  async function open(vehicleId = VEHICLE_ID): Promise<void> {
    await harness.navigateByUrl(`/vehicles/${vehicleId}/history`);
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

  async function click(testId: string): Promise<void> {
    get(testId).click();
    await settle();
  }

  // --- US1-AC1 / Navegación y carga inicial ---

  it('[US1-AC1] solicita el historial clínico usando el id de la ruta', async () => {
    await open();
    expect(vehiclesApi.getHistory).toHaveBeenCalledWith(VEHICLE_ID);
  });

  // --- US2-AC1..AC4: Datos del vehículo y tarjetas de métricas ---

  describe('datos del vehículo y métricas (US2-AC1..AC4)', () => {
    it('[US2-AC1..AC4] renderiza la placa, el propietario y todas las tarjetas de métricas clínicas', async () => {
      await open();

      expect(text('history-plate')).toContain('PBA1234');
      expect(text('history-owner')).toContain('Ana Pérez');

      // Odómetro actual y variación (US2-AC1)
      expect(text('metric-current-mileage').replace(/\D/g, '')).toBe('52000');
      expect(text('metric-mileage-delta').replace(/\D/g, '')).toBe('7000');

      // Conteo de check-ins, OT totales y OT entregadas (US2-AC2)
      expect(text('metric-total-checkins').replace(/\D/g, '')).toBe('3');
      expect(text('metric-total-work-orders').replace(/\D/g, '')).toBe('2');
      expect(text('metric-delivered-work-orders').replace(/\D/g, '')).toBe('2');

      // Total invertido históricamente (US2-AC3)
      expect(text('metric-total-invested')).toContain('450.00');

      // Última visita (US2-AC4)
      expect(text('metric-last-visit')).toContain('21/10/2026');
    });

    it('[US1-AC3] vehículo sin intervenciones muestra métricas en cero o basadas en odómetro inicial', async () => {
      vehiclesApi.getHistory.mockReturnValue(
        of(
          clinicalHistory({
            metrics: {
              currentMileage: 45000,
              mileageDelta: 0,
              totalCheckins: 0,
              totalWorkOrders: 0,
              totalDeliveredWorkOrders: 0,
              totalInvested: '0.00',
              lastVisitAt: null,
            },
            timeline: [],
          }),
        ),
      );
      await open();

      expect(text('metric-current-mileage').replace(/\D/g, '')).toBe('45000');
      expect(text('metric-mileage-delta').replace(/\D/g, '')).toBe('0');
      expect(text('metric-total-checkins').replace(/\D/g, '')).toBe('0');
      expect(text('metric-total-work-orders').replace(/\D/g, '')).toBe('0');
      expect(text('metric-delivered-work-orders').replace(/\D/g, '')).toBe('0');
      expect(text('metric-total-invested')).toContain('0.00');
      expect(queryAll('timeline-event')).toHaveLength(0);
    });
  });

  // --- US1-AC1..AC2: Timeline cronológico de eventos ---

  describe('timeline cronológico (US1-AC1..AC2)', () => {
    it('[US1-AC1] renderiza la lista de eventos en el orden cronológico recibido', async () => {
      await open();

      expect(query('timeline-list')).not.toBeNull();
      const events = queryAll('timeline-event');
      expect(events).toHaveLength(4);

      // Verificación de cada evento y su contenido
      const [first, second, third, fourth] = events;

      expect(text('event-kind', first)).toMatch(/work_order|orden de trabajo/i);
      expect(text('event-summary', first)).toContain('Orden de trabajo #2 entregada');
      expect(text('event-date', first)).toContain('21/10/2026');

      expect(text('event-kind', second)).toMatch(/budget|presupuesto/i);
      expect(text('event-summary', second)).toContain('Presupuesto #2 aprobado');

      expect(text('event-kind', third)).toMatch(/checkin|check-in/i);
      expect(text('event-summary', third)).toContain('Check-in de recepción con 52.000 km');

      expect(text('event-kind', fourth)).toMatch(/ownership_transfer|transferencia/i);
      expect(text('event-summary', fourth)).toContain('Transferencia de propietario');
    });
  });

  // --- US3-AC2: Filtros en cliente por tipo de evento ---

  describe('filtros en cliente (US3-AC2)', () => {
    it('[US3-AC2] filtra instantáneamente por checkin, budget, work_order y ownership_transfer', async () => {
      await open();
      expect(queryAll('timeline-event')).toHaveLength(4);

      // Filtro Check-ins
      await click('filter-checkin');
      let filtered = queryAll('timeline-event');
      expect(filtered).toHaveLength(1);
      expect(text('event-kind', filtered[0])).toMatch(/checkin|check-in/i);

      // Filtro Presupuestos
      await click('filter-budget');
      filtered = queryAll('timeline-event');
      expect(filtered).toHaveLength(1);
      expect(text('event-kind', filtered[0])).toMatch(/budget|presupuesto/i);

      // Filtro Órdenes de trabajo
      await click('filter-work_order');
      filtered = queryAll('timeline-event');
      expect(filtered).toHaveLength(1);
      expect(text('event-kind', filtered[0])).toMatch(/work_order|orden de trabajo/i);

      // Filtro Transferencias
      await click('filter-ownership_transfer');
      filtered = queryAll('timeline-event');
      expect(filtered).toHaveLength(1);
      expect(text('event-kind', filtered[0])).toMatch(/ownership_transfer|transferencia/i);

      // Volver a "Todos"
      const allFilterBtn = query('filter-all') ?? get('filter-todos');
      allFilterBtn.click();
      await settle();
      expect(queryAll('timeline-event')).toHaveLength(4);
    });
  });

  // --- US3-AC3: Enlaces a detalles de cada entidad ---

  describe('enlaces a detalles de entidades (US3-AC3)', () => {
    it('[US3-AC3] provee enlaces a /checkins/:id, /budgets/:id y /work-orders/:id', async () => {
      await open();

      const events = queryAll('timeline-event');
      const [woEvent, budgetEvent, checkinEvent] = events;

      const woLink = woEvent.querySelector<HTMLAnchorElement>('a[href*="/work-orders/"]') ??
        query<HTMLAnchorElement>('event-link', woEvent);
      expect(woLink?.getAttribute('href')).toBe(`/work-orders/${WORK_ORDER_ID}`);

      const budgetLink = budgetEvent.querySelector<HTMLAnchorElement>('a[href*="/budgets/"]') ??
        query<HTMLAnchorElement>('event-link', budgetEvent);
      expect(budgetLink?.getAttribute('href')).toBe(`/budgets/${BUDGET_ID}`);

      const checkinLink = checkinEvent.querySelector<HTMLAnchorElement>('a[href*="/checkins/"]') ??
        query<HTMLAnchorElement>('event-link', checkinEvent);
      expect(checkinLink?.getAttribute('href')).toBe(`/checkins/${CHECKIN_ID}`);
    });
  });

  // --- US3-AC4: Botón de imprimir ---

  describe('impresión (US3-AC4)', () => {
    it('[US3-AC4] el botón de imprimir invoca window.print()', async () => {
      await open();

      const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);
      await click('print-history');

      expect(printSpy).toHaveBeenCalled();
      printSpy.mockRestore();
    });
  });

  // --- US3-AC5: Manejo de 404 (vehículo inexistente o ajeno) ---

  describe('manejo de errores 404 (US3-AC5)', () => {
    it('[US3-AC5] muestra mensaje amigable y enlace para volver al buscador al recibir 404', async () => {
      vehiclesApi.getHistory.mockReturnValue(throwError(() => problem(404, 'NOT_FOUND')));
      await open(OTHER_VEHICLE_ID);

      expect(text('not-found')).toMatch(/no se encontró|no encontrado/i);
      expect(query('history-plate')).toBeNull();
      expect(query('timeline-list')).toBeNull();

      const backLink = get<HTMLAnchorElement>('back-to-search');
      expect(backLink.getAttribute('href')).toMatch(/^\/(vehicles)?$/);
    });
  });

  // --- Manejo de error de red con reintento ---

  describe('manejo de error de red y reintento', () => {
    it('[edge case conexión inestable] un fallo de red muestra botón "Reintentar" y recarga los datos', async () => {
      vehiclesApi.getHistory.mockReturnValueOnce(throwError(networkError));
      await open();

      expect(query('history-plate')).toBeNull();
      expect(query('timeline-list')).toBeNull();
      expect(query('retry')).not.toBeNull();

      await click('retry');

      expect(vehiclesApi.getHistory).toHaveBeenCalledTimes(2);
      expect(vehiclesApi.getHistory).toHaveBeenLastCalledWith(VEHICLE_ID);
      expect(text('history-plate')).toContain('PBA1234');
      expect(queryAll('timeline-event')).toHaveLength(4);
    });
  });
});
