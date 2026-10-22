// Ecuadorian document validators (research R7, decision P1). Pure functions over input already
// normalized with normalizeDocument(). Same rules as backend/src/common/identifiers/ec-document.ts.

const CEDULA_PATTERN = /^\d{10}$/;
const RUC_PATTERN = /^\d{13}$/;
const PASSPORT_PATTERN = /^[A-Z0-9]{5,20}$/;
const CEDULA_COEFFICIENTS = [2, 1, 2, 1, 2, 1, 2, 1, 2] as const;
const RUC_SUFFIX = '001';
const PUBLIC_ENTITY_DIGIT = 6;
const PRIVATE_COMPANY_DIGIT = 9;
const MAX_NATURAL_PERSON_DIGIT = 5;

/** Province code 01–24, or 30 (Ecuadorians abroad). */
function isValidProvince(digits: string): boolean {
  const province = Number(digits.slice(0, 2));
  return (province >= 1 && province <= 24) || province === 30;
}

/** Modulo 10 check digit of a cedula (coefficients 2,1,2,1,2,1,2,1,2; products > 9 minus 9). */
function hasValidCedulaCheckDigit(cedula: string): boolean {
  let sum = 0;
  CEDULA_COEFFICIENTS.forEach((coefficient, index) => {
    const product = Number(cedula[index]) * coefficient;
    sum += product > 9 ? product - 9 : product;
  });
  const expected = (10 - (sum % 10)) % 10;
  return expected === Number(cedula[9]);
}

export function isValidCedula(value: string): boolean {
  if (!CEDULA_PATTERN.test(value) || !isValidProvince(value)) return false;
  if (Number(value[2]) > MAX_NATURAL_PERSON_DIGIT) return false;
  return hasValidCedulaCheckDigit(value);
}

/**
 * RUC: 13 digits ending in 001. Natural person (third digit 0–5): the first 10 digits are a valid
 * cedula. Private company (9) or public entity (6): structure only, without modulo 11 (decision P1).
 */
export function isValidRuc(value: string): boolean {
  if (!RUC_PATTERN.test(value) || !value.endsWith(RUC_SUFFIX)) return false;
  if (!isValidProvince(value)) return false;
  const thirdDigit = Number(value[2]);
  if (thirdDigit <= MAX_NATURAL_PERSON_DIGIT) return isValidCedula(value.slice(0, 10));
  return thirdDigit === PRIVATE_COMPANY_DIGIT || thirdDigit === PUBLIC_ENTITY_DIGIT;
}

export function isValidPassport(value: string): boolean {
  return PASSPORT_PATTERN.test(value);
}
