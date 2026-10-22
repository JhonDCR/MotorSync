import { Injectable } from '@angular/core';
import { isValidCedula, isValidPassport, isValidRuc } from '../../shared/identifiers/ec-document';
import { isValidEmail, normalizeEmail } from '../../shared/identifiers/email';
import { normalizeDocument } from '../../shared/identifiers/normalize';
import { isValidPhone, normalizePhone } from '../../shared/identifiers/phone';
import { isBodyType, isValidPlate, normalizePlateForWrite } from '../../shared/identifiers/plate';
import { isValidVin, normalizeVin } from '../../shared/identifiers/vin';
import { MAX_MILEAGE, maxVehicleYear, MIN_VEHICLE_YEAR } from '../../shared/validators/vehicle.validators';
import type {
  BodyType,
  ClientDetail,
  ClientSearchResponse,
  ClientSummary,
  ClientType,
  DocumentType,
  FieldError,
  Problem,
  ProblemCode,
  VehicleDetail,
  VehicleSummary,
} from './api.models';

// In-memory data of the mock API (research R8). It lives in the root injector, so every TestBed
// (and every page load in `ng serve --configuration mock`) starts with its own store.
// Validation mirrors backend/src/clients/dto/create-client.dto.ts, backend/src/vehicles/dto/create-vehicle.dto.ts
// and the contract FieldError codes.

export type MockResult<T> = { ok: true; status: number; body: T } | { ok: false; problem: Problem };

const MOCK_USER = { id: '11111111-1111-4111-8111-111111111111', name: 'Asesor de prueba' };
const SEARCH_LIMIT = 20;
const MIN_SEARCH_LENGTH = 2;
const MAX_SEARCH_LENGTH = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLIENT_CREATE_FIELDS = [
  'clientType',
  'documentType',
  'documentNumber',
  'firstNames',
  'lastNames',
  'businessName',
  'phone',
  'email',
] as const;

const CLIENT_TYPES: readonly ClientType[] = ['natural', 'company'];
const DOCUMENT_TYPES: readonly DocumentType[] = ['cedula', 'ruc', 'passport'];
const ALLOWED_DOCUMENT_TYPES: Record<ClientType, readonly DocumentType[]> = {
  natural: ['cedula', 'ruc', 'passport'],
  company: ['ruc'],
};

const DOCUMENT_RULES: Record<DocumentType, { code: string; message: string; isValid: (v: string) => boolean }> = {
  cedula: {
    code: 'INVALID_CEDULA',
    message: 'Cédula inválida: deben ser 10 dígitos con provincia y dígito verificador válidos',
    isValid: isValidCedula,
  },
  ruc: { code: 'INVALID_RUC', message: 'RUC inválido: deben ser 13 dígitos terminados en 001', isValid: isValidRuc },
  passport: { code: 'INVALID_PASSPORT', message: 'Pasaporte inválido: de 5 a 20 letras o dígitos', isValid: isValidPassport },
};

const REQUIRED: Omit<FieldError, 'field'> = { code: 'REQUIRED', message: 'Campo obligatorio' };
const MUST_BE_TEXT = 'Debe ser texto';

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
};

export function mockProblem(status: number, code: ProblemCode, extra: Partial<Problem> = {}): Problem {
  return { type: 'about:blank', title: STATUS_TITLES[status] ?? 'Error', status, code, ...extra };
}

function fail<T>(status: number, code: ProblemCode, extra: Partial<Problem> = {}): MockResult<T> {
  return { ok: false, problem: mockProblem(status, code, extra) };
}

/** Lowercase, without accents: name search ignores case and diacritics (FR-004). */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Search normalization of a document: any non-alphanumeric character is discarded (FR-002). */
function searchDocument(value: string): string {
  return fold(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function newId(): string {
  const cryptoApi: Crypto | undefined = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === 'x' ? random : (random % 4) + 8).toString(16);
  });
}

