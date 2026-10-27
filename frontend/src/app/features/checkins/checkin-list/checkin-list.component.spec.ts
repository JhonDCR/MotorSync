// T011: historial de check-ins de un vehículo (US2-AC1).
// Contrato para el implementer (T012), archivo features/checkins/checkin-list/checkin-list.component.ts:
//   export class CheckinListComponent (standalone), ruta vehicles/:id/checkins.
// Selectores: checkin-item (<a> por check-in en el orden del servidor, href /checkins/{id}, con número,
//   kilometraje, motivo, autor y damageCount), no-checkins (estado vacío).
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { CheckinListComponent } from './checkin-list.component';

@Component({ template: '' })
class StubPage {}

const VEHICLE_ID = 'a1111111-1111-4111-8111-111111111111';
const ITEMS = [
  {
    id: 'c2222222-2222-4222-8222-222222222222',
    number: 2,
    createdAt: '2026-10-20T15:00:00.000Z',
    mileage: 86000,
    reason: 'cambio de aceite',
    createdByName: 'Ana',
    damageCount: 0,
  },
  {
    id: 'c1111111-1111-4111-8111-111111111111',
    number: 1,
    createdAt: '2026-10-01T15:00:00.000Z',
    mileage: 85000,
    reason: 'ruido al frenar',
    createdByName: 'Luis',
    damageCount: 3,
  },
];

describe('CheckinListComponent (T011)', () => {
  let harness: RouterTestingHarness;

  async function open(body: object[]): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'vehicles/:id/checkins', component: CheckinListComponent },
          { path: '**', component: StubPage },
        ]),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create(`/vehicles/${VEHICLE_ID}/checkins`);
    const req = http.expectOne(`/api/v1/vehicles/${VEHICLE_ID}/checkins`);
    expect(req.request.method).toBe('GET');
    req.flush(body);
    harness.detectChanges();
    await harness.fixture.whenStable();
  }
  const all = (id: string) =>
    Array.from(harness.routeNativeElement!.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));

  it('[US2-AC1] lista los check-ins en el orden del servidor con sus datos y enlace al detalle', async () => {
    await open(ITEMS);
    const items = all('checkin-item');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('href')).toBe(`/checkins/${ITEMS[0].id}`);
    expect(items[1].textContent).toContain('ruido al frenar');
    expect(items[1].textContent).toContain('Luis');
    expect(items[1].textContent).toContain('3');
    expect(all('no-checkins')).toHaveLength(0);
  });

  it('[US2-AC1] muestra el estado vacío si el vehículo no tiene check-ins', async () => {
    await open([]);
    expect(all('checkin-item')).toHaveLength(0);
    expect(all('no-checkins')).toHaveLength(1);
  });
});
