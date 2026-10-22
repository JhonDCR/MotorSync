// T023: normalización y validación del teléfono en el frontend (research R7). Se quitan espacios,
// guiones y paréntesis; el resultado debe cumplir ^\+?\d{7,15}$.
// Mismos vectores que backend/src/common/identifiers/phone.spec.ts (T015).
import { isValidPhone, normalizePhone } from './phone';

describe('normalizePhone (T023, US2-AC7)', () => {
  it.each([
    ['0991234567', '0991234567'],
    ['099 123 4567', '0991234567'],
    ['099-123-4567', '0991234567'],
    ['(02) 255-1234', '022551234'],
    ['+593 99 123 4567', '+593991234567'],
    ['+593 (2) 255-1234', '+59322551234'],
    [' 2551234 ', '2551234'],
  ])('[US2-AC7] normaliza "%s" a "%s"', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it('[US2-AC7] no elimina otros símbolos (puntos, letras)', () => {
    expect(normalizePhone('099.123.4567')).toBe('099.123.4567');
  });
});

describe('isValidPhone (T023, US2-AC7)', () => {
  it.each([
    ['2551234', '7 digits (lower bound)'],
    ['0991234567', 'Ecuadorian mobile'],
    ['022551234', 'landline with area code'],
    ['+593991234567', 'international with +'],
    ['123456789012345', '15 digits (upper bound)'],
    ['+123456789012345', '+ and 15 digits'],
  ])('[US2-AC7] acepta %s (%s)', (phone) => {
    expect(isValidPhone(phone)).toBe(true);
  });

  it.each([
    ['123456', '6 digits'],
    ['+123456', '+ and 6 digits'],
    ['1234567890123456', '16 digits'],
    ['+', 'only +'],
    ['++593991234567', 'double +'],
    ['593+991234567', '+ in the middle'],
    ['099123456A', 'contains a letter'],
    ['099.123.4567', 'dots'],
    ['', 'empty'],
  ])('[US2-AC7] rechaza %s (%s)', (phone) => {
    expect(isValidPhone(phone)).toBe(false);
  });

  it.each([
    ['(02) 255-1234', true],
    ['+593 99 123 4567', true],
    ['099-12', false],
    ['(0) 123 456 789 012 345', false],
  ])('[US2-AC7] "%s" tras normalizar → %s', (raw, expected) => {
    expect(isValidPhone(normalizePhone(raw))).toBe(expected);
  });
});