function toSummary(client: ClientDetail): ClientSummary {
  return {
    id: client.id,
    clientType: client.clientType,
    documentType: client.documentType,
    documentNumber: client.documentNumber,
    displayName: client.displayName,
    phone: client.phone,
    email: client.email,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validated and normalized ClientCreate. */
interface ValidClient {
  clientType: ClientType;
  documentType: DocumentType;
  documentNumber: string;
  firstNames: string | null;
  lastNames: string | null;
  businessName: string | null;
  phone: string;
  email: string | null;
}

class FieldErrors {
  readonly list: FieldError[] = [];

  add(field: string, code: string, message: string): void {
    this.list.push({ field, code, message });
  }
}

function readText(
  body: Record<string, unknown>,
  field: string,
  errors: FieldErrors,
  code = 'VALIDATION_ERROR',
): string | null {
  const value = body[field];
  if (value === undefined || value === null) {
    errors.add(field, REQUIRED.code, REQUIRED.message);
    return null;
  }
  if (typeof value !== 'string') {
    errors.add(field, code, MUST_BE_TEXT);
    return null;
  }
  return value;
}

/** A name is validated when it applies to the client type, or when it is sent anyway (as the backend). */
function readName(
  body: Record<string, unknown>,
  field: string,
  applies: boolean,
  maxLength: number,
  errors: FieldErrors,
): string | null {
  if (!applies && body[field] === undefined) return null;
  const value = readText(body, field, errors);
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') {
    errors.add(field, REQUIRED.code, REQUIRED.message);
    return null;
  }
  if (trimmed.length > maxLength) {
    errors.add(field, 'VALIDATION_ERROR', `Admite como máximo ${maxLength} caracteres`);
    return null;
  }
  return trimmed;
}

function validateClientCreate(raw: unknown): { client: ValidClient } | { errors: FieldError[] } {
  const errors = new FieldErrors();
  if (!isRecord(raw)) {
    errors.add('body', 'VALIDATION_ERROR', 'El cuerpo debe ser un objeto JSON');
    return { errors: errors.list };
  }
  // Undefined values are dropped by JSON serialization: they count as absent.
  const body = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));

  for (const key of Object.keys(body)) {
    if (!(CLIENT_CREATE_FIELDS as readonly string[]).includes(key)) {
      errors.add(key, 'UNKNOWN_FIELD', 'Campo no permitido');
    }
  }

  const clientTypeValue = body['clientType'];
  let clientType: ClientType | null = null;
  if (clientTypeValue === undefined || clientTypeValue === null) {
    errors.add('clientType', REQUIRED.code, REQUIRED.message);
  } else if (!CLIENT_TYPES.includes(clientTypeValue as ClientType)) {
    errors.add('clientType', 'VALIDATION_ERROR', 'Tipo de cliente inválido: natural o company');
  } else {
    clientType = clientTypeValue as ClientType;
  }

  const documentTypeValue = body['documentType'];
  let documentType: DocumentType | null = null;
  if (documentTypeValue === undefined || documentTypeValue === null) {
    errors.add('documentType', REQUIRED.code, REQUIRED.message);
  } else if (!DOCUMENT_TYPES.includes(documentTypeValue as DocumentType)) {
    errors.add('documentType', 'INVALID_DOCUMENT_TYPE', 'Tipo de documento inválido: cedula, ruc o passport');
  } else if (clientType !== null && !ALLOWED_DOCUMENT_TYPES[clientType].includes(documentTypeValue as DocumentType)) {
    errors.add('documentType', 'INVALID_DOCUMENT_TYPE', 'Una empresa solo puede registrarse con RUC');
  } else {
    documentType = documentTypeValue as DocumentType;
  }

  let documentNumber = readText(body, 'documentNumber', errors);
  if (documentNumber !== null) {
    documentNumber = normalizeDocument(documentNumber);
    if (documentNumber.length > 30) {
      errors.add('documentNumber', 'VALIDATION_ERROR', 'El documento admite como máximo 30 caracteres');
    } else if (documentType !== null && !DOCUMENT_RULES[documentType].isValid(documentNumber)) {
      const rule = DOCUMENT_RULES[documentType];
      errors.add('documentNumber', rule.code, rule.message);
    }
  }

  const firstNames = readName(body, 'firstNames', clientType === 'natural', 100, errors);
  const lastNames = readName(body, 'lastNames', clientType === 'natural', 100, errors);
  const businessName = readName(body, 'businessName', clientType === 'company', 200, errors);

  let phone = readText(body, 'phone', errors, 'INVALID_PHONE');
  if (phone !== null) {
    phone = normalizePhone(phone);
    if (phone.length > 25) {
      errors.add('phone', 'INVALID_PHONE', 'El teléfono admite como máximo 25 caracteres');
    } else if (!isValidPhone(phone)) {
      errors.add('phone', 'INVALID_PHONE', 'Teléfono inválido: de 7 a 15 dígitos, opcionalmente con + al inicio');
    }
  }

  let email: string | null = null;
  const emailValue = body['email'];
  if (emailValue !== undefined && emailValue !== null) {
    if (typeof emailValue !== 'string') {
      errors.add('email', 'INVALID_EMAIL', MUST_BE_TEXT);
    } else {
      email = normalizeEmail(emailValue);
      if (!isValidEmail(email)) {
        errors.add('email', 'INVALID_EMAIL', 'Correo electrónico inválido');
      }
    }
  }

  if (errors.list.length > 0 || clientType === null || documentType === null || documentNumber === null || phone === null) {
    return { errors: errors.list };
  }
  const isNatural = clientType === 'natural';
  return {
    client: {
      clientType,
      documentType,
      documentNumber,
      firstNames: isNatural ? firstNames : null,
      lastNames: isNatural ? lastNames : null,
      businessName: isNatural ? null : businessName,
      phone,
      email,
    },
  };
}

