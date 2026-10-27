// T011: detalle de un check-in (US2-AC1, US2-AC2).
// Contrato para el implementer (T012), archivo features/checkins/checkin-detail/checkin-detail.component.ts:
//   export class CheckinDetailComponent (standalone), ruta checkins/:id.
//   Las imágenes se piden con responseType 'blob' y se muestran con URL.createObjectURL.
// Selectores: damage-view-{view} (grupo por vista con sus daños), damage-item, damage-photo (<img>),
//   signature (<img>), not-found (404: "Check-in no encontrado").
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { CheckinDetailComponent } from './checkin-detail.component';

@Component({ template: '' })
class StubPage {}

const ID = 'c1111111-1111-4111-8111-111111111111';
const SIG = 'e1111111-1111-4111-8111-111111111111';
const PHOTO = 'e2222222-2222-4222-8222-222222222222';
const DETAIL = {
  id: ID,
  number: 1,
  createdAt: '2026-10-01T15:00:00.000Z',
  mileage: 85000,
  reason: 'ruido al frenar',
  createdByName: 'Luis',
  damageCount: 2,
  vehicleId: 'a1111111-1111-4111-8111-111111111111',
  ownerClientId: 'b1111111-1111-4111-8111-111111111111',
  ownerName: 'José Núñez',
  fuelLevel: '1/2',
  inventory: ['gata'],
  signatureImageId: SIG,
  damages: [
    { id: 'd1', view: 'izquierda', type: 'rayon', note: 'puerta', photoImageId: PHOTO },
    { id: 'd2', view: 'frente', type: 'golpe', note: null, photoImageId: null },
  ],
};

describe('CheckinDetailComponent (T011)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'checkins/:id', component: CheckinDetailComponent },
          { path: '**', component: StubPage },
        ]),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create(`/checkins/${ID}`);
  });

  const q = (sel: string) => harness.routeNativeElement!.querySelector<HTMLElement>(sel);
  async function settle(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
  }

  it('[US2-AC1] agrupa los daños por vista y carga fotos y firma como blob', async () => {
    http.expectOne(`/api/v1/checkins/${ID}`).flush(DETAIL);
    await settle();
    for (const imageId of [SIG, PHOTO]) {
      const req = http.expectOne(`/api/v1/checkins/${ID}/images/${imageId}`);
      expect(req.request.responseType).toBe('blob');
      req.flush(new Blob(['x'], { type: 'image/png' }));
    }
    await settle();
    expect(q('[data-testid="damage-view-izquierda"]')?.textContent).toContain('puerta');
    expect(q('[data-testid="damage-view-frente"] [data-testid="damage-item"]')).not.toBeNull();
    expect(q('[data-testid="damage-photo"]')?.getAttribute('src')).toBe('blob:mock');
    expect(q('[data-testid="signature"]')?.getAttribute('src')).toBe('blob:mock');
  });

  it('[US2-AC2] ante 404 muestra "no encontrado"', async () => {
    http
      .expectOne(`/api/v1/checkins/${ID}`)
      .flush({ type: 'about:blank', title: 'Not Found', status: 404 }, { status: 404, statusText: 'Not Found' });
    await settle();
    expect(q('[data-testid="not-found"]')?.textContent).toMatch(/no encontrado/i);
    expect(q('[data-testid="signature"]')).toBeNull();
  });
});
