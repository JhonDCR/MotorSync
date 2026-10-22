import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import type { BodyType } from '../../core/api/api.models';
import { isBodyType, isValidPlate, normalizePlateForWrite } from '../identifiers/plate';
import { isValidVin, normalizeVin } from '../identifiers/vin';

// Error keys are the contract errors[].code values, so fieldErrorMessage() can translate them.
// An empty value (null, '' or only whitespace) is not a format error: Validators.required handles it.

export const MIN_VEHICLE_YEAR = 1950;
export const MAX_MILEAGE = 9_999_999;
const INTEGER_TEXT = /^-?\d+$/;

/** Returns the string value, or null when the control is empty. */
function filledText(control: AbstractControl): string | null {
  const value: unknown = control.value;
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

/**
 * Parses a number or numeric string control value. Returns undefined when empty, NaN when it is not an
 * integer, otherwise the integer.
 */
export function parseInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isInteger(value) ? value : Number.NaN;
  if (typeof value !== 'string') return Number.NaN;
  const text = value.trim();
  if (text === '') return undefined;
  return INTEGER_TEXT.test(text) ? Number(text) : Number.NaN;
}

/** Highest accepted model year: current UTC year + 1, computed when called. */
export function maxVehicleYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

export function plateValidator(bodyTypeControlName = 'bodyType'): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = filledText(control);
    if (value === null) return null;
    const sibling: unknown = control.parent?.get(bodyTypeControlName)?.value;
    const bodyType: BodyType = isBodyType(sibling) ? sibling : 'sedan';
    const normalized = normalizePlateForWrite(value);
    return normalized !== null && isValidPlate(normalized, bodyType) ? null : { INVALID_PLATE: true };
  };
}

export const vinValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value = filledText(control);
  if (value === null) return null;
  const normalized = normalizeVin(value);
  return normalized !== null && isValidVin(normalized) ? null : { INVALID_VIN: true };
};

export const yearValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const year = parseInteger(control.value);
  if (year === undefined) return null;
  return year >= MIN_VEHICLE_YEAR && year <= maxVehicleYear() ? null : { INVALID_YEAR: true };
};

export const mileageValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const mileage = parseInteger(control.value);
  if (mileage === undefined) return null;
  return mileage >= 0 && mileage <= MAX_MILEAGE ? null : { INVALID_MILEAGE: true };
};