const VEHICLE_CREATE_FIELDS = [
  'ownerClientId',
  'plate',
  'vin',
  'brand',
  'model',
  'year',
  'color',
  'bodyType',
  'initialMileage',
] as const;

const VEHICLE_TEXT_MAX_LENGTH = 60;
const CAR_PLATE_MESSAGE = 'Placa inválida: para autos use 3 letras y 3 o 4 dígitos (ej. PBA1234)';
const MOTORCYCLE_PLATE_MESSAGE = 'Placa inválida: para motos use 2 letras, 3 dígitos y 1 letra (ej. AB123C)';
const MILEAGE_MESSAGE = `Kilometraje inválido: entero entre 0 y ${MAX_MILEAGE}`;

/** Validated and normalized VehicleCreate. */
interface ValidVehicle {
  ownerClientId: string;
  plate: string;
  vin: string | null;
  brand: string;
  model: string;
  year: number;
  color: string;
  bodyType: BodyType;
  initialMileage: number;
}

/** Stored vehicle: the detail without the owner snapshot, which is read from the clients map. */
type VehicleRecord = Omit<VehicleDetail, 'owner'> & { ownerClientId: string };

function readVehicleText(body: Record<string, unknown>, field: string, label: string, errors: FieldErrors): string | null {
  const value = readText(body, field, errors);
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') {
    errors.add(field, REQUIRED.code, REQUIRED.message);
    return null;
  }
  if (trimmed.length > VEHICLE_TEXT_MAX_LENGTH) {
    errors.add(field, 'VALIDATION_ERROR', `${label} admite como máximo ${VEHICLE_TEXT_MAX_LENGTH} caracteres`);
    return null;
  }
  return trimmed;
}

interface IntegerRule {
  min: number;
  max: number;
  code: string;
  message: string;
}

/** As the backend: only a JSON integer is accepted, never a numeric string. */
function readInteger(body: Record<string, unknown>, field: string, rule: IntegerRule, errors: FieldErrors): number | null {
  const value = body[field];
  if (value === undefined || value === null) {
    errors.add(field, REQUIRED.code, REQUIRED.message);
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < rule.min || value > rule.max) {
    errors.add(field, rule.code, rule.message);
    return null;
  }
  return value;
}

