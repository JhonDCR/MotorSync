// T080: diálogo de transferencia de propietario (US4-AC7, US4-AC12, US4-AC15, US4-AC16, FR-018, FR-019).
// Según research R8, el componente se prueba con ClientsApiService y VehiclesApiService simulados.
//
// Contrato para el implementer (T081), archivo features/vehicles/transfer-ownership.dialog.ts:
//   export class TransferOwnershipDialog (standalone, selector app-transfer-ownership-dialog)
//     vehicle = input.required<VehicleDetail>()     vehículo a transferir (id, plate, version, owner)
//     transferred = output<VehicleDetail>()         tras un 200 de transferOwnership, con el vehículo devuelto
//     cancelled = output<void>()                    al pulsar transfer-cancel (no llama a la API)
//   Lo abre VehicleDetailPage (ver vehicle-detail.page.spec.ts).
//
// Flujo y selectores (data-testid):
//   transfer-dialog            contenedor con role="dialog" y aria-labelledby a un título que incluye la placa
//   transfer-current-owner     displayName del propietario actual
//   transfer-search            <input> para buscar el cliente destino por documento o nombre
//   transfer-search-button     llama a ClientsApiService.search(<término recortado>)
//   transfer-option            un botón por resultado (displayName y documentNumber); al pulsarlo queda elegido
//   transfer-no-results        "No se encontró ningún cliente"
//   transfer-selected          cliente destino elegido (displayName y documentNumber)
//   transfer-reason            <textarea> del motivo, con <label for="transfer-reason"> que dice "Motivo" y
//                              "obligatorio" (asesor o sin sesión) u "opcional" (admin). Rol de current-session.
//   error-transfer-reason      "El motivo es obligatorio (entre 10 y 500 caracteres)"; el textarea con aria-invalid.
//                              Recorte (trim); vacío o solo espacios = omitido; si se informa, 10 a 500 caracteres.
//   error-transfer-client      mensaje si se continúa sin elegir cliente destino
//   transfer-continue          valida (cliente elegido y motivo) y, si todo está bien, pasa a la confirmación
//   transfer-confirmation      resumen explícito (FR-018): placa, propietario actual y cliente destino
//   transfer-confirm           llama a VehiclesApiService.transferOwnership(vehicle.id,
//                              { newOwnerClientId, version, reason? }) (sin reason si se omitió)
//   transfer-back              vuelve al formulario conservando la elección y el motivo
//   transfer-cancel            cierra sin transferir (emite cancelled)
//   transfer-error             (role="alert") error de la operación. Tras cualquier error el diálogo vuelve al
//                              formulario conservando la elección y el motivo:
//                                422 SAME_OWNER → "El vehículo ya pertenece a este cliente"
//                                404 CLIENT_NOT_FOUND → "Cliente no encontrado"
//                                409 VERSION_CONFLICT → texto con "El registro cambió"; si trae current, el diálogo
//                                  usa current.version en el siguiente intento y muestra current.owner como
//                                  propietario actual.
//                              Un 400 con errors[{ field: 'reason', code: 'REASON_REQUIRED' }] se muestra en
//                              error-transfer-reason.
//   Ningún botón ni enlace para eliminar, borrar ni desactivar (US4-AC17).
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError, type Observable } from 'rxjs';
import type {
  ClientSearchResponse,
  ClientSummary,
  OwnershipTransferRequest,
  Problem,
  VehicleDetail,
} from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { VehiclesApiService } from '../../core/api/vehicles-api.service';
import { signInAs, signOut } from '../../../testing/fake-jwt';
import { TransferOwnershipDialog } from './transfer-ownership.dialog';

type TransferFn = (vehicleId: string, body: OwnershipTransferRequest) => Observable<VehicleDetail>;

