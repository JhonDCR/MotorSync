// T010: tablero de OT (US3-AC1). Ruta work-orders, export class WorkOrderBoardComponent (standalone).
// Selectores: status-filter (select; valor vacío = todos), wo-row por OT (número, placa, responsable,
//   estado), board-empty.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { WorkOrderBoardComponent } from './work-order-board.component';

@Component({ template: '' })
class StubPage {}

const ROW = {
  id: 'a1111111-1111-4111-8111-111111111111',
  number: 7,
  status: 'en_proceso',
  plate: 'PBA-1234',
  vehicleId: 'c1111111-1111-4111-8111-111111111111',
  assignee: { id: 'b1111111-1111-4111-8111-111111111111', name: 'Ana' },
  createdAt: '2026-10-27T10:00:00Z',
};

describe('WorkOrderBoardComponent (T010)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  const all = (id: string) =>
    Array.from(harness.routeNativeElement!.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
  async function render(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'work-orders', component: WorkOrderBoardComponent },
          { path: '**', component: StubPage },
        ]),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create('/work-orders');
  });

  it('[US3-AC1] filtrar por estado llama con status y lista número, placa, responsable y estado', async () => {
    http.expectOne((r) => r.url === '/api/v1/work-orders' && !r.params.has('status')).flush([]);
    await render();
    const select = all('status-filter')[0] as HTMLSelectElement;
    select.value = 'en_proceso';
    select.dispatchEvent(new Event('change'));
    await render();
    http
      .expectOne((r) => r.url === '/api/v1/work-orders' && r.params.get('status') === 'en_proceso')
      .flush([ROW]);
    await render();
    const rows = all('wo-row');
    expect(rows).toHaveLength(1);
    for (const text of ['7', 'PBA-1234', 'Ana', 'en_proceso']) {
      expect(rows[0].textContent).toContain(text);
    }
    expect(all('board-empty')).toHaveLength(0);
  });

  it('[US3-AC1] muestra el estado vacío sin OT', async () => {
    http.expectOne((r) => r.url === '/api/v1/work-orders').flush([]);
    await render();
    expect(all('board-empty')).toHaveLength(1);
    expect(all('wo-row')).toHaveLength(0);
  });
});