function readOwnerClientId(body: Record<string, unknown>, errors: FieldErrors): string | null {
  const value = body['ownerClientId'];
  if (value === undefined || value === null) {
    errors.add('ownerClientId', REQUIRED.code, REQUIRED.message);
    return null;
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    errors.add('ownerClientId', 'VALIDATION_ERROR', 'Identificador de cliente inválido');
    return null;
  }
  return value.toLowerCase();
}

function readBodyType(body: Record<string, unknown>, errors: FieldErrors): BodyType | null {
  const value = body['bodyType'];
  if (value === undefined || value === null) {
    errors.add('bodyType', REQUIRED.code, REQUIRED.message);
    return null;
  }
  if (!isBodyType(value)) {
    errors.add('bodyType', 'VALIDATION_ERROR', 'Carrocería inválida: sedan, suv, pickup, motorcycle u other');
    return null;
  }
  return value;
}

/** The format depends on the body type (FR-007); symbols are rejected, never cleaned (US3-AC14). */
function readPlate(body: Record<string, unknown>, bodyType: BodyType | null, errors: FieldErrors): string | null {
  const value = readText(body, 'plate', errors, 'INVALID_PLATE');
  if (value === null) return null;
  const normalized = normalizePlateForWrite(value);
  // An unknown body type is reported on bodyType only, as the backend.
  const effectiveType = bodyType ?? 'sedan';
  if (normalized === null || (bodyType !== null && !isValidPlate(normalized, effectiveType))) {
    errors.add('plate', 'INVALID_PLATE', effectiveType === 'motorcycle' ? MOTORCYCLE_PLATE_MESSAGE : CAR_PLATE_MESSAGE);
    return null;
  }
  return normalized;
}

function readVin(body: Record<string, unknown>, errors: FieldErrors): string | null {
  const value = body['vin'];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.add('vin', 'INVALID_VIN', MUST_BE_TEXT);
    return null;
  }
  const normalized = normalizeVin(value);
  if (normalized === null || !isValidVin(normalized)) {
    errors.add('vin', 'INVALID_VIN', 'VIN inválido: 17 letras o dígitos, sin I, O ni Q');
    return null;
  }
  return normalized;
}

function validateVehicleCreate(raw: unknown): { vehicle: ValidVehicle } | { errors: FieldError[] } {
  const errors = new FieldErrors();
  if (!isRecord(raw)) {
    errors.add('body', 'VALIDATION_ERROR', 'El cuerpo debe ser un objeto JSON');
    return { errors: errors.list };
  }
  // Undefined values are dropped by JSON serialization: they count as absent.
  const body = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));

  for (const key of Object.keys(body)) {
    if (!(VEHICLE_CREATE_FIELDS as readonly string[]).includes(key)) {
      errors.add(key, 'UNKNOWN_FIELD', 'Campo no permitido');
    }
  }

  const ownerClientId = readOwnerClientId(body, errors);
  const bodyType = readBodyType(body, errors);
  const plate = readPlate(body, bodyType, errors);
  const vin = readVin(body, errors);
  const brand = readVehicleText(body, 'brand', 'La marca', errors);
  const model = readVehicleText(body, 'model', 'El modelo', errors);
  const color = readVehicleText(body, 'color', 'El color', errors);
  const maxYear = maxVehicleYear();
  const year = readInteger(
    body,
    'year',
    {
      min: MIN_VEHICLE_YEAR,
      max: maxYear,
      code: 'INVALID_YEAR',
      message: `Año inválido: entero entre ${MIN_VEHICLE_YEAR} y ${maxYear}`,
    },
    errors,
  );
  const initialMileage = readInteger(
    body,
    'initialMileage',
    { min: 0, max: MAX_MILEAGE, code: 'INVALID_MILEAGE', message: MILEAGE_MESSAGE },
    errors,
  );

  if (
    errors.list.length > 0 ||
    ownerClientId === null ||
    bodyType === null ||
    plate === null ||
    brand === null ||
    model === null ||
    color === null ||
    year === null ||
    initialMileage === null
  ) {
    return { errors: errors.list };
  }
  return { vehicle: { ownerClientId, plate, vin, brand, model, year, color, bodyType, initialMileage } };
}

