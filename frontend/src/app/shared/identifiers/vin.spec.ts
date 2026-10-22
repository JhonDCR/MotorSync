// T045: VIN normalization and validation (FR-013, data-model.md "Reglas de validación").
// Normalization is the same as the plate for writes: uppercase, spaces and hyphens removed, any other
// non-alphanumeric character is an error (null). Rule: ^[A-HJ-NPR-Z0-9]{17}$ (no I, O or Q).
// Mismos vectores que backend/src/common/identifiers/vin.spec.ts (T038).
// Contrato para el implementer (T046), archivo shared/identifiers/vin.ts:
//   normalizeVin(raw: string): string | null
//   isValidVin(vin: string): boolean
import { isValidVin, normalizeVin } from './vin';

const VALID_VIN = '1HGCM82633A004352';

describe('normalizeVin (T045, US3-AC4)', () => {
  it.each([
    ['1hgcm82633a004352', VALID_VIN],
    [' 1HGCM 82633 A004352 ', VALID_VIN],
    ['1HGCM-82633-A004352', VALID_VIN],
    [VALID_VIN, VALID_VIN],
  ])(
    '[US3-AC4] normaliza "%s" a "%s" (mayúsculas, sin espacios ni guiones)',
    (raw, expected) => {
      expect(normalizeVin(raw)).toBe(expected);
    },
  );

  it.each([
    ['1HGCM*82633A004352'],
    ['1HGCM.82633A004352'],
    ['1HGCM_82633A004352'],
  ])(
    '[US3-AC4] "%s" tiene caracteres no permitidos: devuelve null (no se limpia en silencio)',
    (raw) => {
      expect(normalizeVin(raw)).toBeNull();
    },
  );
});

describe('isValidVin (T045, US3-AC4, FR-013)', () => {
  it.each([
    [VALID_VIN],
    ['WVWZZZ1JZXW000001'],
    ['JH4KA7561PC008269'],
    ['12345678901234567'],
  ])('[US3-AC4] acepta %s', (vin) => {
    expect(isValidVin(vin)).toBe(true);
  });

  it.each([
    ['1HGCM82633A00435', '16 caracteres'],
    ['1HGCM82633A0043521', '18 caracteres'],
    ['', 'vacío'],
    ['1HGCM82633I004352', 'contiene I'],
    ['1HGCM82633O004352', 'contiene O'],
    ['1HGCM82633Q004352', 'contiene Q'],
    ['1hgcm82633a004352', 'minúsculas sin normalizar'],
    ['1HGCM82633A00435*', 'carácter no alfanumérico'],
  ])('[US3-AC4] rechaza "%s" (%s)', (vin) => {
    expect(isValidVin(vin)).toBe(false);
  });
});
