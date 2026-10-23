import type { CurrentSession } from '../../core/auth/current-session';

// Reason policy for identifier changes and ownership transfers (FR-019), as backend/src/common/reason-policy.ts.

export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 500;
export const REASON_REQUIRED_MESSAGE = 'El motivo es obligatorio (entre 10 y 500 caracteres)';

/** Trimmed reason, or null when it is empty or only spaces (it counts as omitted). */
export function normalizeReason(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** The asesor (and an absent session) must give a reason; the admin may omit it. */
export function isReasonRequired(session: CurrentSession | null): boolean {
  return session?.role !== 'admin';
}

/** Omitted reasons are accepted only when not required; a given one has 10 to 500 code points after trim. */
export function isReasonAcceptable(reason: string | null | undefined, required: boolean): boolean {
  const normalized = normalizeReason(reason);
  if (normalized === null) {
    return !required;
  }
  const length = [...normalized].length;
  return length >= REASON_MIN_LENGTH && length <= REASON_MAX_LENGTH;
}