function displayNameOf(client: ValidClient): string {
  if (client.clientType === 'company') return client.businessName ?? '';
  return [client.firstNames, client.lastNames].filter((part) => part !== null && part !== '').join(' ');
}

// Seed data for `ng serve --configuration mock`. It must not use the documents or names of the tests.
const SEED: ValidClient[] = [
  {
    clientType: 'natural',
    documentType: 'cedula',
    documentNumber: '1104567894',
    firstNames: 'Carmen Lucía',
    lastNames: 'Andrade Vega',
    businessName: null,
    phone: '0987654321',
    email: 'carmen.andrade@example.com',
  },
  {
    // Natural person with RUC: typing the cedula 0922334453 shows the possible duplicate warning.
    clientType: 'natural',
    documentType: 'ruc',
    documentNumber: '0922334453001',
    firstNames: 'Luis Fernando',
    lastNames: 'Mora Ortega',
    businessName: null,
    phone: '042345678',
    email: null,
  },
  {
    clientType: 'company',
    documentType: 'ruc',
    documentNumber: '1791234567001',
    firstNames: null,
    lastNames: null,
    businessName: 'Repuestos del Pacífico S.A.',
    phone: '+59322501234',
    email: 'ventas@repuestospacifico.example.com',
  },
];

// Seed vehicles, owned by SEED[owner]. Plates and VINs are not the ones of the tests.
const SEED_VEHICLES: (Omit<ValidVehicle, 'ownerClientId'> & { owner: number })[] = [
  {
    owner: 0,
    plate: 'PCD4521',
    vin: '3VWFE21C04M000123',
    brand: 'Chevrolet',
    model: 'Aveo',
    year: 2018,
    color: 'Gris',
    bodyType: 'sedan',
    initialMileage: 98000,
  },
  {
    owner: 1,
    plate: 'IB482K',
    vin: null,
    brand: 'Yamaha',
    model: 'FZ25',
    year: 2023,
    color: 'Azul',
    bodyType: 'motorcycle',
    initialMileage: 3500,
  },
];

@Injectable({ providedIn: 'root' })
export class MockApiStore {
  private readonly clients = new Map<string, ClientDetail>();
  private readonly vehicles = new Map<string, VehicleRecord>();

  constructor() {
    const seeded = SEED.map((client) => this.insert(client));
    for (const { owner, ...vehicle } of SEED_VEHICLES) {
      this.insertVehicle({ ...vehicle, ownerClientId: seeded[owner].id });
    }
  }

  createClient(raw: unknown): MockResult<ClientDetail> {
    const result = validateClientCreate(raw);
    if ('errors' in result) {
      return fail(400, 'VALIDATION_ERROR', { errors: result.errors });
    }
    const existing = [...this.clients.values()].find((c) => c.documentNumber === result.client.documentNumber);
    if (existing) {
      return fail(409, 'DOCUMENT_ALREADY_EXISTS', { existingId: existing.id });
    }
    return { ok: true, status: 201, body: structuredClone(this.insert(result.client)) };
  }

  getClient(clientId: string): MockResult<ClientDetail> {
    const client = UUID_PATTERN.test(clientId) ? this.clients.get(clientId.toLowerCase()) : undefined;
    if (!client) return fail(404, 'NOT_FOUND');
    return { ok: true, status: 200, body: { ...structuredClone(client), vehicles: this.vehiclesOf(client.id) } };
  }

  createVehicle(raw: unknown): MockResult<VehicleDetail> {
    const result = validateVehicleCreate(raw);
    if ('errors' in result) {
      return fail(400, 'VALIDATION_ERROR', { errors: result.errors });
    }
    const { vehicle } = result;
    // US3-AC11: the owner must exist (a client of another tenant is indistinguishable from a missing one).
    if (!this.clients.has(vehicle.ownerClientId)) {
      return fail(404, 'CLIENT_NOT_FOUND');
    }
    const all = [...this.vehicles.values()];
    const samePlate = all.find((v) => v.plate === vehicle.plate);
    if (samePlate) {
      return fail(409, 'PLATE_ALREADY_EXISTS', { existingId: samePlate.id });
    }
    const sameVin = vehicle.vin === null ? undefined : all.find((v) => v.vin === vehicle.vin);
    if (sameVin) {
      return fail(409, 'VIN_ALREADY_EXISTS', { existingId: sameVin.id });
    }
    return { ok: true, status: 201, body: this.toVehicleDetail(this.insertVehicle(vehicle)) };
  }

