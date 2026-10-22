import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import type { DocumentType } from '../../core/api/api.models';
import { isValidCedula, isValidPassport, isValidRuc } from '../identifiers/ec-document';
import { isValidEmail, normalizeEmail } from '../identifiers/email';
import { normalizeDocument } from '../identifiers/normalize';
import { isValidPhone, normalizePhone } from '../identifiers/phone';

// Error keys are the contract errors[].code values, so fieldErrorMessage() can translate them.
// An empty value (null, '' or only whitespace) is not a format error: Validators.required handles it.

const DOCUMENT_RULES: Record<DocumentType, { code: string; isValid: (value: string) => boolean }> = {
  cedula: { code: 'INVALID_CEDULA', isValid: isValidCedula },
  ruc: { code: 'INVALID_RUC', isValid: isValidRuc },
  passport: { code: 'INVALID_PASSPORT', isValid: isValidPassport },
};

/** Returns the trimmed string value, or null when the control is empty. */
function filledValue(control: AbstractControl): string | null {
  const value: unknown = control.value;
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

export function documentNumberValidator(documentType: DocumentType): ValidatorFn {
  const rule = DOCUMENT_RULES[documentType];
  return (control: AbstractControl): ValidationErrors | null => {
    const value = filledValue(control);
    if (value === null) return null;
    return rule.isValid(normalizeDocument(value)) ? null : { [rule.code]: true };
  };
}

export const phoneValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value = filledValue(control);
  if (value === null) return null;
  return isValidPhone(normalizePhone(value)) ? null : { INVALID_PHONE: true };
};

export const emailValidator: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value = filledValue(control);
  if (value === null) return null;
  return isValidEmail(normalizeEmail(value)) ? null : { INVALID_EMAIL: true };
};
