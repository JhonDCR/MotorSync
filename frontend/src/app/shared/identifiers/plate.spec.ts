// T045: plate normalization and validation (FR-007, research R7, data-model.md "Reglas de validación").
// Write (create/edit): uppercase, spaces and hyphens removed; any other non-alphanumeric character
// is an error (null), never silently cleaned. Search: every non-alphanumeric character is dropped.
// Format depends on bodyType: motorcycle ^[A-Z]{2}[0-9]{3}[A-Z]$, the rest ^[A-Z]{3}[0-9]{3,4}$.
// Mismos vectores que backend/src/common/identifiers/plate.spec.ts (T038).
// Contrato para el implementer (T046), archivo shared/identifiers/plate.ts:
//   normalizePlateForWrite(raw: string): string | null
//   normalizePlateForSearch(raw: string): string
//   isValidPlate(plate: string, bodyType: BodyType): boolean   (BodyType de core/api/api.models)
import {
  isValidPlate,
  normalizePlateForSearch,
  normalizePlateForWrite,
} from './plate';

const CAR_BODY_TYPES = ['sedan', 'suv', 'pickup', 'other'] as const;

describe('normalizePlateForWrite (T045, US3-AC2, US3-AC14)', () => {
  it.each([
    ['pba-1234', 'PBA1234'],
    [' pba 1234 ', 'PBA1234'],
    ['PBA1234', 'PBA1234'],
    ['Pba 12-34', 'PBA1234'],
    ['ab-123-c', 'AB123C'],
    ['gye0123', 'GYE0123'],
  ])('[US3-AC2] normaliza "%s" a "%s"', (raw, expected) => {
    expect(normalizePlateForWrite(raw)).toBe(expected);
  });

  it.each([
    ['PBA*1234'],
    ['PBA.1234'],
    ['PBA_1234'],
    ['PBA/1234'],
    ['#PBA1234'],
  ])(
    '[US3-AC14] "%s" tiene caracteres no permitidos: devuelve null (no se limpia en silencio)',
    (raw) => {
      expect(normalizePlateForWrite(raw)).toBeNull();
    },
  );
});

describe('normalizePlateForSearch (T045, research R7)', () => {
  it.each([
    ['pba-1234', 'PBA1234'],
    [' pba 1234 ', 'PBA1234'],
    ['PBA*1234', 'PBA1234'],
    ['pb.a/12_34#', 'PBA1234'],
    ['ba1', 'BA1'],
    ['  -*- ', ''],
  ])(
    '[US3-AC2] en búsqueda normaliza "%s" a "%s" descartando lo no alfanumérico',
    (raw, expected) => {
      expect(normalizePlateForSearch(raw)).toBe(expected);
    },
  );
});

describe('isValidPlate para autos (T045, US3-AC12, FR-007)', () => {
  describe.each(CAR_BODY_TYPES)('bodyType %s', (bodyType) => {
    it.each([['PBA123'], ['PBA1234'], ['GYE0123']])(
      '[US3-AC12] acepta %s',
      (plate) => {
        expect(isValidPlate(plate, bodyType)).toBe(true);
      },
    );

    it.each([
      ['PB1234'],
      ['PBA12'],
      ['PBA12345'],
      ['1234PBA'],
      ['AB123C'],
      [''],
    ])('[US3-AC12] rechaza "%s"', (plate) => {
      expect(isValidPlate(plate, bodyType)).toBe(false);
    });
  });
});

describe('isValidPlate para motos (T045, US3-AC13, FR-007)', () => {
  it('[US3-AC13] acepta AB123C', () => {
    expect(isValidPlate('AB123C', 'motorcycle')).toBe(true);
  });

  it.each([
    ['PBA1234'],
    ['AB1234'],
    ['PBA123'],
    ['A123BC'],
    ['AB12C'],
    ['AB1234C'],
    [''],
  ])('[US3-AC13] rechaza "%s"', (plate) => {
    expect(isValidPlate(plate, 'motorcycle')).toBe(false);
  });
});

describe('isValidPlate depende de la carrocería (T045, US3-AC14)', () => {
  it('[US3-AC14] AB123C es válida como moto e inválida al cambiar a sedán', () => {
    expect(isValidPlate('AB123C', 'motorcycle')).toBe(true);
    expect(isValidPlate('AB123C', 'sedan')).toBe(false);
  });

  it('[US3-AC14] PBA1234 es válida como sedán e inválida al cambiar a moto', () => {
    expect(isValidPlate('PBA1234', 'sedan')).toBe(true);
    expect(isValidPlate('PBA1234', 'motorcycle')).toBe(false);
  });

  it('[US3-AC14] una placa con caracteres no permitidos no llega a ser válida para ninguna carrocería', () => {
    const normalized = normalizePlateForWrite('PBA*1234');
    expect(normalized).toBeNull();
  });
});
