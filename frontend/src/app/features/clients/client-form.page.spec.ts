// T027: formulario de nuevo cliente (US2 + edge cases "posible duplicado cédula/RUC" y "conexión inestable").
// Según research R8, el componente se prueba con ClientsApiService simulado.
//
// Contrato para el implementer (T028), archivo features/clients/client-form.page.ts:
//   export class ClientFormPage (standalone), ruta `clients/new`. Tras crear, navega a `/clients/{id}`.
//   ClientsApiService (T026): los errores con cuerpo Problem llegan como el Problem; los de red como
//   HttpErrorResponse con status 0.
// Selectores (data-testid):
//   client-type-natural, client-type-company           <input type="radio"> (por defecto: natural)
//   document-type-cedula, document-type-ruc, document-type-passport
//                                                      <input type="radio"> (por defecto: cedula). Con
//                                                      "Empresa" solo se renderiza document-type-ruc (marcado).
//   document-number, first-names, last-names, phone, email   <input> (natural)
//   business-name                                      <input> (solo empresa; first-names/last-names no se renderizan)
//   save                                               botón Guardar (submit del formulario)
//   error-<campo>                                      mensaje junto al campo, <campo> con el nombre del contrato:
//                                                      error-documentNumber, error-firstNames, error-lastNames,
//                                                      error-businessName, error-phone, error-email.
//                                                      El <input> con error lleva aria-invalid="true".
//   duplicate-message + open-existing-client           409 DOCUMENT_ALREADY_EXISTS: mensaje y <a> "Abrir cliente
//                                                      existente" con href /clients/{existingId}
//   possible-duplicate-warning                         advertencia no bloqueante (ver más abajo)
//   network-error + retry                              fallo de red (status 0): mensaje y botón "Reintentar"
// Posible duplicado: al perder el foco (blur) document-number con una cédula o un RUC válidos, el formulario
// llama a search(<10 primeros dígitos normalizados>). Si algún resultado es la contraparte (cédula X ↔ RUC X001),
// muestra possible-duplicate-warning con el displayName del cliente encontrado. Guardar sigue permitido.
// T049 (US3-AC9, "Registrar cliente nuevo" desde el formulario de vehículo; cambio en T050):
//   ?returnTo= se acepta solo si es una ruta interna (empieza por "/" y no por "//"). Tras crear, navega a
//   {returnTo}?clientId={id} en lugar de a /clients/{id}. Con returnTo válido se muestra cancel-return, un <a>
//   con href {returnTo} para volver sin crear. Un returnTo no válido se ignora.
//
// T078 (PR3, US4): modo edición, contrato para el implementer (T079).
//   Ruta `clients/:id/edit` en app.routes.ts (loadComponent de ClientFormPage, title "Editar cliente"), declarada
//   ANTES de `clients/:id`. El id sale del parámetro de ruta `id` (ActivatedRoute). En `clients/new` nada cambia.
//   Al abrir: ClientsApiService.getById(id) y precarga document-type-*, document-number, first-names, last-names
//   (o business-name), phone y email (null → ''). El <h1> dice "Editar cliente". El tipo de cliente no se puede
//   cambiar (contrato: clientType no está en ClientUpdate): client-type-natural / client-type-company no se
//   renderizan o están disabled.
//   Guardar llama a ClientsApiService.update(id, body: ClientUpdate) (nunca a create) y navega a /clients/{id}.
//   body: version = la versión cargada; los campos editados normalizados como en el alta (phone sin espacios ni
//   guiones, documentNumber normalizado, email '' → null). Puede llevar los campos sin cambios, pero nunca clientType
//   ni tenantId. Si documentNumber va en el body y no cambió, debe ser el valor guardado.
//   Motivo (FR-019): el campo `reason` (<textarea>, label con "Motivo") aparece SOLO si el documento (comparado ya
//   normalizado: 171003406-5 = 1710034065) o el tipo de documento difieren de lo guardado; si se vuelve al valor
//   guardado, desaparece. El rol sale de current-session (token de localStorage 'motorsync.token'):
//     asesor (o sin sesión): obligatorio; admin: opcional. Se recorta (trim); vacío o solo espacios = omitido (no se
//     envía `reason`). Si se informa, de 10 a 500 caracteres para ambos roles. Si no cumple: error-reason con
//     "El motivo es obligatorio (entre 10 y 500 caracteres)", reason con aria-invalid="true" y no se llama a update.
//     Un 400 del servidor con errors[{ field: 'reason', code: 'REASON_REQUIRED' }] también se muestra en error-reason.
//   409 VERSION_CONFLICT (US4-AC12): version-conflict (role="alert") con el texto "El registro cambió"; el formulario
//     se rellena con problem.current (o, si no viene current, con un nuevo getById(id)) y el siguiente guardado usa
//     esa versión. No navega.
//   409 DOCUMENT_ALREADY_EXISTS y errores de validación: igual que en el alta (duplicate-message, error-<campo>).
//   404 al cargar (inexistente o de otro taller): load-error con "Cliente no encontrado" y sin botón save.
//   US4-AC17: ningún botón ni enlace para eliminar, borrar ni desactivar.
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError, type Observable } from 'rxjs';
import type {
  ClientCreate,
  ClientDetail,
  ClientSearchResponse,
  ClientSummary,
  ClientUpdate,
  Problem,
} from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
import { signInAs, signOut } from '../../../testing/fake-jwt';
import { ClientFormPage } from './client-form.page';

@Component({ template: '' })
class ClientDetailStubPage {}

