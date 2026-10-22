// Ecuadorian plate normalization and validation (FR-007, research R7, data-model.md).

export const BODY_TYPES = [
  'sedan',
  'suv',
  'pickup',
  'motorcycle',
  'other',
] as const;
export type BodyType = (typeof BODY_TYPES)[number];

const WRITE_SEPARATORS = /[\s-]+/g;
const ALPHANUMERIC = /^[A-Z0-9]*$/;
const NON_ALPHANUMERIC = /[^A-Z0-9]+/g;
const MOTORCYCLE_PLATE = /^[A-Z]{2}[0-9]{3}[A-Z]$/;
const CAR_PLATE = /^[A-Z]{3}[0-9]{3,4}$/;

/**
 * Normalizes an identifier for create and edit: uppercase, without whitespace or hyphens.
 * Returns null if any other non-alphanumeric character remains (never cleaned silently).
 */
export function normalizeIdentifierForWrite(raw: string): string | null {
  const normalized = raw.replace(WRITE_SEPARATORS, '').toUpperCase();
  return ALPHANUMERIC.test(normalized) ? normalized : null;
}

/** Normalizes a plate for create and edit (see normalizeIdentifierForWrite). */
export function normalizePlateForWrite(raw: string): string | null {
  return normalizeIdentifierForWrite(raw);
}

/** Normalizes a search term: uppercase, every non-alphanumeric character dropped. */
export function normalizePlateForSearch(raw: string): string {
  return raw.toUpperCase().replace(NON_ALPHANUMERIC, '');
}

/** Validates an already normalized plate against the format of its body type. */
export function isValidPlate(plate: string, bodyType: BodyType): boolean {
  return (bodyType === 'motorcycle' ? MOTORCYCLE_PLATE : CAR_PLATE).test(plate);
}

export function isBodyType(value: unknown): value is BodyType {
  return (
    typeof value === 'string' &&
    (BODY_TYPES as readonly string[]).includes(value)
  );
}
