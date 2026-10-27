// T008: WorkOrderService contra specs/006-ordenes-trabajo/contracts/openapi.yaml.
// Contrato para el implementer (T009), archivo features/work-orders/work-order.service.ts:
//   create(budgetId) list(status?) listByVehicle(vehicleId) getById(id) start/finish/deliver(id)
//   cancel(id, reason) reassign(id, userId) addNote(id, body).
//   Tipos WorkOrderStatus, WorkOrderSummary y WorkOrderDetail exportados desde work-order.service.ts.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { WorkOrderService } from './work-order.service';

const ID = 'a1111111-1111-4111-8111-111111111111';

describe('WorkOrderService (T008)', () => {
  it('[US2-AC1] usa las rutas, métodos y cuerpos del contrato', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const http = TestBed.inject(HttpTestingController);
    const svc = TestBed.inject(WorkOrderService);
    const base = `/api/v1/work-orders/${ID}`;
    const calls: [() => unknown, string, string, unknown][] = [
      [() => svc.create(ID).subscribe(), 'POST', `/api/v1/budgets/${ID}/work-orders`, undefined],
      [() => svc.listByVehicle(ID).subscribe(), 'GET', `/api/v1/vehicles/${ID}/work-orders`, null],
      [() => svc.getById(ID).subscribe(), 'GET', base, null],
      [() => svc.start(ID).subscribe(), 'POST', `${base}/start`, undefined],
      [() => svc.finish(ID).subscribe(), 'POST', `${base}/finish`, undefined],
      [() => svc.deliver(ID).subscribe(), 'POST', `${base}/deliver`, undefined],
      [() => svc.cancel(ID, 'No vino').subscribe(), 'POST', `${base}/cancel`, { reason: 'No vino' }],
      [() => svc.reassign(ID, ID).subscribe(), 'PATCH', `${base}/assignee`, { userId: ID }],
      [() => svc.addNote(ID, 'Avance').subscribe(), 'POST', `${base}/notes`, { body: 'Avance' }],
    ];
    for (const [call, method, url, body] of calls) {
      call();
      const req = http.expectOne(url);
      expect(req.request.method).toBe(method);
      if (body) expect(req.request.body).toEqual(body);
      req.flush({});
    }
    svc.list().subscribe();
    http.expectOne((r) => r.url === '/api/v1/work-orders' && !r.params.has('status')).flush([]);
    svc.list('en_proceso').subscribe();
    http
      .expectOne((r) => r.url === '/api/v1/work-orders' && r.params.get('status') === 'en_proceso')
      .flush([]);
    http.verify();
  });
});
