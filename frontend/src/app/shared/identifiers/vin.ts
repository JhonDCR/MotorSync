// VIN normalization and validation (FR-013, data-model.md "Reglas de validación").
// Same rules as backend/src/common/identifiers/vin.ts.
import { normalizeIdentifierForWrite } from './plate';

const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

/** Same normalization as the plate: uppercase, no spaces or hyphens; null on other characters. */
export function normalizeVin(raw: string): string | null {
  return normalizeIdentifierForWrite(raw);
}

/** Validates an already normalized VIN: 17 characters, without I, O or Q. */
export function isValidVin(vin: string): boolean {
  return VIN_PATTERN.test(vin);
}
