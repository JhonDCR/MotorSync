import type { BodyType, FieldError, FieldErrorCode, Problem, ProblemCode } from './api.models';

// Traduce `code` y `errors[].code` del contrato a los mensajes en español de spec.md.

export interface ProblemContext {
  bodyType?: BodyType;
  resource?: 'vehicle' | 'client';
}

const CAR_PLATE_MESSAGE = 'Placa inválida: para autos use 3 letras y 3 o 4 dígitos (ej. PBA1234)';
const MOTORCYCLE_PLATE_MESSAGE = 'Placa inválida: para motos use 2 letras, 3 dígitos y 1 letra (ej. AB123C)';
const GENERIC_PLATE_MESSAGE =
  'Placa inválida: autos 3 letras y 3 o 4 dígitos (ej. PBA1234); motos 2 letras, 3 dígitos y 1 letra (ej. AB123C)';

const FIELD_MESSAGES: Record<Exclude<FieldErrorCode, 'INVALID_PLATE'>, string> = {
  INVALID_VIN: 'VIN inválido',
  INVALID_CEDULA: 'Cédula inválida',
  INVALID_RUC: 'RUC inválido',
  INVALID_PASSPORT: 'Pasaporte inválido: use de 5 a 20 letras o dígitos',
  INVALID_DOCUMENT_TYPE: 'Tipo de documento no válido para este tipo de cliente',
  INVALID_PHONE: 'Teléfono inválido: debe tener entre 7 y 15 dígitos',
  INVALID_EMAIL: 'Correo electrónico inválido',
  INVALID_YEAR: 'Año inválido',
  INVALID_MILEAGE: 'Kilometraje inválido',
  REASON_REQUIRED: 'El motivo es obligatorio (entre 10 y 500 caracteres)',
  REQUIRED: 'Este campo es obligatorio',
  UNKNOWN_FIELD: 'Campo no permitido',
  // Contrato 002 (FR-005, US5-AC4, US5-AC5). Nunca se repite el `message` del servidor.
  PASSWORD_TOO_SHORT: 'La contraseña debe tener al menos 8 caracteres',
  PASSWORD_TOO_LONG: 'La contraseña admite como máximo 128 caracteres',
  SAME_PASSWORD: 'La nueva contraseña debe ser distinta de la actual',
  CURRENT_PASSWORD_INCORRECT: 'La contraseña actual no es correcta',
};

