// Tipos escritos a mano desde specs/001-clientes-vehiculos/contracts/openapi.yaml (research.md R8).
// Si cambia el contrato, este archivo cambia con él.

export type ClientType = 'natural' | 'company';
export type DocumentType = 'cedula' | 'ruc' | 'passport';
export type BodyType = 'sedan' | 'suv' | 'pickup' | 'motorcycle' | 'other';
export type Role = 'asesor' | 'admin';

/** Motivo de 10 a 500 caracteres (FR-019). */
export type Reason = string;

export interface AuditStamp {
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  updatedByName: string;
}

// --- Clientes ---

export interface ClientCreate {
  clientType: ClientType;
  documentType: DocumentType;
  documentNumber: string;
  firstNames?: string;
  lastNames?: string;
  businessName?: string;
  phone: string;
  email?: string | null;
}

export interface ClientUpdate {
  version: number;
  documentType?: DocumentType;
  documentNumber?: string;
  firstNames?: string;
  lastNames?: string;
  businessName?: string;
  phone?: string;
  email?: string | null;
  reason?: Reason;
}

export interface ClientSummary {
  id: string;
  clientType: ClientType;
  documentType: DocumentType;
  documentNumber: string;
  displayName: string;
  phone: string;
  email: string | null;
}

export interface ClientDetail extends ClientSummary, AuditStamp {
  firstNames?: string | null;
  lastNames?: string | null;
  businessName?: string | null;
  version: number;
  vehicles: VehicleSummary[];
}

export interface ClientSearchResponse {
  items: ClientSummary[];
  hasMore: boolean;
}

// --- Vehículos ---

export interface VehicleCreate {
  ownerClientId: string;
  plate: string;
  vin?: string | null;
  brand: string;
  model: string;
  year: number;
  color: string;
  bodyType: BodyType;
  initialMileage: number;
}

export interface VehicleUpdate {
  version: number;
  plate?: string;
  vin?: string | null;
  brand?: string;
  model?: string;
  year?: number;
  color?: string;
  bodyType?: BodyType;
  initialMileage?: number;
  reason?: Reason;
}

export interface VehicleSummary {
  id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
}

export interface VehicleDetail extends VehicleSummary, AuditStamp {
  vin: string | null;
  color: string;
  bodyType: BodyType;
  initialMileage: number;
  version: number;
  owner: ClientSummary;
}

export interface VehicleSearchItem extends VehicleSummary {
  vin: string | null;
  color: string;
  bodyType: BodyType;
  initialMileage: number;
  owner: ClientSummary;
}

export interface VehicleSearchResponse {
  items: VehicleSearchItem[];
  hasMore: boolean;
}

// --- Transferencia e historial de propietarios ---

export interface OwnershipTransferRequest {
  newOwnerClientId: string;
  version: number;
  reason?: Reason;
}

export interface OwnerSnapshot {
  clientId: string;
  displayName: string;
  documentNumber: string;
}

export interface OwnershipChange {
  id: string;
  occurredAt: string;
  previousOwner: OwnerSnapshot;
  newOwner: OwnerSnapshot;
  actorUserId: string;
  actorName: string;
  actorRole: Role;
  reason: string | null;
}

export interface OwnershipHistoryResponse {
  items: OwnershipChange[];
}

// --- Errores (application/problem+json, RFC 9457) ---

export const PROBLEM_CODES = [
  'UNAUTHORIZED',
  'VALIDATION_ERROR',
  'SEARCH_TERM_TOO_SHORT',
  'NOT_FOUND',
  'CLIENT_NOT_FOUND',
  'PLATE_ALREADY_EXISTS',
  'VIN_ALREADY_EXISTS',
  'DOCUMENT_ALREADY_EXISTS',
  'VERSION_CONFLICT',
  'SAME_OWNER',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** Códigos de `errors[].code` documentados en el contrato (respuesta ValidationError). */
export type FieldErrorCode =
  | 'INVALID_PLATE'
  | 'INVALID_VIN'
  | 'INVALID_CEDULA'
  | 'INVALID_RUC'
  | 'INVALID_PASSPORT'
  | 'INVALID_DOCUMENT_TYPE'
  | 'INVALID_PHONE'
  | 'INVALID_EMAIL'
  | 'INVALID_YEAR'
  | 'INVALID_MILEAGE'
  | 'REASON_REQUIRED'
  | 'REQUIRED'
  | 'UNKNOWN_FIELD';

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
  errors?: FieldError[];
  existingId?: string;
  current?: ClientDetail | VehicleDetail;
}