const CLIENT_ID = '7d1f0c1e-3b8a-4a52-9a43-2f1d8e0b6c11';
const EXISTING_ID = '0b9e7a51-6a0c-4f0e-8d1b-5c2a9e3f4d22';

const DETAIL: ClientDetail = {
  id: CLIENT_ID,
  clientType: 'natural',
  documentType: 'cedula',
  documentNumber: '1710034065',
  displayName: 'Ana María Pérez',
  firstNames: 'Ana María',
  lastNames: 'Pérez',
  businessName: null,
  phone: '0991234567',
  email: null,
  version: 1,
  vehicles: [],
  createdAt: '2026-10-21T15:00:00.000Z',
  updatedAt: '2026-10-21T15:00:00.000Z',
  updatedBy: '11111111-1111-4111-8111-111111111111',
  updatedByName: 'Asesor Uno',
};

const EMPTY_SEARCH: ClientSearchResponse = { items: [], hasMore: false };

function summary(extra: Partial<ClientSummary>): ClientSummary {
  return {
    id: EXISTING_ID,
    clientType: 'natural',
    documentType: 'ruc',
    documentNumber: '1710034065001',
    displayName: 'Ana María Pérez',
    phone: '0991234567',
    email: null,
    ...extra,
  };
}

function problem(status: number, code: Problem['code'], extra: Partial<Problem> = {}): Problem {
  return { type: 'about:blank', title: 'Error', status, code, ...extra };
}

const networkError = () => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error', url: '/api/v1/clients' });

