// T007: CheckinService contra specs/004-checkin-360/contracts/openapi.yaml.
// Contrato para el implementer (T008/T012), archivo features/checkins/checkin.service.ts:
//   @Injectable({ providedIn: 'root' }) export class CheckinService {
//     create(vehicleId: string, body: CheckinCreate): Observable<CheckinDetail>  // POST /api/v1/vehicles/{id}/checkins
//     list(vehicleId: string): Observable<CheckinSummary[]>                       // GET  /api/v1/vehicles/{id}/checkins
//     getById(checkinId: string): Observable<CheckinDetail>                      // GET  /api/v1/checkins/{id}
//     getImage(checkinId: string, imageId: string): Observable<Blob>             // GET  /api/v1/checkins/{id}/images/{imageId}
//   }
//   Los tipos CheckinCreate, CheckinDetail y CheckinSummary se exportan desde checkin.service.ts.
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CheckinService, type CheckinCreate } from './checkin.service';

const VEHICLE_ID = 'a1111111-1111-4111-8111-111111111111';
const BODY: CheckinCreate = {
  mileage: 85000,
  fuelLevel: '1/2',
  reason: 'ruido al frenar',
  inventory: ['gata'],
  damages: [{ view: 'izquierda', type: 'rayon', note: 'puerta' }],
  signature: { mime: 'image/png', base64: 'iVBORw0KGgo=' },
};

describe('CheckinService (T007)', () => {
  it('[US1-AC1] crea el check-in con POST /api/v1/vehicles/{id}/checkins y el cuerpo del contrato', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const http = TestBed.inject(HttpTestingController);
    let result: unknown;
    TestBed.inject(CheckinService)
      .create(VEHICLE_ID, BODY)
      .subscribe((r) => (result = r));
    const req = http.expectOne(`/api/v1/vehicles/${VEHICLE_ID}/checkins`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(BODY);
    req.flush({ id: 'c1', number: 1 }, { status: 201, statusText: 'Created' });
    expect(result).toEqual({ id: 'c1', number: 1 });
    http.verify();
  });
});
