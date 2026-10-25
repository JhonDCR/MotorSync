import { QueryFailedError } from 'typeorm';

/** Field error of the contract (`FieldError` schema). */
export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface TranslatedPgError {
  status: number;
  code: string;
  errors?: FieldError[];
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NO_DATA_FOUND = 'P0002';
const INVALID_AUTHORIZATION_SPECIFICATION = '28000';
// PL/pgSQL reports the raising function in `where`; the panel functions are the `support_*` ones.
const SUPPORT_FUNCTION_MARKER = 'support_';

// pg reports the name of the unique index (or of the constraint) in `constraint`.
const TRANSLATIONS: Record<string, Record<string, TranslatedPgError>> = {
  [UNIQUE_VIOLATION]: {
    clients_tenant_document_key: {
      status: 409,
      code: 'DOCUMENT_ALREADY_EXISTS',
    },
    vehicles_tenant_plate_key: { status: 409, code: 'PLATE_ALREADY_EXISTS' },
    vehicles_tenant_vin_key: { status: 409, code: 'VIN_ALREADY_EXISTS' },
    tenants_ruc_key: { status: 409, code: 'RUC_ALREADY_REGISTERED' },
    // Generic on purpose: never reveals which workshop owns the email (FR-023).
    users_email_key: { status: 409, code: 'EMAIL_UNAVAILABLE' },
  },
  [CHECK_VIOLATION]: {
    // Deferred trigger of the last active administrator (research R8).
    users_last_admin: { status: 409, code: 'LAST_ADMIN' },
    vehicles_plate_format: {
      status: 400,
      code: 'VALIDATION_ERROR',
      errors: [
        { field: 'plate', code: 'INVALID_PLATE', message: 'Placa inválida' },
      ],
    },
  },
};

/** Reads `code`, `constraint` and `where` from a raw pg error or a TypeORM QueryFailedError. */
function readPgFields(
  error: unknown,
): { code: string; constraint?: string; where?: string } | null {
  const source: unknown =
    error instanceof QueryFailedError ? error.driverError : error;
  if (typeof source !== 'object' || source === null) return null;
  const { code, constraint, where } = source as {
    code?: unknown;
    constraint?: unknown;
    where?: unknown;
  };
  if (typeof code !== 'string') return null;
  return {
    code,
    ...(typeof constraint === 'string' ? { constraint } : {}),
    ...(typeof where === 'string' ? { where } : {}),
  };
}

/**
 * Translates the PostgreSQL constraint errors the contract knows about (research R5).
 * Never adds existingId: the service looks it up under RLS after the conflict.
 */
export function translatePgError(error: unknown): TranslatedPgError | null {
  const fields = readPgFields(error);
  if (!fields) return null;
  // `no_data_found` raised by support_list_workshop_accounts (data-model 003).
  if (fields.code === NO_DATA_FOUND) return { status: 404, code: 'NOT_FOUND' };
  // Only the session gate of the support panel raises 28000 for the app; anything else is unknown.
  if (fields.code === INVALID_AUTHORIZATION_SPECIFICATION) {
    return fields.where?.includes(SUPPORT_FUNCTION_MARKER)
      ? { status: 401, code: 'SESSION_REVOKED' }
      : null;
  }
  if (!fields.constraint) return null;
  const translated = TRANSLATIONS[fields.code]?.[fields.constraint];
  if (!translated) return null;
  return {
    status: translated.status,
    code: translated.code,
    ...(translated.errors
      ? { errors: translated.errors.map((e) => ({ ...e })) }
      : {}),
  };
}