describe('ClientFormPage (T027)', () => {
  let fixture: ComponentFixture<ClientFormPage>;
  let api: {
    create: ReturnType<typeof vi.fn<ClientsApiService['create']>>;
    getById: ReturnType<typeof vi.fn<ClientsApiService['getById']>>;
    search: ReturnType<typeof vi.fn<ClientsApiService['search']>>;
  };

  beforeEach(async () => {
    api = {
      create: vi.fn<ClientsApiService['create']>(() => of(DETAIL)),
      getById: vi.fn<ClientsApiService['getById']>(() => of(DETAIL)),
      search: vi.fn<ClientsApiService['search']>(() => of(EMPTY_SEARCH)),
    };
    await TestBed.configureTestingModule({
      imports: [ClientFormPage],
      providers: [
        provideRouter([{ path: 'clients/:clientId', component: ClientDetailStubPage }]),
        { provide: ClientsApiService, useValue: api },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ClientFormPage);
    await settle();
  });

  // --- utilidades de interacción (comportamiento observable en el DOM) ---

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${testId}"]`);
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = query<T>(testId);
    if (element === null) {
      throw new Error(`No existe [data-testid="${testId}"]`);
    }
    return element;
  }

  function text(testId: string): string {
    return get(testId).textContent?.trim() ?? '';
  }

  async function type(testId: string, value: string): Promise<void> {
    const input = get<HTMLInputElement>(testId);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function blur(testId: string): Promise<void> {
    get<HTMLInputElement>(testId).dispatchEvent(new Event('blur'));
    await settle();
  }

  async function click(testId: string): Promise<void> {
    get(testId).click();
    await settle();
  }

  async function fillValidNatural(): Promise<void> {
    await type('document-number', '1710034065');
    await type('first-names', 'Ana María');
    await type('last-names', 'Pérez');
    await type('phone', '099 123 4567');
  }

  function sentBody(call = 0): ClientCreate {
    return api.create.mock.calls[call][0];
  }

  const digitsOnly = (value: string) => value.replace(/[\s-]/g, '').toUpperCase();

  function currentUrl(): string {
    return TestBed.inject(Router).url;
  }

  // --- US2-AC1 ---

  it('[US2-AC1] por defecto es persona natural con cédula', () => {
    expect(get<HTMLInputElement>('client-type-natural').checked).toBe(true);
    expect(get<HTMLInputElement>('document-type-cedula').checked).toBe(true);
    expect(query('first-names')).not.toBeNull();
    expect(query('last-names')).not.toBeNull();
    expect(query('business-name')).toBeNull();
  });

  it('[US2-AC1] guarda una persona natural con cédula y navega a su ficha', async () => {
    await fillValidNatural();
    await click('save');

    expect(api.create).toHaveBeenCalledTimes(1);
    const body = sentBody();
    expect(body).toEqual(
      expect.objectContaining({
        clientType: 'natural',
        documentType: 'cedula',
        firstNames: 'Ana María',
        lastNames: 'Pérez',
      }),
    );
    expect(digitsOnly(body.documentNumber)).toBe('1710034065');
    expect(body.phone.replace(/[\s\-()]/g, '')).toBe('0991234567');
    expect(body.businessName).toBeUndefined();
    expect(Object.keys(body)).not.toContain('tenantId');
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}`);
  });

  // --- US2-AC2 ---

  it('[US2-AC2] con "Empresa" solo se ofrece RUC y se pide razón social en lugar de nombres y apellidos', async () => {
    await click('client-type-company');

    expect(query('document-type-ruc')).not.toBeNull();
    expect(get<HTMLInputElement>('document-type-ruc').checked).toBe(true);
    expect(query('document-type-cedula')).toBeNull();
    expect(query('document-type-passport')).toBeNull();
    expect(query('business-name')).not.toBeNull();
    expect(query('first-names')).toBeNull();
    expect(query('last-names')).toBeNull();
  });

  it('[US2-AC2] guarda una empresa con RUC y razón social', async () => {
    await click('client-type-company');
    await type('document-number', '1790011674001');
    await type('business-name', 'Talleres Andinos S.A.');
    await type('phone', '(02) 255-1234');
    await click('save');

    expect(api.create).toHaveBeenCalledTimes(1);
    const body = sentBody();
    expect(body).toEqual(
      expect.objectContaining({ clientType: 'company', documentType: 'ruc', businessName: 'Talleres Andinos S.A.' }),
    );
    expect(digitsOnly(body.documentNumber)).toBe('1790011674001');
    expect(body.firstNames).toBeUndefined();
    expect(body.lastNames).toBeUndefined();
  });

  it('[US2-AC2] una empresa sin razón social no se envía y marca el campo', async () => {
    await click('client-type-company');
    await type('document-number', '1790011674001');
    await type('phone', '022551234');
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    expect(text('error-businessName').length).toBeGreaterThan(0);
    expect(get('business-name').getAttribute('aria-invalid')).toBe('true');
  });

  // --- US2-AC3 ---

  it('[US2-AC3] guarda una persona natural con pasaporte alfanumérico de 5 a 20 caracteres', async () => {
    await click('document-type-passport');
    await fillValidNatural();
    await type('document-number', 'AB123456');
    await click('save');

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(sentBody().documentType).toBe('passport');
    expect(digitsOnly(sentBody().documentNumber)).toBe('AB123456');
  });

  it('[US2-AC3] un pasaporte de 4 caracteres muestra el error junto al campo y no se envía', async () => {
    await click('document-type-passport');
    await fillValidNatural();
    await type('document-number', 'A123');
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    expect(text('error-documentNumber')).toMatch(/pasaporte inválido/i);
    expect(get('document-number').getAttribute('aria-invalid')).toBe('true');
  });

  // --- US2-AC4 ---

  it.each([
    ['1710034064', 'dígito verificador incorrecto'],
    ['171003406', '9 dígitos'],
  ])('[US2-AC4] la cédula %s (%s) muestra "Cédula inválida" junto al campo y no se envía', async (cedula) => {
    await fillValidNatural();
    await type('document-number', cedula);
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    expect(text('error-documentNumber')).toBe('Cédula inválida');
    expect(get('document-number').getAttribute('aria-invalid')).toBe('true');
  });

  it('[US2-AC4] una cédula con guion (171003406-5) es válida y se envía', async () => {
    await fillValidNatural();
    await type('document-number', '171003406-5');
    await click('save');

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(query('error-documentNumber')).toBeNull();
  });

  // --- US2-AC5 ---

  it.each([
    ['1710034065002', 'no termina en 001'],
    ['1710034064001', 'los 10 primeros dígitos no son una cédula válida'],
    ['179001167400', '12 dígitos'],
  ])('[US2-AC5] el RUC %s (%s) muestra "RUC inválido" junto al campo y no se envía', async (ruc) => {
    await click('document-type-ruc');
    await fillValidNatural();
    await type('document-number', ruc);
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    expect(text('error-documentNumber')).toBe('RUC inválido');
  });

  it('[US2-AC5] una empresa con un RUC inválido muestra "RUC inválido"', async () => {
    await click('client-type-company');
    await type('document-number', '1770000000001');
    await type('business-name', 'Talleres Andinos S.A.');
    await type('phone', '022551234');
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    expect(text('error-documentNumber')).toBe('RUC inválido');
  });

  // --- US2-AC6 ---

  it('[US2-AC6] un 409 DOCUMENT_ALREADY_EXISTS muestra el mensaje y el enlace "Abrir cliente existente"', async () => {
    api.create.mockReturnValueOnce(
      throwError(() => problem(409, 'DOCUMENT_ALREADY_EXISTS', { existingId: EXISTING_ID })),
    );
    await fillValidNatural();
    await type('document-number', '171 003 406-5');
    await click('save');

    expect(text('duplicate-message')).toMatch(/documento ya está registrado/i);
    expect(text('duplicate-message')).not.toMatch(/otro taller/i);
    const link = get<HTMLAnchorElement>('open-existing-client');
    expect(link.textContent?.trim()).toMatch(/abrir cliente existente/i);
    expect(link.getAttribute('href')).toBe(`/clients/${EXISTING_ID}`);
    expect(currentUrl()).not.toBe(`/clients/${CLIENT_ID}`);
  });

  // --- US2-AC7 ---

  it('[US2-AC7] el correo es opcional: sin correo se guarda y se envía email vacío (null u omitido)', async () => {
    await fillValidNatural();
    await click('save');

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(sentBody().email ?? null).toBeNull();
    expect(query('error-email')).toBeNull();
  });

  it('[US2-AC7] un correo válido se envía', async () => {
    await fillValidNatural();
    await type('email', 'ana.perez@example.com');
    await click('save');

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(sentBody().email).toBe('ana.perez@example.com');
  });

  it('[US2-AC7] un correo con formato inválido marca el campo y no se envía', async () => {
    await fillValidNatural();
    await type('email', 'ana@');
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    expect(text('error-email')).toMatch(/correo/i);
    expect(get('email').getAttribute('aria-invalid')).toBe('true');
  });

  it.each([
    ['123456', 'menos de 7 dígitos'],
    ['1234567890123456', 'más de 15 dígitos'],
  ])('[US2-AC7] el teléfono %s (%s) marca el campo y no se envía', async (phone) => {
    await fillValidNatural();
    await type('phone', phone);
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    expect(text('error-phone')).toMatch(/teléfono/i);
    expect(get('phone').getAttribute('aria-invalid')).toBe('true');
  });

  it('[US2-AC7] los errors[] de un 400 del servidor se muestran junto a su campo', async () => {
    api.create.mockReturnValueOnce(
      throwError(() =>
        problem(400, 'VALIDATION_ERROR', { errors: [{ field: 'email', code: 'INVALID_EMAIL', message: 'x' }] }),
      ),
    );
    await fillValidNatural();
    await type('email', 'ana@example.com');
    await click('save');

    expect(text('error-email')).toBe('Correo electrónico inválido');
    expect(currentUrl()).not.toBe(`/clients/${CLIENT_ID}`);
  });

  // --- US2-AC8 ---

  it('[US2-AC8] una persona natural sin datos marca cada obligatorio faltante y no envía', async () => {
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    for (const [field, input] of [
      ['documentNumber', 'document-number'],
      ['firstNames', 'first-names'],
      ['lastNames', 'last-names'],
      ['phone', 'phone'],
    ]) {
      expect(text(`error-${field}`).length, `error-${field}`).toBeGreaterThan(0);
      expect(get(input).getAttribute('aria-invalid'), input).toBe('true');
    }
    expect(query('error-email')).toBeNull();
  });

  it('[US2-AC8] una empresa sin datos marca documento, razón social y teléfono, y no envía', async () => {
    await click('client-type-company');
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    for (const field of ['documentNumber', 'businessName', 'phone']) {
      expect(text(`error-${field}`).length, `error-${field}`).toBeGreaterThan(0);
    }
    expect(query('error-email')).toBeNull();
  });

  it('[US2-AC8] los nombres hechos solo de espacios cuentan como faltantes', async () => {
    await fillValidNatural();
    await type('first-names', '   ');
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    expect(text('error-firstNames').length).toBeGreaterThan(0);
  });

  // --- Edge case: persona natural con cédula y con RUC (posible duplicado, sin bloquear) ---

  it('[edge case posible duplicado] al salir de una cédula válida busca sus 10 dígitos y advierte si existe el RUC', async () => {
    api.search.mockReturnValue(of({ items: [summary({ documentType: 'ruc', documentNumber: '1710034065001' })], hasMore: false }));
    await type('document-number', '171003406-5');
    await blur('document-number');

    expect(api.search).toHaveBeenCalledWith('1710034065');
    expect(text('possible-duplicate-warning')).toMatch(/posible duplicado/i);
    expect(text('possible-duplicate-warning')).toContain('Ana María Pérez');
  });

  it('[edge case posible duplicado] con un RUC de persona natural busca los 10 primeros dígitos y advierte si existe la cédula', async () => {
    api.search.mockReturnValue(of({ items: [summary({ documentType: 'cedula', documentNumber: '1710034065' })], hasMore: false }));
    await click('document-type-ruc');
    await type('document-number', '1710034065001');
    await blur('document-number');

    expect(api.search).toHaveBeenCalledWith('1710034065');
    expect(text('possible-duplicate-warning')).toMatch(/posible duplicado/i);
  });

  it('[edge case posible duplicado] la advertencia no bloquea: se puede guardar igualmente', async () => {
    api.search.mockReturnValue(of({ items: [summary({})], hasMore: false }));
    await fillValidNatural();
    await blur('document-number');
    expect(query('possible-duplicate-warning')).not.toBeNull();

    await click('save');

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}`);
  });

  it('[edge case posible duplicado] no advierte si los resultados no son la contraparte cédula/RUC', async () => {
    api.search.mockReturnValue(
      of({
        items: [summary({ documentType: 'passport', documentNumber: 'P1710034065', displayName: 'Otra Persona' })],
        hasMore: false,
      }),
    );
    await type('document-number', '1710034065');
    await blur('document-number');

    expect(query('possible-duplicate-warning')).toBeNull();
  });

  it('[edge case posible duplicado] con pasaporte no busca posibles duplicados', async () => {
    await click('document-type-passport');
    await type('document-number', 'AB123456');
    await blur('document-number');

    expect(api.search).not.toHaveBeenCalled();
  });

  it('[edge case posible duplicado] si la búsqueda falla, no muestra advertencia y se puede guardar', async () => {
    api.search.mockReturnValue(throwError(networkError));
    await fillValidNatural();
    await blur('document-number');
    expect(query('possible-duplicate-warning')).toBeNull();

    await click('save');

    expect(api.create).toHaveBeenCalledTimes(1);
  });

  // --- Edge case: conexión inestable ---

  it('[edge case conexión inestable] un fallo de red conserva lo escrito y ofrece "Reintentar"', async () => {
    api.create.mockReturnValueOnce(throwError(networkError));
    await fillValidNatural();
    await type('email', 'ana.perez@example.com');
    await click('save');

    expect(query('network-error')).not.toBeNull();
    expect(text('retry')).toBe('Reintentar');
    expect(get<HTMLInputElement>('document-number').value).toBe('1710034065');
    expect(get<HTMLInputElement>('first-names').value).toBe('Ana María');
    expect(get<HTMLInputElement>('last-names').value).toBe('Pérez');
    expect(get<HTMLInputElement>('phone').value).toBe('099 123 4567');
    expect(get<HTMLInputElement>('email').value).toBe('ana.perez@example.com');
    expect(currentUrl()).not.toBe(`/clients/${CLIENT_ID}`);
  });

  it('[edge case conexión inestable] "Reintentar" reenvía los mismos datos y, si se guarda, navega a la ficha', async () => {
    api.create.mockReturnValueOnce(throwError(networkError)).mockReturnValueOnce(of(DETAIL));
    await fillValidNatural();
    await click('save');
    await click('retry');

    expect(api.create).toHaveBeenCalledTimes(2);
    expect(sentBody(1)).toEqual(sentBody(0));
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}`);
    expect(query('network-error')).toBeNull();
  });

  it('[edge case conexión inestable][US2-AC6] un reintento que recibe 409 ofrece abrir el registro existente', async () => {
    api.create
      .mockReturnValueOnce(throwError(networkError))
      .mockReturnValueOnce(throwError(() => problem(409, 'DOCUMENT_ALREADY_EXISTS', { existingId: EXISTING_ID })));
    await fillValidNatural();
    await click('save');
    await click('retry');

    expect(api.create).toHaveBeenCalledTimes(2);
    expect(text('duplicate-message')).toMatch(/documento ya está registrado/i);
    expect(get<HTMLAnchorElement>('open-existing-client').getAttribute('href')).toBe(`/clients/${EXISTING_ID}`);
    expect(query('network-error')).toBeNull();
  });
});

describe('ClientFormPage con ?returnTo= (T049, US3-AC9)', () => {
  let harness: RouterTestingHarness;
  let api: {
    create: ReturnType<typeof vi.fn<ClientsApiService['create']>>;
    getById: ReturnType<typeof vi.fn<ClientsApiService['getById']>>;
    search: ReturnType<typeof vi.fn<ClientsApiService['search']>>;
  };

  beforeEach(async () => {
    api = {
      create: vi.fn<ClientsApiService['create']>(() => of(DETAIL)),
      getById: vi.fn<ClientsApiService['getById']>(() => of(DETAIL)),
      search: vi.fn<ClientsApiService['search']>(() => of(EMPTY_SEARCH)),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'clients/new', component: ClientFormPage },
          { path: 'clients/:clientId', component: ClientDetailStubPage },
          { path: 'vehicles/new', component: ClientDetailStubPage },
        ]),
        { provide: ClientsApiService, useValue: api },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  async function settle(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  async function open(url: string): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
  }

  function root(): HTMLElement {
    return harness.routeNativeElement ?? (harness.fixture.nativeElement as HTMLElement);
  }

  function get<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = root().querySelector<T>(`[data-testid="${testId}"]`);
    if (element === null) {
      throw new Error(`No existe [data-testid="${testId}"]`);
    }
    return element;
  }

  async function type(testId: string, value: string): Promise<void> {
    const input = get<HTMLInputElement>(testId);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function createValidNatural(): Promise<void> {
    await type('document-number', '1710034065');
    await type('first-names', 'Ana María');
    await type('last-names', 'Pérez');
    await type('phone', '0991234567');
    get('save').click();
    await settle();
  }

  function currentUrl(): string {
    return TestBed.inject(Router).url;
  }

  it('[US3-AC9] tras crear el cliente vuelve a returnTo con clientId del cliente creado', async () => {
    await open('/clients/new?returnTo=%2Fvehicles%2Fnew');
    await createValidNatural();

    expect(api.create).toHaveBeenCalledTimes(1);
    const url = TestBed.inject(Router).parseUrl(currentUrl());
    expect(url.root.children['primary']?.segments.map((s) => s.path)).toEqual(['vehicles', 'new']);
    expect(url.queryParams['clientId']).toBe(CLIENT_ID);
  });

  it('[US3-AC9] con returnTo ofrece volver sin crear el cliente', async () => {
    await open('/clients/new?returnTo=%2Fvehicles%2Fnew');

    const back = get<HTMLAnchorElement>('cancel-return');
    expect(back.getAttribute('href')).toBe('/vehicles/new');

    back.click();
    await settle();
    expect(api.create).not.toHaveBeenCalled();
    expect(currentUrl()).toBe('/vehicles/new');
  });

  it.each(['https://evil.example/x', '//evil.example/x', 'vehicles/new'])(
    '[US3-AC9] un returnTo que no es una ruta interna (%s) se ignora y se navega a la ficha del cliente',
    async (returnTo) => {
      await open(`/clients/new?returnTo=${encodeURIComponent(returnTo)}`);

      expect(root().querySelector('[data-testid="cancel-return"]')).toBeNull();
      await createValidNatural();
      expect(currentUrl()).toBe(`/clients/${CLIENT_ID}`);
    },
  );

  it('[US3-AC9] sin returnTo se mantiene el comportamiento de US2-AC1 (navega a la ficha)', async () => {
    await open('/clients/new');

    expect(root().querySelector('[data-testid="cancel-return"]')).toBeNull();
    await createValidNatural();
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}`);
  });
});