const PROBLEM_MESSAGES: Record<ProblemCode, string> = {
  UNAUTHORIZED: 'Su sesión no es válida o expiró. Vuelva a iniciar sesión',
  VALIDATION_ERROR: 'Revise los datos del formulario',
  SEARCH_TERM_TOO_SHORT: 'Escriba al menos 2 caracteres',
  NOT_FOUND: 'Registro no encontrado',
  CLIENT_NOT_FOUND: 'Cliente no encontrado',
  PLATE_ALREADY_EXISTS: 'La placa ya está registrada',
  VIN_ALREADY_EXISTS: 'El VIN ya está registrado',
  DOCUMENT_ALREADY_EXISTS: 'El documento ya está registrado',
  VERSION_CONFLICT: 'Otra persona modificó este registro. Revise los datos actuales y vuelva a intentarlo',
  SAME_OWNER: 'El vehículo ya pertenece a este cliente',
  INTERNAL_ERROR: 'Ocurrió un error inesperado en el servidor. Inténtelo de nuevo en unos minutos',
  // Contrato 002: los mensajes entre comillas de spec.md van literales.
  TOKEN_EXPIRED: 'Su acceso venció. Vuelva a iniciar sesión',
  SESSION_EXPIRED: 'Su sesión expiró por inactividad',
  SESSION_REVOKED: 'Su sesión fue cerrada. Vuelva a iniciar sesión',
  REFRESH_CONFLICT: 'La sesión se estaba renovando en otra pestaña. Vuelva a intentarlo',
  INVALID_CREDENTIALS: 'Correo o contraseña incorrectos',
  ACCOUNT_LOCKED: 'Demasiados intentos fallidos. Intente de nuevo en unos minutos',
  TEMPORARY_PASSWORD_EXPIRED:
    'Su contraseña temporal venció. Pida al administrador de su taller que la restablezca o use ¿Olvidaste tu contraseña?',
  PASSWORD_CHANGE_REQUIRED: 'Debe cambiar su contraseña antes de continuar',
  CURRENT_PASSWORD_INCORRECT: 'La contraseña actual no es correcta',
  RUC_ALREADY_REGISTERED: 'Este RUC ya tiene un taller registrado en MotorSync',
  REGISTRATION_FAILED: 'No se pudo completar el registro con estos datos; si ya tiene una cuenta, inicie sesión',
  EMAIL_UNAVAILABLE:
    'No se pudo crear la cuenta con este correo. Si la persona ya tiene una cuenta en su taller, búsquela en la lista; si no, use otro correo',
  LAST_ADMIN: 'El taller debe tener al menos un administrador activo',
  SELF_RESET_NOT_ALLOWED: 'Para su propia cuenta use Cambiar mi contraseña',
  FORBIDDEN: 'No tiene permisos para gestionar usuarios',
  // Contrato 003
  HELP_RATE_LIMITED: 'Demasiadas solicitudes. Intente de nuevo más tarde',
  TICKET_NOT_OPEN: 'Solo se puede generar una contraseña temporal sobre un ticket abierto',
  ACCOUNT_INACTIVE: 'La cuenta está desactivada; el administrador de su taller debe reactivarla',
  // Contrato 004
  MILEAGE_BELOW_LAST: 'El kilometraje no puede ser menor que el del último check-in',
  INVALID_BUDGET_STATUS: 'El presupuesto no admite esta acción en su estado actual',
  INVALID_WORK_ORDER_STATUS: 'La orden de trabajo no admite esta acción en su estado actual',
  budget_not_approved: 'El presupuesto no está aprobado',
  work_order_exists: 'Este presupuesto ya tiene una orden de trabajo',
};

const NOT_FOUND_BY_RESOURCE: Record<NonNullable<ProblemContext['resource']>, string> = {
  vehicle: 'No se encontró ningún vehículo',
  client: 'Cliente no encontrado',
};

function hasOwn<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function plateMessage(bodyType: BodyType | undefined): string {
  if (bodyType === undefined) {
    return GENERIC_PLATE_MESSAGE;
  }
  return bodyType === 'motorcycle' ? MOTORCYCLE_PLATE_MESSAGE : CAR_PLATE_MESSAGE;
}

export function fieldErrorMessage(error: FieldError, context: ProblemContext = {}): string {
  if (error.code === 'INVALID_PLATE') {
    return plateMessage(context.bodyType);
  }
  if (hasOwn(FIELD_MESSAGES, error.code)) {
    return FIELD_MESSAGES[error.code];
  }
  return error.message;
}

export function fieldErrorMessages(problem: Problem, context: ProblemContext = {}): Record<string, string> {
  const messages: Record<string, string> = {};
  for (const error of problem.errors ?? []) {
    if (!(error.field in messages)) {
      messages[error.field] = fieldErrorMessage(error, context);
    }
  }
  return messages;
}

export function problemMessage(problem: Problem, context: ProblemContext = {}): string {
  if (problem.code === 'NOT_FOUND' && context.resource !== undefined) {
    return NOT_FOUND_BY_RESOURCE[context.resource];
  }
  if (hasOwn(PROBLEM_MESSAGES, problem.code)) {
    return PROBLEM_MESSAGES[problem.code];
  }
  return problem.detail ?? problem.title;
}

export function isProblem(body: unknown): body is Problem {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const candidate = body as Record<string, unknown>;
  return (
    typeof candidate['code'] === 'string' &&
    typeof candidate['status'] === 'number' &&
    typeof candidate['title'] === 'string' &&
    typeof candidate['type'] === 'string'
  );
}
