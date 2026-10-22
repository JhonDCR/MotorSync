// T023: validadores de documentos ecuatorianos del frontend (research R7, decisión P1).
// Mismos vectores que backend/src/common/identifiers/ec-document.spec.ts y normalize.spec.ts (T015).
// Funciones puras sobre la entrada ya normalizada con normalizeDocument().
// En el RUC de sociedades privadas (9) y entidades públicas (6) NO se aplica módulo 11 (P1).
import { isValidCedula, isValidPassport, isValidRuc } from './ec-document';
import { normalizeDocument } from './normalize';

// Dígito verificador con módulo 10 (coeficientes 2,1,2,1,2,1,2,1,2; productos > 9 menos 9).
const VALID_CEDULAS = [
  '1710034065', // Pichincha (17), tercer dígito 1
  '0100000009', // provincia más baja (01), tercer dígito 0
  '2400000002', // provincia regular más alta (24)
  '3000000004', // provincia 30 (ecuatorianos en el exterior)
  '1750000000', // tercer dígito 5 (límite superior), verificador 0
  '0912345675', // Guayas (09)
];

const INVALID_CEDULAS: [string, string][] = [
  ['1710034064', 'wrong check digit (-1)'],
  ['1710034066', 'wrong check digit (+1)'],
  ['0000000000', 'province 00'],
  ['2500000001', 'province 25 (correct check digit)'],
  ['2900000007', 'province 29 (correct check digit)'],
  ['3100000003', 'province 31 (correct check digit)'],
  ['1760000008', 'third digit 6 (correct check digit)'],
  ['1790000002', 'third digit 9 (correct check digit)'],
  ['171003406', '9 digits'],
  ['17100340650', '11 digits'],
  ['17100340A5', 'contains a letter'],
  ['171003406-5', 'not normalized (hyphen)'],
  ['', 'empty'],
];

const VALID_RUCS: [string, string][] = [
  ['1710034065001', 'natural person: valid cedula + 001'],
  ['0912345675001', 'natural person (Guayas)'],
  ['1790011674001', 'private company (third digit 9)'],
  ['1790000000001', 'private company that FAILS modulo 11: structure only (P1)'],
  ['3090000000001', 'private company, province 30'],
  ['1760000000001', 'public entity (third digit 6), structure only (P1)'],
  ['0160000000001', 'public entity, province 01'],
];

const INVALID_RUCS: [string, string][] = [
  ['1710034065002', 'natural person not ending in 001'],
  ['1710034065000', 'natural person ending in 000'],
  ['1710034064001', 'natural person whose first 10 digits are an invalid cedula'],
  ['1790011674002', 'private company not ending in 001'],
  ['1760000000000', 'public entity not ending in 001'],
  ['1770000000001', 'third digit 7'],
  ['1780000000001', 'third digit 8'],
  ['2590000000001', 'private company, province 25'],
  ['0090000000001', 'private company, province 00'],
  ['3160000000001', 'public entity, province 31'],
  ['179001167400', '12 digits'],
  ['17900116740011', '14 digits'],
  ['17900116740A1', 'contains a letter'],
  ['1710034065', 'a cedula is not a RUC'],
  ['', 'empty'],
];

const VALID_PASSPORTS = ['AB123456', 'A1234', '12345', 'X'.repeat(20), 'P0012345678', 'ZZ999'];

const INVALID_PASSPORTS: [string, string][] = [
  ['A123', '4 characters'],
  ['A'.repeat(21), '21 characters'],
  ['ab123456', 'lowercase (not normalized)'],
  ['AB-123456', 'hyphen (not normalized)'],
  ['AB 123456', 'space (not normalized)'],
  ['AB.123456', 'other symbol'],
  ['ÑA12345', 'non ASCII letter'],
  ['', 'empty'],
];

describe('isValidCedula (T023, US2-AC4)', () => {
  it.each(VALID_CEDULAS)('[US2-AC4] acepta la cédula válida %s', (cedula) => {
    expect(isValidCedula(cedula)).toBe(true);
  });

  it.each(INVALID_CEDULAS)('[US2-AC4] rechaza %s (%s)', (cedula) => {
    expect(isValidCedula(cedula)).toBe(false);
  });
});

describe('isValidRuc (T023, US2-AC5, decisión P1)', () => {
  it.each(VALID_RUCS)('[US2-AC5] acepta %s (%s)', (ruc) => {
    expect(isValidRuc(ruc)).toBe(true);
  });

  it.each(INVALID_RUCS)('[US2-AC5] rechaza %s (%s)', (ruc) => {
    expect(isValidRuc(ruc)).toBe(false);
  });
});

describe('isValidPassport (T023, US2-AC3)', () => {
  it.each(VALID_PASSPORTS)('[US2-AC3] acepta el pasaporte %s', (passport) => {
    expect(isValidPassport(passport)).toBe(true);
  });

  it.each(INVALID_PASSPORTS)('[US2-AC3] rechaza %s (%s)', (passport) => {
    expect(isValidPassport(passport)).toBe(false);
  });
});

// Normalización del documento (research R7): mayúsculas, sin espacios ni guiones. Cualquier otro
// carácter no alfanumérico se conserva para que la validación lo rechace (FR-002).
describe('normalizeDocument (T023, US2-AC6)', () => {
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
