// T015: Ecuadorian document validators (research R7, decision P1). Pure functions over
// already normalized input (see normalize.spec.ts). The frontend (T023) uses THE SAME vectors.
import { isValidCedula, isValidPassport, isValidRuc } from './ec-document.js';

// Check digit computed with modulo 10 (coefficients 2,1,2,1,2,1,2,1,2; products > 9 minus 9).
const VALID_CEDULAS = [
  '1710034065', // Pichincha (17), third digit 1
  '0100000009', // lowest province (01), third digit 0
  '2400000002', // highest regular province (24)
  '3000000004', // province 30 (Ecuadorians abroad)
  '1750000000', // third digit 5 (upper bound), check digit 0
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

describe('isValidCedula (T015, US2-AC4)', () => {
  it.each(VALID_CEDULAS)('[US2-AC4] acepta la cédula válida %s', (cedula) => {
    expect(isValidCedula(cedula)).toBe(true);
  });

  it.each(INVALID_CEDULAS)('[US2-AC4] rechaza %s (%s)', (cedula) => {
    expect(isValidCedula(cedula)).toBe(false);
  });
});

describe('isValidRuc (T015, US2-AC5, decisión P1)', () => {
  it.each(VALID_RUCS)('[US2-AC5] acepta %s (%s)', (ruc) => {
    expect(isValidRuc(ruc)).toBe(true);
  });

  it.each(INVALID_RUCS)('[US2-AC5] rechaza %s (%s)', (ruc) => {
    expect(isValidRuc(ruc)).toBe(false);
  });
});

describe('isValidPassport (T015, US2-AC3)', () => {
  it.each(VALID_PASSPORTS)('[US2-AC3] acepta el pasaporte %s', (passport) => {
    expect(isValidPassport(passport)).toBe(true);
  });

  it.each(INVALID_PASSPORTS)('[US2-AC3] rechaza %s (%s)', (passport) => {
    expect(isValidPassport(passport)).toBe(false);
  });
});
