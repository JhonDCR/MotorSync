// Phone normalization and validation (research R7).

const PHONE_PATTERN = /^\+?\d{7,15}$/;

/** Removes whitespace, hyphens and parentheses. Any other character is kept. */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s\-()]+/g, '');
}

export function isValidPhone(value: string): boolean {
  return PHONE_PATTERN.test(value);
}
