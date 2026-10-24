// Shared password and form rules of the auth pages and the user management forms, from specs/002-autenticacion (FR-005).
import type { AbstractControl, ValidationErrors } from '@angular/forms';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Shown when the request fails without a Problem body (network failure, status 0). */
export const NETWORK_ERROR_MESSAGE = 'No se pudo conectar con el servidor. Revise la conexión e inténtelo de nuevo';

/** Length in Unicode characters (code points), never trimmed: "😀" counts as one (FR-005). */
export function unicodeLength(value: string): number {
  return [...value].length;
}

/**
 * Reactive-forms validator for the password length in Unicode characters (FR-005), unlike
 * Validators.minLength/maxLength, which count UTF-16 code units. Uses the same error keys as
 * those validators ("minlength", "maxlength"); an empty value is left to Validators.required.
 */
export function passwordLengthValidator(control: AbstractControl): ValidationErrors | null {
  const value: unknown = control.value;
  if (typeof value !== 'string' || value === '') return null;
  const actualLength = unicodeLength(value);
  if (actualLength < PASSWORD_MIN_LENGTH) {
    return { minlength: { requiredLength: PASSWORD_MIN_LENGTH, actualLength } };
  }
  if (actualLength > PASSWORD_MAX_LENGTH) {
    return { maxlength: { requiredLength: PASSWORD_MAX_LENGTH, actualLength } };
  }
  return null;
}
