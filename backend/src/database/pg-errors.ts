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

// pg reports the name of the unique index (or of the constraint) in `constraint`.
const TRANSLATIONS: Record<string, Record<string, TranslatedPgError>> = {
  [UNIQUE_VIOLATION]: {
    clients_tenant_document_key: { status: 409, code: 'DOCUMENT_ALREADY_EXISTS' },
    vehicles_tenant_plate_key: { status: 409, code: 'PLATE_ALREADY_EXISTS' },
    vehicles_tenant_vin_key: { status: 409, code: 'VIN_ALREADY_EXISTS' },
  },
  [CHECK_VIOLATION]: {
    vehicles_plate_format: {
      status: 400,
      code: 'VALIDATION_ERROR',
      errors: [{ field: 'plate', code: 'INVALID_PLATE', message: 'Placa inválida' }],
    },
  },
};

/** Reads `code` and `constraint` from a raw pg error or from a TypeORM QueryFailedError. */
function readPgFields(error: unknown): { code: string; constraint: string } | null {
  const source: unknown = error instanceof QueryFailedError ? error.driverError : error;
  if (typeof source !== 'object' || source === null) return null;
  const { code, constraint } = source as { code?: unknown; constraint?: unknown };
  if (typeof code !== 'string' || typeof constraint !== 'string') return null;
  return { code, constraint };
}

/**
 * Translates the PostgreSQL constraint errors the contract knows about (research R5).
 * Never adds existingId: the service looks it up under RLS after the conflict.
 */
export function translatePgError(error: unknown): TranslatedPgError | null {
  const fields = readPgFields(error);
  if (!fields) return null;
  const translated = TRANSLATIONS[fields.code]?.[fields.constraint];
  if (!translated) return null;
  return {
    status: translated.status,
    code: translated.code,
    ...(translated.errors ? { errors: translated.errors.map((e) => ({ ...e })) } : {}),
  };
}