const VEHICLE_ID = 'b2222222-2222-4222-8222-222222222222';
const OWNER_ID = '7d1f0c1e-3b8a-4a52-9a43-2f1d8e0b6c11';
const CARLOS_ID = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const REASON_MESSAGE = 'El motivo es obligatorio (entre 10 y 500 caracteres)';
const VALID_REASON = 'Venta del vehículo con contrato notariado';

function client(extra: Partial<ClientSummary> = {}): ClientSummary {
  return {
    id: OWNER_ID,
    clientType: 'natural',
    documentType: 'cedula',
    documentNumber: '1710034065',
    displayName: 'Ana Pérez',
    phone: '0991234567',
    email: null,
    ...extra,
  };
}

const ANA = client();
const CARLOS = client({ id: CARLOS_ID, documentNumber: '0912345675', displayName: 'Carlos Ruiz' });

const VEHICLE: VehicleDetail = {
  id: VEHICLE_ID,
  plate: 'PBA1234',
  brand: 'Toyota',
  model: 'Hilux',
  year: 2022,
  vin: null,
  color: 'Blanco',
  bodyType: 'pickup',
  initialMileage: 45000,
  version: 3,
  owner: ANA,
  createdAt: '2026-10-21T15:00:00.000Z',
  updatedAt: '2026-10-21T15:00:00.000Z',
  updatedBy: '11111111-1111-4111-8111-111111111111',
  updatedByName: 'Asesor Uno',
};

const TRANSFERRED: VehicleDetail = { ...VEHICLE, owner: CARLOS, version: 4 };

const SEARCH: ClientSearchResponse = { items: [CARLOS], hasMore: false };

function problem(status: number, code: Problem['code'], extra: Partial<Problem> = {}): Problem {
  return { type: 'about:blank', title: 'Error', status, code, ...extra };
}

