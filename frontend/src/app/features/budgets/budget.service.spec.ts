// T010: BudgetService contra specs/005-presupuestos/contracts/openapi.yaml.
// Contrato para el implementer (T011), archivo features/budgets/budget.service.ts:
//   @Injectable({ providedIn: 'root' }) export class BudgetService {
//     create(checkinId, body: BudgetInput)                  // POST /api/v1/checkins/{id}/budgets
//     listByCheckin(checkinId) / listByVehicle(vehicleId)   // GET  .../budgets
//     getById(id) / update(id, body)                        // GET / PUT /api/v1/budgets/{id}
//     send(id) / approve(id) / reject(id)                   // POST /api/v1/budgets/{id}/send|approve|reject
//   }  Tipos BudgetInput, BudgetSummary y BudgetDetail exportados desde budget.service.ts.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BudgetService, type BudgetInput } from './budget.service';

const ID = 'b1111111-1111-4111-8111-111111111111';
const BODY: BudgetInput = {
  lines: [
    { kind: 'mano_obra', description: 'Cambio de pastillas', quantity: '1', unitPrice: '25.00' },
  ],
};

describe('BudgetService (T010)', () => {
  it('[US1-AC1] usa las rutas, métodos y cuerpos del contrato', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const http = TestBed.inject(HttpTestingController);
    const svc = TestBed.inject(BudgetService);
    const calls: [() => unknown, string, string, unknown][] = [
      [() => svc.create(ID, BODY).subscribe(), 'POST', `/api/v1/checkins/${ID}/budgets`, BODY],
      [() => svc.listByCheckin(ID).subscribe(), 'GET', `/api/v1/checkins/${ID}/budgets`, null],
      [() => svc.listByVehicle(ID).subscribe(), 'GET', `/api/v1/vehicles/${ID}/budgets`, null],
      [() => svc.getById(ID).subscribe(), 'GET', `/api/v1/budgets/${ID}`, null],
      [() => svc.update(ID, BODY).subscribe(), 'PUT', `/api/v1/budgets/${ID}`, BODY],
      [() => svc.send(ID).subscribe(), 'POST', `/api/v1/budgets/${ID}/send`, undefined],
      [() => svc.approve(ID).subscribe(), 'POST', `/api/v1/budgets/${ID}/approve`, undefined],
      [() => svc.reject(ID).subscribe(), 'POST', `/api/v1/budgets/${ID}/reject`, undefined],
    ];
    for (const [call, method, url, body] of calls) {
      call();
      const req = http.expectOne(url);
      expect(req.request.method).toBe(method);
      if (body) expect(req.request.body).toEqual(body);
      req.flush({});
    }
    http.verify();
  });
});
