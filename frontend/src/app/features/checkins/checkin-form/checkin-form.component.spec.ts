// T007: formulario de check-in (US1-AC1, US1-AC2, US1-AC3). HTTP simulado con HttpTestingController.
// Contrato para el implementer (T008), archivo features/checkins/checkin-form/checkin-form.component.ts:
//   export class CheckinFormComponent (standalone), ruta vehicles/:id/checkins/new; vehicleId por ActivatedRoute.
// Selectores (data-testid):
//   mileage (input number), fuel-level (select con los valores del contrato), reason (textarea),
//   signature-pad (host de <app-signature-pad>, que emite (signed) con { mime: 'image/png', base64 }),
//   save (button submit), error-signature / error-reason (mensaje por campo),
//   last-mileage (409: muestra lastMileage).
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { CheckinFormComponent } from './checkin-form.component';

@Component({ template: '' })
class StubPage {}

const VEHICLE_ID = 'a1111111-1111-4111-8111-111111111111';
const POST_URL = `/api/v1/vehicles/${VEHICLE_ID}/checkins`;
const SIGNATURE = { mime: 'image/png', base64: 'iVBORw0KGgo=' };

describe('CheckinFormComponent (T007)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'vehicles/:id/checkins/new', component: CheckinFormComponent },
          { path: '**', component: StubPage },
        ]),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create(`/vehicles/${VEHICLE_ID}/checkins/new`);
  });

  const el = (id: string) => harness.routeNativeElement!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  function type(id: string, value: string): void {
    const input = el(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
  }
  function sign(): void {
    harness.fixture.debugElement.query(By.css('[data-testid="signature-pad"]')).triggerEventHandler('signed', SIGNATURE);
  }
  async function settle(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
  }
  async function fillValid(): Promise<void> {
    type('mileage', '85000');
    type('fuel-level', '1/2');
    type('reason', 'ruido al frenar');
    sign();
    await settle();
  }
  async function save(): Promise<void> {
    el('save')!.click();
    await settle();
  }

  it('[US1-AC1] envía un payload válido según el contrato', async () => {
    await fillValid();
    await save();
    const req = http.expectOne(POST_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toMatchObject({
      mileage: 85000,
      fuelLevel: '1/2',
      reason: 'ruido al frenar',
      signature: SIGNATURE,
    });
  });

  it('[US1-AC2] no guarda sin firma y marca el campo', async () => {
    type('mileage', '85000');
    type('fuel-level', '1/2');
    type('reason', 'ruido al frenar');
    await settle();
    await save();
    http.expectNone(POST_URL);
    expect(el('error-signature')).not.toBeNull();
  });

  it('[US1-AC2] no guarda sin motivo y marca el campo', async () => {
    type('mileage', '85000');
    type('fuel-level', '1/2');
    sign();
    await settle();
    await save();
    http.expectNone(POST_URL);
    expect(el('error-reason')).not.toBeNull();
  });

  it('[US1-AC3] ante 409 muestra el último kilometraje registrado', async () => {
    await fillValid();
    await save();
    http
      .expectOne(POST_URL)
      .flush(
        { type: 'about:blank', title: 'Conflict', status: 409, lastMileage: 90000 },
        { status: 409, statusText: 'Conflict' },
      );
    await settle();
    expect(el('last-mileage')?.textContent).toMatch(/90\D?000/);
  });
});