describe('ClientFormPage en modo edición, clients/:id/edit (T078, US4)', () => {
  type UpdateClient = (clientId: string, body: ClientUpdate) => Observable<ClientDetail>;

  const REASON_MESSAGE = 'El motivo es obligatorio (entre 10 y 500 caracteres)';
  const VALID_REASON = 'Corrección por error de digitación';
  const NEW_CEDULA = '0912345675';

  const STORED: ClientDetail = {
    ...DETAIL,
    email: 'ana.perez@example.com',
    version: 3,
  };

  const COMPANY: ClientDetail = {
    ...DETAIL,
    clientType: 'company',
    documentType: 'ruc',
    documentNumber: '1790011674001',
    displayName: 'Talleres Andinos S.A.',
    firstNames: null,
    lastNames: null,
    businessName: 'Talleres Andinos S.A.',
    phone: '022551234',
    version: 5,
  };

  let harness: RouterTestingHarness;
  let api: {
    create: ReturnType<typeof vi.fn<ClientsApiService['create']>>;
    getById: ReturnType<typeof vi.fn<ClientsApiService['getById']>>;
    search: ReturnType<typeof vi.fn<ClientsApiService['search']>>;
    update: ReturnType<typeof vi.fn<UpdateClient>>;
  };

  beforeEach(async () => {
    localStorage.clear();
    signInAs('asesor');
    api = {
      create: vi.fn<ClientsApiService['create']>(() => of(DETAIL)),
      getById: vi.fn<ClientsApiService['getById']>(() => of(STORED)),
      search: vi.fn<ClientsApiService['search']>(() => of(EMPTY_SEARCH)),
      update: vi.fn<UpdateClient>((_id, body) => of({ ...STORED, version: body.version + 1 })),
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          { path: 'clients/:id/edit', component: ClientFormPage },
          { path: 'clients/:id', component: ClientDetailStubPage },
        ]),
        { provide: ClientsApiService, useValue: api },
      ],
    });
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // --- utilidades (comportamiento observable en el DOM) ---

  async function settle(): Promise<void> {
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  async function openEdit(clientId = CLIENT_ID): Promise<void> {
    await harness.navigateByUrl(`/clients/${clientId}/edit`);
    await settle();
  }

  function root(): HTMLElement {
    return harness.routeNativeElement ?? (harness.fixture.nativeElement as HTMLElement);
  }

  function query<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return root().querySelector<T>(`[data-testid="${testId}"]`);
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

  function value(testId: string): string {
    return get<HTMLInputElement>(testId).value;
  }

  async function type(testId: string, input: string): Promise<void> {
    const element = get<HTMLInputElement | HTMLTextAreaElement>(testId);
    element.value = input;
    element.dispatchEvent(new Event('input'));
    await settle();
  }

  async function click(testId: string): Promise<void> {
    get(testId).click();
    await settle();
  }

  function sentUpdate(call = 0): [string, ClientUpdate] {
    return api.update.mock.calls[call];
  }

  function currentUrl(): string {
    return TestBed.inject(Router).url;
  }

  function reasonLabel(): string {
    const label = root().querySelector('label[for="reason"]') ?? get('reason').closest('label');
    return label?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  // --- US4-AC4: carga y edición de datos de contacto ---

  it('[US4-AC4] carga el cliente del parámetro de ruta y precarga el formulario', async () => {
    await openEdit();

    expect(api.getById).toHaveBeenCalledWith(CLIENT_ID);
    expect(root().querySelector('h1')?.textContent).toMatch(/editar cliente/i);
    expect(get<HTMLInputElement>('document-type-cedula').checked).toBe(true);
    expect(value('document-number')).toBe('1710034065');
    expect(value('first-names')).toBe('Ana María');
    expect(value('last-names')).toBe('Pérez');
    expect(value('phone')).toBe('0991234567');
    expect(value('email')).toBe('ana.perez@example.com');
  });

  it('[US4-AC4] un correo null se precarga vacío, sin el texto "null"', async () => {
    api.getById.mockReturnValue(of({ ...STORED, email: null }));
    await openEdit();

    expect(value('document-number')).toBe('1710034065');
    expect(value('email')).toBe('');
  });

  it('[US4-AC4] el tipo de cliente no se puede cambiar en la edición', async () => {
    await openEdit();

    for (const testId of ['client-type-natural', 'client-type-company']) {
      const radio = query<HTMLInputElement>(testId);
      expect(radio === null || radio.disabled, testId).toBe(true);
    }
  });

  it('[US4-AC4] edita teléfono, correo y nombres: llama a update con version y navega a la ficha', async () => {
    await openEdit();
    await type('phone', '098 765 4321');
    await type('email', 'ana.nueva@example.com');
    await type('first-names', '  Ana Lucía ');
    await click('save');

    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).toHaveBeenCalledTimes(1);
    const [id, body] = sentUpdate();
    expect(id).toBe(CLIENT_ID);
    expect(body).toEqual(
      expect.objectContaining({
        version: 3,
        phone: '0987654321',
        email: 'ana.nueva@example.com',
        firstNames: 'Ana Lucía',
      }),
    );
    expect(Object.keys(body)).not.toContain('clientType');
    expect(Object.keys(body)).not.toContain('tenantId');
    expect(Object.keys(body)).not.toContain('reason');
    if (body.documentNumber !== undefined) {
      expect(body.documentNumber).toBe('1710034065');
    }
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}`);
  });

  it('[US4-AC4] vaciar el correo envía email null', async () => {
    await openEdit();
    await type('email', '   ');
    await click('save');

    expect(api.update).toHaveBeenCalledTimes(1);
    expect(sentUpdate()[1].email).toBeNull();
  });

  it('[US4-AC4] edita la razón social de una empresa', async () => {
    api.getById.mockReturnValue(of(COMPANY));
    await openEdit();

    expect(value('business-name')).toBe('Talleres Andinos S.A.');
    expect(query('first-names')).toBeNull();
    await type('business-name', 'Talleres Andinos Cía. Ltda.');
    await click('save');

    expect(api.update).toHaveBeenCalledTimes(1);
    expect(sentUpdate()[1]).toEqual(
      expect.objectContaining({ version: 5, businessName: 'Talleres Andinos Cía. Ltda.' }),
    );
    expect(Object.keys(sentUpdate()[1])).not.toContain('firstNames');
  });

  // --- US4-AC11: solo los identificadores piden motivo ---

  it('[US4-AC11] editar teléfono o correo no muestra el campo "Motivo"', async () => {
    await openEdit();
    expect(value('document-number')).toBe('1710034065');
    await type('phone', '0987654321');
    await type('email', 'otra@example.com');

    expect(query('reason')).toBeNull();
  });

  it('[US4-AC11] el mismo documento escrito con guion (171003406-5) no cuenta como cambio', async () => {
    await openEdit();
    await type('document-number', '171003406-5');

    expect(query('reason')).toBeNull();
    await click('save');

    expect(api.update).toHaveBeenCalledTimes(1);
    expect(Object.keys(sentUpdate()[1])).not.toContain('reason');
    expect(query('error-reason')).toBeNull();
  });

  it('[US4-AC11] cambiar el documento muestra el campo "Motivo" y volver al valor guardado lo oculta', async () => {
    await openEdit();
    await type('document-number', NEW_CEDULA);

    expect(query('reason')).not.toBeNull();
    expect(reasonLabel()).toMatch(/motivo/i);

    await type('document-number', '1710034065');
    expect(query('reason')).toBeNull();
  });

  it('[US4-AC11] cambiar el tipo de documento también pide motivo', async () => {
    await openEdit();
    await click('document-type-passport');
    await type('document-number', 'AB123456');

    expect(query('reason')).not.toBeNull();
  });

  // --- US4-AC15: asesor, motivo obligatorio ---

  it('[US4-AC15] asesor: cambiar el documento sin motivo no guarda e indica el mensaje junto al campo', async () => {
    await openEdit();
    await type('document-number', NEW_CEDULA);
    await click('save');

    expect(api.update).not.toHaveBeenCalled();
    expect(text('error-reason')).toBe(REASON_MESSAGE);
    expect(get('reason').getAttribute('aria-invalid')).toBe('true');
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}/edit`);
  });

  it('[US4-AC15] asesor: el campo "Motivo" se presenta como obligatorio', async () => {
    await openEdit();
    await type('document-number', NEW_CEDULA);

    expect(reasonLabel()).toMatch(/obligatorio/i);
  });

  it.each([
    ['solo espacios', '            '],
    ['9 caracteres sin contar los espacios de los extremos', '   123456789   '],
    ['501 caracteres', 'x'.repeat(501)],
  ])('[US4-AC15] asesor: un motivo de %s no guarda', async (_label, reason) => {
    await openEdit();
    await type('document-number', NEW_CEDULA);
    await type('reason', reason);
    await click('save');

    expect(api.update).not.toHaveBeenCalled();
    expect(text('error-reason')).toBe(REASON_MESSAGE);
  });

  it.each([
    ['10 caracteres', '1234567890', '1234567890'],
    ['500 caracteres', 'x'.repeat(500), 'x'.repeat(500)],
    ['espacios en los extremos', `   ${VALID_REASON}   `, VALID_REASON],
  ])('[US4-AC15][US4-AC11] asesor: con un motivo de %s envía documento normalizado y motivo recortado', async (_label, reason, sent) => {
    await openEdit();
    await type('document-number', '091234567-5');
    await type('reason', reason);
    await click('save');

    expect(api.update).toHaveBeenCalledTimes(1);
    expect(sentUpdate()[1]).toEqual(
      expect.objectContaining({ version: 3, documentType: 'cedula', documentNumber: NEW_CEDULA, reason: sent }),
    );
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}`);
  });

  it('[US4-AC15] sin sesión se aplica la regla del asesor (motivo obligatorio)', async () => {
    signOut();
    await openEdit();
    await type('document-number', NEW_CEDULA);
    await click('save');

    expect(api.update).not.toHaveBeenCalled();
    expect(text('error-reason')).toBe(REASON_MESSAGE);
  });

  it('[US4-AC15] un 400 REASON_REQUIRED del servidor se muestra en error-reason', async () => {
    api.update.mockReturnValueOnce(
      throwError(() =>
        problem(400, 'VALIDATION_ERROR', { errors: [{ field: 'reason', code: 'REASON_REQUIRED', message: 'x' }] }),
      ),
    );
    await openEdit();
    await type('document-number', NEW_CEDULA);
    await type('reason', VALID_REASON);
    await click('save');

    expect(text('error-reason')).toBe(REASON_MESSAGE);
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}/edit`);
  });

  // --- US4-AC16: administrador, motivo opcional ---

  it('[US4-AC16] admin: cambia el documento sin motivo y se envía sin reason', async () => {
    signInAs('admin');
    await openEdit();
    await type('document-number', NEW_CEDULA);

    expect(query('reason')).not.toBeNull();
    expect(reasonLabel()).toMatch(/opcional/i);
    await click('save');

    expect(api.update).toHaveBeenCalledTimes(1);
    const body = sentUpdate()[1];
    expect(body.documentNumber).toBe(NEW_CEDULA);
    expect(body.reason).toBeUndefined();
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}`);
  });

  it('[US4-AC16] admin: un motivo de solo espacios cuenta como omitido', async () => {
    signInAs('admin');
    await openEdit();
    await type('document-number', NEW_CEDULA);
    await type('reason', '     ');
    await click('save');

    expect(api.update).toHaveBeenCalledTimes(1);
    expect(sentUpdate()[1].reason).toBeUndefined();
  });

  it('[US4-AC16] admin: si informa un motivo válido, se envía', async () => {
    signInAs('admin');
    await openEdit();
    await type('document-number', NEW_CEDULA);
    await type('reason', VALID_REASON);
    await click('save');

    expect(sentUpdate()[1].reason).toBe(VALID_REASON);
  });

  it.each([
    ['5 caracteres', 'corto'],
    ['501 caracteres', 'x'.repeat(501)],
  ])('[US4-AC16] admin: un motivo de %s se rechaza con el mismo mensaje que para el asesor', async (_label, reason) => {
    signInAs('admin');
    await openEdit();
    await type('document-number', NEW_CEDULA);
    await type('reason', reason);
    await click('save');

    expect(api.update).not.toHaveBeenCalled();
    expect(text('error-reason')).toBe(REASON_MESSAGE);
  });

  // --- US4-AC5: mismas reglas que en el registro ---

  it('[US4-AC5] un documento inválido muestra "Cédula inválida" y no llama a update', async () => {
    await openEdit();
    await type('document-number', '1710034064');
    await type('reason', VALID_REASON);
    await click('save');

    expect(api.update).not.toHaveBeenCalled();
    expect(text('error-documentNumber')).toBe('Cédula inválida');
  });

  it('[US4-AC5] un teléfono inválido marca el campo y no llama a update', async () => {
    await openEdit();
    expect(value('first-names')).toBe('Ana María');
    await type('phone', '123');
    await click('save');

    expect(api.update).not.toHaveBeenCalled();
    expect(text('error-phone')).toMatch(/teléfono/i);
  });

  it('[US4-AC5] un 409 DOCUMENT_ALREADY_EXISTS ofrece abrir el cliente existente', async () => {
    api.update.mockReturnValueOnce(throwError(() => problem(409, 'DOCUMENT_ALREADY_EXISTS', { existingId: EXISTING_ID })));
    await openEdit();
    await type('document-number', NEW_CEDULA);
    await type('reason', VALID_REASON);
    await click('save');

    expect(text('duplicate-message')).toMatch(/documento ya está registrado/i);
    expect(get<HTMLAnchorElement>('open-existing-client').getAttribute('href')).toBe(`/clients/${EXISTING_ID}`);
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}/edit`);
  });

  // --- US4-AC12: concurrencia ---

  it('[US4-AC12] un 409 VERSION_CONFLICT avisa "El registro cambió" y muestra los datos actuales', async () => {
    const current: ClientDetail = { ...STORED, firstNames: 'Ana Lucía', phone: '0911111111', version: 4 };
    api.update.mockReturnValueOnce(throwError(() => problem(409, 'VERSION_CONFLICT', { current })));
    await openEdit();
    await type('phone', '0987654321');
    await click('save');

    expect(text('version-conflict')).toMatch(/el registro cambió/i);
    expect(get('version-conflict').getAttribute('role')).toBe('alert');
    expect(value('first-names')).toBe('Ana Lucía');
    expect(value('phone')).toBe('0911111111');
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}/edit`);
  });

  it('[US4-AC12] tras el conflicto se puede repetir la edición: el nuevo guardado usa la versión actual', async () => {
    const current: ClientDetail = { ...STORED, phone: '0911111111', version: 4 };
    api.update.mockReturnValueOnce(throwError(() => problem(409, 'VERSION_CONFLICT', { current })));
    await openEdit();
    await type('phone', '0987654321');
    await click('save');
    await type('phone', '0987654321');
    await click('save');

    expect(api.update).toHaveBeenCalledTimes(2);
    expect(sentUpdate(0)[1].version).toBe(3);
    expect(sentUpdate(1)[1]).toEqual(expect.objectContaining({ version: 4, phone: '0987654321' }));
    expect(currentUrl()).toBe(`/clients/${CLIENT_ID}`);
  });

  it('[US4-AC12] si el conflicto no trae current, vuelve a cargar el cliente', async () => {
    const reloaded: ClientDetail = { ...STORED, phone: '0922222222', version: 7 };
    api.update.mockReturnValueOnce(throwError(() => problem(409, 'VERSION_CONFLICT')));
    await openEdit();
    api.getById.mockReturnValue(of(reloaded));
    await type('phone', '0987654321');
    await click('save');

    expect(api.getById).toHaveBeenCalledTimes(2);
    expect(text('version-conflict')).toMatch(/el registro cambió/i);
    expect(value('phone')).toBe('0922222222');

    await type('phone', '0987654321');
    await click('save');
    expect(sentUpdate(1)[1].version).toBe(7);
  });

  // --- US4-AC13: cliente de otro taller o inexistente ---

  it('[US4-AC13] un 404 al cargar indica "Cliente no encontrado" y no ofrece guardar', async () => {
    api.getById.mockReturnValue(throwError(() => problem(404, 'NOT_FOUND')));
    await openEdit();

    expect(text('load-error')).toContain('Cliente no encontrado');
    expect(query('save')).toBeNull();
    expect(api.update).not.toHaveBeenCalled();
  });

  // --- US4-AC17: sin eliminación ---

  it.each(['asesor', 'admin'] as const)('[US4-AC17] %s: la edición no ofrece eliminar ni desactivar el cliente', async (role) => {
    signInAs(role);
    await openEdit();
    expect(value('document-number')).toBe('1710034065');

    const labels = Array.from(root().querySelectorAll('button, a, [role="button"]')).map(
      (element) => `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`,
    );
    expect(labels.join(' ')).not.toMatch(/eliminar|borrar|desactivar|dar de baja/i);
    expect(root().querySelector('[data-testid*="delete"], [data-testid*="deactivate"]')).toBeNull();
  });
});