  getVehicle(vehicleId: string): MockResult<VehicleDetail> {
    const vehicle = UUID_PATTERN.test(vehicleId) ? this.vehicles.get(vehicleId.toLowerCase()) : undefined;
    if (!vehicle) return fail(404, 'NOT_FOUND');
    return { ok: true, status: 200, body: this.toVehicleDetail(vehicle) };
  }

  searchClients(q: string | null): MockResult<ClientSearchResponse> {
    if (q === null) {
      return fail(400, 'VALIDATION_ERROR', { errors: [{ field: 'q', ...REQUIRED }] });
    }
    if (q.length > MAX_SEARCH_LENGTH) {
      return fail(400, 'VALIDATION_ERROR', {
        errors: [{ field: 'q', code: 'VALIDATION_ERROR', message: `Admite como máximo ${MAX_SEARCH_LENGTH} caracteres` }],
      });
    }
    const document = searchDocument(q);
    if (document.length < MIN_SEARCH_LENGTH) {
      return fail(400, 'SEARCH_TERM_TOO_SHORT');
    }
    const name = fold(q).trim().replace(/\s+/g, ' ');

    // Relevance (FR-003): exact document, document prefix, document contains, then name contains.
    const ranked: { rank: number; client: ClientDetail }[] = [];
    for (const client of this.clients.values()) {
      let rank: number | null = null;
      if (client.documentNumber === document) rank = 0;
      else if (client.documentNumber.startsWith(document)) rank = 1;
      else if (client.documentNumber.includes(document)) rank = 2;
      else if (fold(client.displayName).includes(name)) rank = 3;
      if (rank !== null) ranked.push({ rank, client });
    }
    ranked.sort((a, b) => a.rank - b.rank || a.client.displayName.localeCompare(b.client.displayName));
    return {
      ok: true,
      status: 200,
      body: {
        items: ranked.slice(0, SEARCH_LIMIT).map(({ client }) => toSummary(client)),
        hasMore: ranked.length > SEARCH_LIMIT,
      },
    };
  }

  private insert(client: ValidClient): ClientDetail {
    const now = new Date().toISOString();
    const detail: ClientDetail = {
      id: newId(),
      ...client,
      displayName: displayNameOf(client),
      version: 1,
      vehicles: [],
      createdAt: now,
      updatedAt: now,
      updatedBy: MOCK_USER.id,
      updatedByName: MOCK_USER.name,
    };
    this.clients.set(detail.id, detail);
    return detail;
  }

  private insertVehicle(vehicle: ValidVehicle): VehicleRecord {
    const now = new Date().toISOString();
    const record: VehicleRecord = {
      id: newId(),
      ...vehicle,
      version: 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: MOCK_USER.id,
      updatedByName: MOCK_USER.name,
    };
    this.vehicles.set(record.id, record);
    return record;
  }

  private toVehicleDetail(record: VehicleRecord): VehicleDetail {
    const { ownerClientId, ...vehicle } = structuredClone(record);
    const owner = this.clients.get(ownerClientId);
    if (!owner) {
      throw new Error(`Mock vehicle ${record.id} without owner`);
    }
    return { ...vehicle, owner: toSummary(owner) };
  }

  /** Vehicles whose current owner is the client, ordered by plate (as the backend). */
  private vehiclesOf(clientId: string): VehicleSummary[] {
    return [...this.vehicles.values()]
      .filter((vehicle) => vehicle.ownerClientId === clientId)
      .sort((a, b) => a.plate.localeCompare(b.plate) || a.id.localeCompare(b.id))
      .map(({ id, plate, brand, model, year }) => ({ id, plate, brand, model, year }));
  }
}
