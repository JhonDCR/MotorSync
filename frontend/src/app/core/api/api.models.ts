// Tipos escritos a mano desde specs/001-clientes-vehiculos/contracts/openapi.yaml (research.md R8),
// specs/002-autenticacion/contracts/openapi.yaml y specs/003-soporte-plataforma/contracts/openapi.yaml.
// Si cambia un contrato, este archivo cambia con él.

export type ClientType = 'natural' | 'company';
export type DocumentType = 'cedula' | 'ruc' | 'passport';
export type BodyType = 'sedan' | 'suv' | 'pickup' | 'motorcycle' | 'other';
export type Role = 'asesor' | 'admin';
export type AuditActorRole = Role | 'platform_support';

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

// --- Autenticación (contrato 002) ---

export type UserStatus = 'active' | 'inactive';

export interface CreateUserRequest {
  name: string;
  email: string;
  role: Role;
  temporaryPassword: string;
}

export interface UserAccount {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedByName: string;
}

export interface UserAuditEntry {
  id: string;
  action: 'user.role_changed' | 'user.deactivated' | 'user.reactivated' | 'user.password_reset';
  actorName: string;
  actorRole: Role;
  occurredAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  channel: string;
}

export interface ResetPasswordRequest {
  temporaryPassword: string;
}

export interface ChangeRoleRequest {
  role: Role;
}

export interface UserListResponse {
  items: UserAccount[];
}

export interface UserHistoryResponse {
  items: UserAuditEntry[];
}

export interface RegisterRequest {
  workshopName: string;
  ruc: string;
  name: string;
  email: string;
  /** Se envía tal cual: sin recorte ni cambio de mayúsculas (FR-005). */
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
}

export interface Workshop {
  id: string;
  name: string;
}

export interface SessionResponse {
  /** JWT de acceso; el frontend lo guarda en localStorage `motorsync.token`. */
  accessToken: string;
  /** Segundos de vida del token de acceso (900). */
  expiresIn: number;
  user: SessionUser;
  workshop: Workshop;
}

/** GET /auth/me (schema CurrentSession del contrato 002): datos vigentes de la sesión. */
export interface CurrentSessionResponse {
  user: SessionUser;
  workshop: Workshop;
}

/** POST /auth/password. Ambas contraseñas se envían tal cual (FR-005); sin userId (US5-AC8). */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

// --- Soporte de la plataforma y recuperación de acceso (contrato 003) ---

export type TicketStatus = 'open' | 'resolved' | 'discarded';

export interface ForgotPasswordRequest {
  email: string;
}

export interface SupportLoginRequest {
  email: string;
  password: string;
}

export interface SupportAgent {
  id: string;
  name: string;
  email: string;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
}

export type SupportAgentProfile = SupportAgent;

export interface SupportSessionResponse {
  /** JWT de soporte; el frontend lo guarda en localStorage `motorsync.support.token`. */
  accessToken: string;
  expiresIn: number;
  agent: SupportAgent;
}

export interface CurrentSupportSession {
  agent: SupportAgent;
}

export type CurrentSupportSessionResponse = CurrentSupportSession;

export interface TicketAccountSummary {
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
}

export type TicketAccount = TicketAccountSummary;

export interface TicketWorkshopSummary {
  name: string;
  ruc: string | null;
}

export type TicketWorkshop = TicketWorkshopSummary;

export interface TicketSummary {
  id: string;
  number: number;
  createdAt: string;
  lastRequestedAt: string;
  requestCount: number;
  account: TicketAccountSummary;
  workshop: TicketWorkshopSummary;
}

export interface TicketResolution {
  verificationNote: string;
  resolvedByName: string;
  resolvedAt: string;
}

export interface TicketDiscard {
  reason: string;
  discardedByName: string;
  discardedAt: string;
}

export interface TicketDetail extends TicketSummary {
  status: TicketStatus;
  resolution?: TicketResolution | null;
  discard?: TicketDiscard | null;
}

export interface TicketListResponse {
  items: TicketSummary[];
}

export interface DiscardTicketRequest {
  reason: string;
}

export interface GenerateTemporaryPasswordRequest {
  verificationNote: string;
}

export interface TemporaryPasswordResponse {
  temporaryPassword: string;
  temporaryPasswordExpiresAt: string;
  sessionsClosed: number;
  ticket: TicketDetail;
}

export interface WorkshopSummary {
  id: string;
  name: string;
  ruc: string | null;
  createdAt: string;
}

export interface WorkshopListResponse {
  items: WorkshopSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface WorkshopAccount {
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  hasOpenTicket: boolean;
}

export interface WorkshopAccountsResponse {
  workshop: WorkshopSummary;
  items: WorkshopAccount[];
}

export interface WorkshopSummaryRef {
  id: string;
  name: string;
  ruc: string | null;
}

export interface AccessLogEntry {
  id: string;
  occurredAt: string;
  agent: {
    id: string;
    name: string;
  };
  workshop: WorkshopSummaryRef;
  ip: string | null;
  channel: string;
}

export interface AccessLogResponse {
  items: AccessLogEntry[];
  page: number;
  pageSize: number;
  total: number;
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
  'INTERNAL_ERROR',
  // Contrato 002
  'TOKEN_EXPIRED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'REFRESH_CONFLICT',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'TEMPORARY_PASSWORD_EXPIRED',
  'PASSWORD_CHANGE_REQUIRED',
  'CURRENT_PASSWORD_INCORRECT',
  'RUC_ALREADY_REGISTERED',
  'REGISTRATION_FAILED',
  'EMAIL_UNAVAILABLE',
  'LAST_ADMIN',
  'SELF_RESET_NOT_ALLOWED',
  'FORBIDDEN',
  // Contrato 003
  'HELP_RATE_LIMITED',
  'TICKET_NOT_OPEN',
  'ACCOUNT_INACTIVE',
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
  | 'UNKNOWN_FIELD'
  // Contrato 002
  | 'PASSWORD_TOO_SHORT'
  | 'PASSWORD_TOO_LONG'
  | 'SAME_PASSWORD'
  | 'CURRENT_PASSWORD_INCORRECT';

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
