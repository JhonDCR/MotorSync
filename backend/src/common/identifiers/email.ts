// Email normalization, validation and hash (FR-003, research R4).
import { createHash } from 'node:crypto';

export const EMAIL_MAX_LENGTH = 254;

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const TOP_LEVEL_DOMAIN = /^[A-Za-z]{2,63}$/;
const LOCAL_PART_MAX_LENGTH = 64;

/** Trims surrounding whitespace and lowercases. Dots and `+tags` are kept (FR-003). */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Pragmatic address check: local@domain.tld, at most 254 characters, no whitespace. */
export function isValidEmail(value: string): boolean {
  if (value.length === 0 || value.length > EMAIL_MAX_LENGTH) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > LOCAL_PART_MAX_LENGTH || !LOCAL_PART.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  return TOP_LEVEL_DOMAIN.test(labels[labels.length - 1]);
}

/** SHA-256 hex of an (already normalized) email: key of login_attempts (research R4). */
export function emailHash(email: string): string {
  return createHash('sha256').update(email).digest('hex');
}
