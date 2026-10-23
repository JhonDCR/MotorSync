// T008 (specs/002-autenticacion): email normalization, validation and hash (FR-003, research R4).
import { createHash } from 'node:crypto';
import { emailHash, isValidEmail, normalizeEmail } from './email.js';

// 64 + 1 + 189 = 254 characters, with labels of at most 63 characters.
function emailOfLength(total: number): string {
  const local = 'a'.repeat(64);
  const fixed = `${'b'.repeat(63)}.${'c'.repeat(63)}.`;
  const tld = '.ec';
  const last = total - local.length - 1 - fixed.length - tld.length;
  return `${local}@${fixed}${'d'.repeat(last)}${tld}`;
}

describe('normalizeEmail (T008, FR-003)', () => {
  it('[US1-AC2][US2-AC2] recorta los espacios y pasa a minúsculas', () => {
    expect(normalizeEmail(' Ana.Perez@Taller.EC ')).toBe('ana.perez@taller.ec');
  });

  it('[US1-AC2] recorta también tabuladores y saltos de línea al inicio y al final', () => {
    expect(normalizeEmail('\tANA@TALLER.EC\n')).toBe('ana@taller.ec');
  });

  it('[FR-003] no quita puntos ni la parte con +', () => {
    expect(normalizeEmail('Ana.Maria.Perez+OT@Taller.com.EC')).toBe(
      'ana.maria.perez+ot@taller.com.ec',
    );
  });

  it('[FR-003] es idempotente', () => {
    const once = normalizeEmail(' Ana.Perez@Taller.EC ');
    expect(normalizeEmail(once)).toBe(once);
  });
});

describe('isValidEmail (T008, FR-003)', () => {
  it.each([
    'ana@taller.ec',
    'ana.perez@taller.ec',
    'ana.perez+ot@taller.com.ec',
    'luis_2024@mi-taller.ec',
    'a@b.co',
  ])('[FR-003] acepta %s', (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each([
    '',
    'ana',
    'ana@',
    '@taller.ec',
    'ana@taller',
    'ana perez@taller.ec',
    'ana@@taller.ec',
    'ana@taller .ec',
    'ana@-taller.ec',
    'ana@taller.ec.',
  ])('[FR-003] rechaza %j', (email) => {
    expect(isValidEmail(email)).toBe(false);
  });

  it('[FR-003] acepta hasta 254 caracteres y rechaza 255', () => {
    const max = emailOfLength(254);
    const tooLong = emailOfLength(255);
    expect(max).toHaveLength(254);
    expect(tooLong).toHaveLength(255);
    expect(isValidEmail(max)).toBe(true);
    expect(isValidEmail(tooLong)).toBe(false);
  });
});

describe('emailHash (T008, research R4)', () => {
  it('[R4] es el SHA-256 hex del correo', () => {
    const expected = createHash('sha256').update('ana@taller.ec').digest('hex');
    expect(emailHash('ana@taller.ec')).toBe(expected);
    expect(emailHash('ana@taller.ec')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[R4] correos distintos dan hashes distintos', () => {
    expect(emailHash('ana@taller.ec')).not.toBe(emailHash('luis@taller.ec'));
  });
});
