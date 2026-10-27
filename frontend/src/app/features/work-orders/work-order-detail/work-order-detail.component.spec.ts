// T008: detalle de OT (US2-AC1..AC4). Ruta work-orders/:id, export class WorkOrderDetailComponent (standalone).
// Selectores: wo-status; start-wo, finish-wo, deliver-wo, cancel-wo (solo los válidos para el estado);
//   cancel-reason (textarea) y confirm-cancel (deshabilitado sin motivo); note-body, add-note (ocultos en
//   entregada/cancelada), note-item; history-item; wo-error (muestra el currentStatus del 409).
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { WorkOrderDetailComponent } from './work-order-detail.component';

@Component({ template: '' })
class StubPage {}

const ID = 'a1111111-1111-4111-8111-111111111111';
const USER = { id: 'b1111111-1111-4111-8111-111111111111', name: 'Ana' };
const wo = (status: string, extra: object = {}) => ({
  id: ID,
  number: 7,
  status,
  plate: 'PBA-1234',
  vehicleId: ID,
  assignee: USER,
  createdAt: '2026-10-27T10:00:00Z',
  budgetId: ID,
  checkinId: ID,
  createdBy: USER,
  items: [{ position: 1, kind: 'mano_obra', description: 'Frenos', quantity: '1' }],
  history: [{ status: 'abierta', changedBy: USER, changedAt: '2026-10-27T10:00:00Z', reason: null }],
  notes: [],
  ...extra,
});

describe('WorkOrderDetailComponent (T008)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  async function render(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  }
  async function open(status: string): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'work-orders/:id', component: WorkOrderDetailComponent },
          { path: '**', component: StubPage },
        ]),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create(`/work-orders/${ID}`);
    http.expectOne(`/api/v1/work-orders/${ID}`).flush(wo(status));
    await render();
  }
  const all = (id: string) =>
    Array.from(harness.routeNativeElement!.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
  const one = (id: string) => all(id)[0];
  function set(el: HTMLElement, value: string): void {
    (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input'));
  }

  it('[US2-AC1] muestra solo los botones válidos para el estado y avanza al pulsar', async () => {
    await open('abierta');
    expect(one('start-wo')).toBeTruthy();
    expect(one('cancel-wo')).toBeTruthy();
    expect(one('finish-wo')).toBeUndefined();
    expect(one('deliver-wo')).toBeUndefined();
    expect(all('history-item')).toHaveLength(1);
    one('start-wo').click();
    const req = http.expectOne(`/api/v1/work-orders/${ID}/start`);
    expect(req.request.method).toBe('POST');
    req.flush(wo('en_proceso'));
    await render();
    expect(one('wo-status').textContent).toContain('en_proceso');
    expect(one('finish-wo')).toBeTruthy();
    expect(one('start-wo')).toBeUndefined();
  });

  it('[US2-AC1] una OT entregada no ofrece acciones', async () => {
    await open('entregada');
    for (const id of ['start-wo', 'finish-wo', 'deliver-wo', 'cancel-wo', 'add-note']) {
      expect(one(id)).toBeUndefined();
    }
  });

  it('[US2-AC2] cancelar pide motivo y lo envía', async () => {
    await open('en_proceso');
    one('cancel-wo').click();
    await render();
    expect((one('confirm-cancel') as HTMLButtonElement).disabled).toBe(true);
    set(one('cancel-reason'), 'Cliente desiste');
    await render();
    one('confirm-cancel').click();
    const req = http.expectOne(`/api/v1/work-orders/${ID}/cancel`);
    expect(req.request.body).toEqual({ reason: 'Cliente desiste' });
    req.flush(wo('cancelada'));
    await render();
    expect(one('wo-status').textContent).toContain('cancelada');
  });

  it('[US2-AC3] muestra el 409 con el estado actual', async () => {
    await open('abierta');
    one('start-wo').click();
    http
      .expectOne(`/api/v1/work-orders/${ID}/start`)
      .flush(
        { status: 409, title: 'Conflict', currentStatus: 'cancelada' },
        { status: 409, statusText: 'Conflict' },
      );
    await render();
    expect(one('wo-error').textContent).toContain('cancelada');
  });

  it('[US2-AC4] agrega una nota y la muestra', async () => {
    await open('en_proceso');
    set(one('note-body'), 'Pastillas cambiadas');
    await render();
    one('add-note').click();
    const req = http.expectOne(`/api/v1/work-orders/${ID}/notes`);
    expect(req.request.body).toEqual({ body: 'Pastillas cambiadas' });
    req.flush(
      wo('en_proceso', {
        notes: [{ body: 'Pastillas cambiadas', createdBy: USER, createdAt: '2026-10-27T11:00:00Z' }],
      }),
    );
    await render();
    expect(all('note-item')).toHaveLength(1);
    expect(one('note-item').textContent).toContain('Pastillas cambiadas');
  });
});
