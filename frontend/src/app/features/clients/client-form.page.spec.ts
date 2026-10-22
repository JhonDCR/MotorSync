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
import { HttpErrorResponse } from '@angular/common/http';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import type { ClientCreate, ClientDetail, ClientSearchResponse, ClientSummary, Problem } from '../../core/api/api.models';
import { ClientsApiService } from '../../core/api/clients-api.service';
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
