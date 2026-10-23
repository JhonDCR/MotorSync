// Reason policy for identifier changes (FR-019, US4-AC11, US4-AC15, US4-AC16, principle IV).
import type { AuthRole } from '../auth/auth-user.js';
import type { FieldError } from '../database/pg-errors.js';
import { normalizeDocument } from './identifiers/normalize.js';
import { normalizeIdentifierForWrite } from './identifiers/plate.js';

export type IdentifierField = 'owner' | 'plate' | 'vin' | 'document';

/** Stored identifier values of the entity (only the ones that apply to it). */
export interface IdentifierSnapshot {
  ownerClientId?: string;
  plate?: string;
  vin?: string | null;
  documentType?: string;
  documentNumber?: string;
}

export const REASON_REQUIRED_MESSAGE = 'El motivo es obligatorio (entre 10 y 500 caracteres)';

const REASON_MIN_LENGTH = 10;
const REASON_MAX_LENGTH = 500;

/** Normalized write value of plate or VIN; non-strings never match a stored value. */
function writeValue(value: unknown): string | null | undefined {
  return typeof value === 'string' ? normalizeIdentifierForWrite(value) : undefined;
}

function differs(stored: string | null, requested: unknown, normalize: (raw: string) => unknown): boolean {
  if (requested === null) return stored !== null;
  if (typeof requested !== 'string') return true;
  return stored === null || normalize(requested) !== stored;
}

/**
 * Identifiers the request really changes. Absent keys are not changes, and only the identifiers
 * of the snapshot (the ones that apply to the entity) are compared; any other key is ignored.
 */
export function changedIdentifiers(
  current: IdentifierSnapshot,
  requested: Readonly<Record<string, unknown>>,
): IdentifierField[] {
  const changed: IdentifierField[] = [];
  const has = (key: string): boolean => requested[key] !== undefined;

  if (current.ownerClientId !== undefined && has('ownerClientId')) {
    const owner = requested.ownerClientId;
    if (typeof owner !== 'string' || owner.toLowerCase() !== current.ownerClientId.toLowerCase()) {
      changed.push('owner');
    }
  }
  if (current.plate !== undefined && has('plate')) {
    if (differs(current.plate, requested.plate, writeValue)) changed.push('plate');
  }
  if (current.vin !== undefined && has('vin')) {
    if (differs(current.vin, requested.vin, writeValue)) changed.push('vin');
  }
  const typeChanged =
    current.documentType !== undefined &&
    has('documentType') &&
    requested.documentType !== current.documentType;
  const numberChanged =
    current.documentNumber !== undefined &&
    has('documentNumber') &&
    differs(current.documentNumber, requested.documentNumber, normalizeDocument);
  if (typeChanged || numberChanged) changed.push('document');

  return changed;
}

/** Value to store in audit_log.reason: trimmed, or null when omitted, empty or only spaces. */
export function normalizeReason(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * null if the operation may go on; otherwise the contract FieldError for `reason`.
 * An omitted (or blank) reason is allowed for admin and required for asesor; a given reason must
 * have 10 to 500 characters after trim for both roles.
 */
export function checkReason(
  role: AuthRole,
  changed: readonly IdentifierField[],
  reason: string | null | undefined,
): FieldError | null {
  if (changed.length === 0) return null;
  const normalized = normalizeReason(reason);
  if (normalized === null) return role === 'admin' ? null : reasonRequired();
  const length = codePointLength(normalized);
  return length >= REASON_MIN_LENGTH && length <= REASON_MAX_LENGTH ? null : reasonRequired();
}

/** Code points, not UTF-16 units: what PostgreSQL's length() counts in the audit_log CHECK. */
function codePointLength(value: string): number {
  let length = 0;
  for (const _char of value) length++;
  return length;
}

function reasonRequired(): FieldError {
  return { field: 'reason', code: 'REASON_REQUIRED', message: REASON_REQUIRED_MESSAGE };
}