describe('TransferOwnershipDialog (T080)', () => {
  let fixture: ComponentFixture<TransferOwnershipDialog>;
  let clientsApi: { search: ReturnType<typeof vi.fn<ClientsApiService['search']>> };
  let vehiclesApi: { transferOwnership: ReturnType<typeof vi.fn<TransferFn>> };
  let transferred: VehicleDetail[];
  let cancelled: number;

  async function render(vehicle: VehicleDetail = VEHICLE): Promise<void> {
    fixture = TestBed.createComponent(TransferOwnershipDialog);
    fixture.componentRef.setInput('vehicle', vehicle);
    fixture.componentInstance.transferred.subscribe((detail: VehicleDetail) => transferred.push(detail));
    fixture.componentInstance.cancelled.subscribe(() => (cancelled += 1));
    await settle();
  }

  beforeEach(async () => {
    localStorage.clear();
    signInAs('asesor');
    transferred = [];
    cancelled = 0;
    clientsApi = { search: vi.fn<ClientsApiService['search']>(() => of(SEARCH)) };
    vehiclesApi = { transferOwnership: vi.fn<TransferFn>(() => of(TRANSFERRED)) };
    await TestBed.configureTestingModule({
      imports: [TransferOwnershipDialog],
      providers: [
        { provide: ClientsApiService, useValue: clientsApi },
        { provide: VehiclesApiService, useValue: vehiclesApi },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // --- utilidades (comportamiento observable en el DOM) ---

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return root().querySelector<T>(`[data-testid="${testId}"]`);
  }

  function queryAll<T extends HTMLElement = HTMLElement>(testId: string): T[] {
    return Array.from(root().querySelectorAll<T>(`[data-testid="${testId}"]`));
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = query<T>(testId);
    if (element === null) {
      throw new Error(`No existe [data-testid="${testId}"]`);
    }
    return element;
  }

  function text(testId: string): string {
    return get(testId).textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  async function type(testId: string, value: string): Promise<void> {
    const element = get<HTMLInputElement | HTMLTextAreaElement>(testId);
    element.value = value;
    element.dispatchEvent(new Event('input'));
    await settle();
  }

  async function click(testId: string): Promise<void> {
    get(testId).click();
    await settle();
  }

  async function chooseCarlos(): Promise<void> {
    await type('transfer-search', '  carlos ');
    await click('transfer-search-button');
    queryAll('transfer-option')
      .find((option) => option.textContent?.includes('Carlos Ruiz'))
      ?.click();
    await settle();
  }

  async function confirmTransfer(reason: string | null = VALID_REASON): Promise<void> {
    await chooseCarlos();
    if (reason !== null) {
      await type('transfer-reason', reason);
    }
    await click('transfer-continue');
    await click('transfer-confirm');
  }

  function reasonLabel(): string {
    return root().querySelector('label[for="transfer-reason"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  function sentTransfer(call = 0): [string, OwnershipTransferRequest] {
    return vehiclesApi.transferOwnership.mock.calls[call];
  }

  // --- presentación ---

  it('[FR-018] es un diálogo accesible con la placa y el propietario actual', async () => {
    await render();

    const dialog = get('transfer-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(root().querySelector(`#${titleId}`)?.textContent).toContain('PBA1234');
    expect(text('transfer-current-owner')).toContain('Ana Pérez');
  });

  // --- US4-AC7: elegir el cliente destino con la búsqueda ---

  it('[US4-AC7] busca el cliente destino con la búsqueda de clientes y muestra nombre y documento', async () => {
    await render();
    await type('transfer-search', '  carlos ');
    await click('transfer-search-button');

    expect(clientsApi.search).toHaveBeenCalledWith('carlos');
    const options = queryAll('transfer-option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('Carlos Ruiz');
    expect(options[0].textContent).toContain('0912345675');
  });

  it('[US4-AC7] una búsqueda sin resultados indica "No se encontró ningún cliente"', async () => {
    clientsApi.search.mockReturnValue(of({ items: [], hasMore: false }));
    await render();
    await type('transfer-search', 'zzz');
    await click('transfer-search-button');

    expect(text('transfer-no-results')).toMatch(/no se encontró ningún cliente/i);
  });

  it('[US4-AC7] al elegir un resultado queda como cliente destino', async () => {
    await render();
    await chooseCarlos();

    expect(text('transfer-selected')).toContain('Carlos Ruiz');
    expect(text('transfer-selected')).toContain('0912345675');
  });

  it('[US4-AC7] no se puede continuar sin elegir el cliente destino', async () => {
    await render();
    await type('transfer-reason', VALID_REASON);
    await click('transfer-continue');

    expect(text('error-transfer-client').length).toBeGreaterThan(0);
    expect(query('transfer-confirmation')).toBeNull();
    expect(vehiclesApi.transferOwnership).not.toHaveBeenCalled();
  });

  // --- FR-018: confirmación explícita ---

  it('[US4-AC7][FR-018] "Continuar" pide confirmación explícita sin llamar todavía a la API', async () => {
    await render();
    await chooseCarlos();
    await type('transfer-reason', VALID_REASON);
    await click('transfer-continue');

    const summary = text('transfer-confirmation');
    expect(summary).toContain('PBA1234');
    expect(summary).toContain('Ana Pérez');
    expect(summary).toContain('Carlos Ruiz');
    expect(vehiclesApi.transferOwnership).not.toHaveBeenCalled();
  });

  it('[US4-AC7] al confirmar transfiere con el cliente elegido, la versión del vehículo y el motivo recortado', async () => {
    await render();
    await confirmTransfer(`   ${VALID_REASON}  `);

    expect(vehiclesApi.transferOwnership).toHaveBeenCalledTimes(1);
    const [vehicleId, body] = sentTransfer();
    expect(vehicleId).toBe(VEHICLE_ID);
    expect(body).toEqual({ newOwnerClientId: CARLOS_ID, version: 3, reason: VALID_REASON });
    expect(transferred).toEqual([TRANSFERRED]);
  });

  it('[US4-AC7] "Volver" desde la confirmación conserva la elección y el motivo, sin transferir', async () => {
    await render();
    await chooseCarlos();
    await type('transfer-reason', VALID_REASON);
    await click('transfer-continue');
    await click('transfer-back');

    expect(query('transfer-confirmation')).toBeNull();
    expect(text('transfer-selected')).toContain('Carlos Ruiz');
    expect(get<HTMLTextAreaElement>('transfer-reason').value).toBe(VALID_REASON);
    expect(vehiclesApi.transferOwnership).not.toHaveBeenCalled();
  });

  it('[FR-018] "Cancelar" cierra sin transferir', async () => {
    await render();
    await chooseCarlos();
    await click('transfer-cancel');

    expect(cancelled).toBe(1);
    expect(vehiclesApi.transferOwnership).not.toHaveBeenCalled();
    expect(transferred).toEqual([]);
  });

  // --- US4-AC15: asesor, motivo obligatorio ---

  it('[US4-AC15] asesor: el motivo se presenta como obligatorio', async () => {
    await render();

    expect(reasonLabel()).toMatch(/motivo/i);
    expect(reasonLabel()).toMatch(/obligatorio/i);
  });

  it.each([
    ['vacío', ''],
    ['solo espacios', '            '],
    ['9 caracteres sin contar los espacios de los extremos', '   123456789   '],
    ['501 caracteres', 'x'.repeat(501)],
  ])('[US4-AC15] asesor: un motivo %s no deja continuar', async (_label, reason) => {
    await render();
    await chooseCarlos();
    await type('transfer-reason', reason);
    await click('transfer-continue');

    expect(text('error-transfer-reason')).toBe(REASON_MESSAGE);
    expect(get('transfer-reason').getAttribute('aria-invalid')).toBe('true');
    expect(query('transfer-confirmation')).toBeNull();
    expect(vehiclesApi.transferOwnership).not.toHaveBeenCalled();
  });

  it.each([
    ['10 caracteres', '1234567890'],
    ['500 caracteres', 'x'.repeat(500)],
  ])('[US4-AC15] asesor: un motivo de %s es válido', async (_label, reason) => {
    await render();
    await confirmTransfer(reason);

    expect(sentTransfer()[1].reason).toBe(reason);
  });

  it('[US4-AC15] sin sesión se aplica la regla del asesor (motivo obligatorio)', async () => {
    signOut();
    await render();
    await chooseCarlos();
    await click('transfer-continue');

    expect(text('error-transfer-reason')).toBe(REASON_MESSAGE);
    expect(vehiclesApi.transferOwnership).not.toHaveBeenCalled();
  });

  it('[US4-AC15] un 400 REASON_REQUIRED del servidor se muestra junto al motivo', async () => {
    vehiclesApi.transferOwnership.mockReturnValueOnce(
      throwError(() =>
        problem(400, 'VALIDATION_ERROR', { errors: [{ field: 'reason', code: 'REASON_REQUIRED', message: 'x' }] }),
      ),
    );
    await render();
    await confirmTransfer();

    expect(text('error-transfer-reason')).toBe(REASON_MESSAGE);
    expect(transferred).toEqual([]);
  });

  // --- US4-AC16: administrador, motivo opcional ---

  it('[US4-AC16] admin: el motivo se presenta como opcional', async () => {
    signInAs('admin');
    await render();

    expect(reasonLabel()).toMatch(/opcional/i);
  });

  it.each([
    ['sin escribir nada', null],
    ['con solo espacios', '      '],
  ])('[US4-AC16] admin: transfiere %s y se envía sin reason', async (_label, reason) => {
    signInAs('admin');
    await render();
    await confirmTransfer(reason);

    expect(vehiclesApi.transferOwnership).toHaveBeenCalledTimes(1);
    expect(sentTransfer()[1]).toEqual({ newOwnerClientId: CARLOS_ID, version: 3 });
    expect(transferred).toEqual([TRANSFERRED]);
  });

  it('[US4-AC16] admin: si informa un motivo válido, se envía', async () => {
    signInAs('admin');
    await render();
    await confirmTransfer(VALID_REASON);

    expect(sentTransfer()[1].reason).toBe(VALID_REASON);
  });

  it.each([
    ['5 caracteres', 'corto'],
    ['501 caracteres', 'x'.repeat(501)],
  ])('[US4-AC16] admin: un motivo de %s se rechaza con el mismo mensaje que para el asesor', async (_label, reason) => {
    signInAs('admin');
    await render();
    await chooseCarlos();
    await type('transfer-reason', reason);
    await click('transfer-continue');

    expect(text('error-transfer-reason')).toBe(REASON_MESSAGE);
    expect(vehiclesApi.transferOwnership).not.toHaveBeenCalled();
  });

  // --- errores de la operación ---

  it('[US4-AC7] un 422 SAME_OWNER indica "El vehículo ya pertenece a este cliente" y no transfiere', async () => {
    vehiclesApi.transferOwnership.mockReturnValueOnce(throwError(() => problem(422, 'SAME_OWNER')));
    await render();
    await confirmTransfer();

    expect(text('transfer-error')).toBe('El vehículo ya pertenece a este cliente');
    expect(get('transfer-error').getAttribute('role')).toBe('alert');
    expect(transferred).toEqual([]);
    expect(text('transfer-selected')).toContain('Carlos Ruiz');
  });

  it('[US4-AC9] un 404 CLIENT_NOT_FOUND indica "Cliente no encontrado" y no transfiere', async () => {
    vehiclesApi.transferOwnership.mockReturnValueOnce(throwError(() => problem(404, 'CLIENT_NOT_FOUND')));
    await render();
    await confirmTransfer();

    expect(text('transfer-error')).toContain('Cliente no encontrado');
    expect(transferred).toEqual([]);
  });

  it('[US4-AC12] un 409 VERSION_CONFLICT avisa "El registro cambió" y muestra el propietario actual', async () => {
    const luis = client({ id: 'f6666666-6666-4666-8666-666666666666', displayName: 'Luis Mora' });
    const current: VehicleDetail = { ...VEHICLE, owner: luis, version: 5 };
    vehiclesApi.transferOwnership.mockReturnValueOnce(throwError(() => problem(409, 'VERSION_CONFLICT', { current })));
    await render();
    await confirmTransfer();

    expect(text('transfer-error')).toMatch(/el registro cambió/i);
    expect(text('transfer-current-owner')).toContain('Luis Mora');
    expect(transferred).toEqual([]);
  });

  it('[US4-AC12] tras el conflicto, repetir la transferencia usa la versión actual', async () => {
    const current: VehicleDetail = { ...VEHICLE, version: 5 };
    vehiclesApi.transferOwnership
      .mockReturnValueOnce(throwError(() => problem(409, 'VERSION_CONFLICT', { current })))
      .mockReturnValueOnce(of({ ...TRANSFERRED, version: 6 }));
    await render();
    await confirmTransfer();
    await click('transfer-continue');
    await click('transfer-confirm');

    expect(vehiclesApi.transferOwnership).toHaveBeenCalledTimes(2);
    expect(sentTransfer(0)[1].version).toBe(3);
    expect(sentTransfer(1)[1]).toEqual({ newOwnerClientId: CARLOS_ID, version: 5, reason: VALID_REASON });
    expect(transferred).toHaveLength(1);
  });

  // --- US4-AC17 ---

  it('[US4-AC17] el diálogo no ofrece eliminar ni desactivar', async () => {
    await render();
    await chooseCarlos();

    const labels = Array.from(root().querySelectorAll('button, a, [role="button"]')).map(
      (element) => `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`,
    );
    expect(labels.join(' ')).not.toMatch(/eliminar|borrar|desactivar|dar de baja/i);
  });
});
