// T010: formulario de presupuesto (US1-AC1, US1-AC3, US2-AC2).
// Contrato para el implementer (T011): export class BudgetFormComponent (standalone),
//   rutas checkins/:id/budgets/new (POST) y budgets/:id/edit (GET y luego PUT).
// Selectores: add-line; line-row por línea con line-kind (select), line-description, line-quantity,
//   line-unit-price y remove-line; preview-subtotal, preview-tax, preview-total (IVA 15 %, formato 0.00);
//   save-budget (deshabilitado sin líneas); budget-error (muestra el currentStatus del 409).
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { BudgetFormComponent } from './budget-form.component';

@Component({ template: '' })
class StubPage {}

const CHECKIN_ID = 'c1111111-1111-4111-8111-111111111111';
const BUDGET_ID = 'b1111111-1111-4111-8111-111111111111';

describe('BudgetFormComponent (T010)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  async function open(url: string): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'checkins/:id/budgets/new', component: BudgetFormComponent },
          { path: 'budgets/:id/edit', component: BudgetFormComponent },
          { path: '**', component: StubPage },
        ]),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create(url);
  }
  const all = (id: string, el: ParentNode = harness.routeNativeElement!) =>
    Array.from(el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
  const one = (id: string, el?: ParentNode) => all(id, el)[0];
  async function render(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
  }
  function set(el: HTMLElement, value: string): void {
    (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input'));
  }
  async function addLine(kind: string, desc: string, qty: string, price: string): Promise<void> {
    one('add-line').click();
    await render();
    const row = all('line-row').at(-1)!;
    set(one('line-kind', row), kind);
    set(one('line-description', row), desc);
    set(one('line-quantity', row), qty);
    set(one('line-unit-price', row), price);
    await render();
  }

  it('[US1-AC1] agrega líneas, previsualiza 62.00/9.30/71.30 y guarda con el cuerpo del contrato', async () => {
    await open(`/checkins/${CHECKIN_ID}/budgets/new`);
    await render();
    await addLine('mano_obra', 'Cambio de pastillas', '1', '25.00');
    await addLine('repuesto', 'Pastillas delanteras', '2', '18.50');
    expect(one('preview-subtotal').textContent).toContain('62.00');
    expect(one('preview-tax').textContent).toContain('9.30');
    expect(one('preview-total').textContent).toContain('71.30');
    one('save-budget').click();
    const req = http.expectOne(`/api/v1/checkins/${CHECKIN_ID}/budgets`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      lines: [
        {
          kind: 'mano_obra',
          description: 'Cambio de pastillas',
          quantity: '1',
          unitPrice: '25.00',
        },
        {
          kind: 'repuesto',
          description: 'Pastillas delanteras',
          quantity: '2',
          unitPrice: '18.50',
        },
      ],
    });
  });

  it('[US1-AC3] quita líneas y bloquea guardar sin líneas', async () => {
    await open(`/checkins/${CHECKIN_ID}/budgets/new`);
    await render();
    await addLine('repuesto', 'Pastillas delanteras', '2', '18.50');
    one('remove-line').click();
    await render();
    expect(all('line-row')).toHaveLength(0);
    expect((one('save-budget') as HTMLButtonElement).disabled).toBe(true);
    one('save-budget').click();
    http.expectNone(`/api/v1/checkins/${CHECKIN_ID}/budgets`);
  });

  it('[US2-AC2] muestra el 409 con el estado actual al guardar un presupuesto ya enviado', async () => {
    await open(`/budgets/${BUDGET_ID}/edit`);
    http.expectOne(`/api/v1/budgets/${BUDGET_ID}`).flush({
      id: BUDGET_ID,
      number: 1,
      checkinId: CHECKIN_ID,
      status: 'borrador',
      subtotal: '25.00',
      tax: '3.75',
      total: '28.75',
      lines: [
        {
          id: 'l1',
          kind: 'mano_obra',
          description: 'Cambio de pastillas',
          quantity: '1',
          unitPrice: '25.00',
          lineTotal: '25.00',
        },
      ],
    });
    await render();
    expect(all('line-row')).toHaveLength(1);
    one('save-budget').click();
    const req = http.expectOne(`/api/v1/budgets/${BUDGET_ID}`);
    expect(req.request.method).toBe('PUT');
    req.flush(
      { status: 409, title: 'Conflict', currentStatus: 'enviado' },
      { status: 409, statusText: 'Conflict' },
    );
    await render();
    expect(one('budget-error').textContent).toContain('enviado');
  });
});
