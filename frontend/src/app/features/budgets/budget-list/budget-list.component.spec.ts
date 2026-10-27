// T012: lista de presupuestos (US3-AC1).
// Contrato para el implementer (T013): export class BudgetListComponent (standalone), rutas
//   vehicles/:id/budgets y checkins/:id/budgets. Selectores: budget-item (<a> por presupuesto en el orden
//   del servidor, href /budgets/{id}, con número, estado y total), no-budgets (estado vacío).
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { BudgetListComponent } from './budget-list.component';

@Component({ template: '' })
class StubPage {}

const VEHICLE_ID = 'a1111111-1111-4111-8111-111111111111';
const ITEMS = [
  {
    id: 'b2222222-2222-4222-8222-222222222222',
    number: 2,
    status: 'aprobado',
    total: '71.30',
    createdAt: '2026-10-20T15:00:00.000Z',
  },
  {
    id: 'b1111111-1111-4111-8111-111111111111',
    number: 1,
    status: 'borrador',
    total: '28.75',
    createdAt: '2026-10-01T15:00:00.000Z',
  },
];

describe('BudgetListComponent (T012)', () => {
  let harness: RouterTestingHarness;

  async function open(body: object[]): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'vehicles/:id/budgets', component: BudgetListComponent },
          { path: 'checkins/:id/budgets', component: BudgetListComponent },
          { path: '**', component: StubPage },
        ]),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create(`/vehicles/${VEHICLE_ID}/budgets`);
    const req = http.expectOne(`/api/v1/vehicles/${VEHICLE_ID}/budgets`);
    expect(req.request.method).toBe('GET');
    req.flush(body);
    harness.detectChanges();
    await harness.fixture.whenStable();
  }
  const all = (id: string) =>
    Array.from(harness.routeNativeElement!.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));

  it('[US3-AC1] lista los presupuestos en el orden del servidor con estado, total y enlace', async () => {
    await open(ITEMS);
    const items = all('budget-item');
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute('href')).toBe(`/budgets/${ITEMS[0].id}`);
    expect(items[0].textContent).toContain('aprobado');
    expect(items[0].textContent).toContain('71.30');
    expect(items[1].textContent).toContain('borrador');
    expect(all('no-budgets')).toHaveLength(0);
  });

  it('[US3-AC1] muestra el estado vacío si no hay presupuestos', async () => {
    await open([]);
    expect(all('budget-item')).toHaveLength(0);
    expect(all('no-budgets')).toHaveLength(1);
  });
});
