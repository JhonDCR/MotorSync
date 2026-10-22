// T015: document normalization (research R7): uppercase, without spaces or hyphens. Any other
// non-alphanumeric character is kept, so that validation rejects it on create/edit (FR-002).
import { isValidCedula, isValidPassport } from './ec-document.js';
import { normalizeDocument } from './normalize.js';

describe('normalizeDocument (T015, US2-AC6)', () => {
  it.each([
    ['1710034065', '1710034065'],
    ['171003406-5', '1710034065'],
    [' 1710 034 065 ', '1710034065'],
    ['17-1003-4065', '1710034065'],
    ['1710034065-001', '1710034065001'],
    ['ab-123 456', 'AB123456'],
    ['p0012345', 'P0012345'],
    ['\t1710034065\n', '1710034065'],
  ])('[US2-AC6] normaliza "%s" a "%s"', (raw, expected) => {
    expect(normalizeDocument(raw)).toBe(expected);
  });

  it('[US2-AC6] es idempotente', () => {
    const once = normalizeDocument(' 171-003 4065 ');
    expect(normalizeDocument(once)).toBe(once);
  });

  it('[US2-AC4] una cédula con espacios y guiones es válida tras normalizar', () => {
    expect(isValidCedula(normalizeDocument('171003406-5'))).toBe(true);
    expect(isValidCedula(normalizeDocument('17 1003 4065'))).toBe(true);
  });

  it('[US2-AC3] no elimina otros símbolos: el documento sigue siendo inválido', () => {
    expect(normalizeDocument('AB.12345')).toContain('.');
    expect(isValidPassport(normalizeDocument('AB.12345'))).toBe(false);
    expect(isValidCedula(normalizeDocument('171003406/5'))).toBe(false);
  });
});
