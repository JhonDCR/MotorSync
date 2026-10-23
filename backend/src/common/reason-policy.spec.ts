// T066: reason policy (FR-019, US4-AC11, US4-AC15, US4-AC16). Pure unit tests, no Nest, no DB.
//
// Assumed API of ./reason-policy.ts (T067):
//
//   export type IdentifierField = 'owner' | 'plate' | 'vin' | 'document';
//
//   // Stored values of the entity (only the ones that apply to it: a client has document*,
//   // a vehicle has plate, vin and ownerClientId).
//   export interface IdentifierSnapshot {
//     ownerClientId?: string;
//     plate?: string;
//     vin?: string | null;
//     documentType?: string;
//     documentNumber?: string;
//   }
//
//   // Which identifiers the request really changes. `requested` is the raw request body (PATCH
//   // or transfer): absent keys are not changes; any other key (phone, color, ...) is ignored.
//   // plate and vin are compared after normalizeIdentifierForWrite, documentNumber after
//   // normalizeDocument, ownerClientId case-insensitively; vin: null clears a stored VIN.
//   // A document change is a change of documentType or of documentNumber.
//   export function changedIdentifiers(
//     current: IdentifierSnapshot,
//     requested: Readonly<Record<string, unknown>>,
//   ): IdentifierField[];
//
//   // null if the operation may go on; otherwise the contract FieldError for `reason`.
//   // asesor + some change: reason required, 10 to 500 characters after trim.
//   // admin + some change: reason optional (null/undefined), but if given, same 10 to 500 rule.
//   // no change: never required.
//   export function checkReason(
//     role: AuthRole,
//     changed: readonly IdentifierField[],
//     reason: string | null | undefined,
//   ): FieldError | null;
//
//   // An empty or whitespace-only reason counts as OMITTED (leader decision): allowed for admin,
//   // REASON_REQUIRED for asesor.
//   // Value to store in audit_log.reason: trimmed, or null when not given, empty or only spaces.
//   export function normalizeReason(reason: string | null | undefined): string | null;
//
//   export const REASON_REQUIRED_MESSAGE = 'El motivo es obligatorio (entre 10 y 500 caracteres)';
import {
  changedIdentifiers,
  checkReason,
  normalizeReason,
  REASON_REQUIRED_MESSAGE,
  type IdentifierField,
} from './reason-policy.js';

const REASON_ERROR = {
  field: 'reason',
  code: 'REASON_REQUIRED',
  message: 'El motivo es obligatorio (entre 10 y 500 caracteres)',
};

const VALID_REASON = 'Error de digitación en el registro';
const IDENTIFIER_CHANGES: IdentifierField[][] = [['owner'], ['plate'], ['vin'], ['document']];

const STORED_VEHICLE = {
  ownerClientId: '6f1c2a4e-9b1d-4c52-8f0e-2b7a1d3c4e5f',
  plate: 'PBA1234',
  vin: '1HGCM82633A004352',
};
const STORED_CLIENT = { documentType: 'passport', documentNumber: 'AB123456' };

function sorted(fields: IdentifierField[]): IdentifierField[] {
  return [...fields].sort((a, b) => a.localeCompare(b));
}

describe('checkReason: asesor (T066, FR-019, US4-AC15)', () => {
  it('[US4-AC15] el mensaje del contrato es "El motivo es obligatorio (entre 10 y 500 caracteres)"', () => {
    expect(REASON_REQUIRED_MESSAGE).toBe(REASON_ERROR.message);
  });

  it.each(IDENTIFIER_CHANGES)(
    '[US4-AC15][FR-019] sin motivo, cambiar %s → REASON_REQUIRED',
    (field) => {
      expect(checkReason('asesor', [field], undefined)).toEqual(REASON_ERROR);
      expect(checkReason('asesor', [field], null)).toEqual(REASON_ERROR);
      expect(checkReason('asesor', [field], '')).toEqual(REASON_ERROR);
    },
  );

  it('[US4-AC15] un motivo de solo espacios cuenta como vacío → REASON_REQUIRED', () => {
    expect(checkReason('asesor', ['plate'], '     \t   ')).toEqual(REASON_ERROR);
  });

  it('[US4-AC15][FR-019] 9 caracteres tras trim → REASON_REQUIRED, aunque con espacios llegue a 13', () => {
    expect(checkReason('asesor', ['owner'], 'a'.repeat(9))).toEqual(REASON_ERROR);
    expect(checkReason('asesor', ['owner'], `  ${'a'.repeat(9)}  `)).toEqual(REASON_ERROR);
  });

  it('[US4-AC15][FR-019] 501 caracteres → REASON_REQUIRED', () => {
    expect(checkReason('asesor', ['vin'], 'a'.repeat(501))).toEqual(REASON_ERROR);
  });

  it.each(IDENTIFIER_CHANGES)(
    '[US4-AC15][FR-019] con un motivo válido, cambiar %s se permite (null)',
    (field) => {
      expect(checkReason('asesor', [field], VALID_REASON)).toBeNull();
    },
  );

  it('[FR-019] los límites 10 y 500 tras trim se aceptan, y los espacios de los extremos no cuentan', () => {
    expect(checkReason('asesor', ['plate'], 'a'.repeat(10))).toBeNull();
    expect(checkReason('asesor', ['plate'], 'a'.repeat(500))).toBeNull();
    expect(checkReason('asesor', ['plate'], `   ${'a'.repeat(500)}   `)).toBeNull();
  });

  it('[US4-AC11][FR-019] varios identificadores a la vez (placa y VIN) piden un solo motivo válido', () => {
    expect(checkReason('asesor', ['plate', 'vin'], undefined)).toEqual(REASON_ERROR);
    expect(checkReason('asesor', ['plate', 'vin'], VALID_REASON)).toBeNull();
  });
});

describe('checkReason: admin (T066, FR-019, US4-AC16)', () => {
  it.each(IDENTIFIER_CHANGES)(
    '[US4-AC16][FR-019] sin motivo, cambiar %s se permite (null)',
    (field) => {
      expect(checkReason('admin', [field], undefined)).toBeNull();
      expect(checkReason('admin', [field], null)).toBeNull();
    },
  );

  it('[US4-AC16][FR-019] un motivo vacío o de solo espacios cuenta como omitido: se permite (null)', () => {
    expect(checkReason('admin', ['owner'], '')).toBeNull();
    expect(checkReason('admin', ['plate'], '   ')).toBeNull();
    expect(checkReason('admin', ['document'], ' \t \n ')).toBeNull();
  });

  it('[US4-AC16] con un motivo de 10 a 500 caracteres se permite', () => {
    expect(checkReason('admin', ['owner'], VALID_REASON)).toBeNull();
    expect(checkReason('admin', ['owner'], 'a'.repeat(10))).toBeNull();
    expect(checkReason('admin', ['owner'], 'a'.repeat(500))).toBeNull();
  });

  it('[US4-AC16][FR-019] si lo informa, 9 caracteres tras trim → el mismo REASON_REQUIRED que el asesor', () => {
    expect(checkReason('admin', ['document'], 'a'.repeat(9))).toEqual(REASON_ERROR);
    expect(checkReason('admin', ['document'], `  ${'a'.repeat(9)}  `)).toEqual(REASON_ERROR);
  });

  it('[US4-AC16][FR-019] si lo informa, 501 caracteres → el mismo REASON_REQUIRED que el asesor', () => {
    expect(checkReason('admin', ['plate'], 'a'.repeat(501))).toEqual(REASON_ERROR);
  });
});

describe('checkReason: sin cambios de identificadores (T066, US4-AC11)', () => {
  it('[US4-AC11] sin identificadores cambiados nunca exige motivo, ni al asesor ni al admin', () => {
    expect(checkReason('asesor', [], undefined)).toBeNull();
    expect(checkReason('asesor', [], null)).toBeNull();
    expect(checkReason('admin', [], undefined)).toBeNull();
  });
});

describe('changedIdentifiers (T066, FR-019, US4-AC11)', () => {
  it('[US4-AC11] editar teléfono, correo, color o kilometraje no cambia ningún identificador', () => {
    expect(
      changedIdentifiers(STORED_CLIENT, { phone: '0987654321', email: 'ana@example.com' }),
    ).toEqual([]);
    expect(
      changedIdentifiers(STORED_VEHICLE, { color: 'Rojo', initialMileage: 50000, brand: 'Kia' }),
    ).toEqual([]);
  });

  it('[US4-AC11] una petición vacía no cambia nada', () => {
    expect(changedIdentifiers(STORED_VEHICLE, {})).toEqual([]);
  });

  it('[US4-AC11] por lo tanto, editar campos no identificadores no pide motivo al asesor', () => {
    const changed = changedIdentifiers(STORED_VEHICLE, { color: 'Rojo' });
    expect(checkReason('asesor', changed, undefined)).toBeNull();
  });

  it('[FR-019] una placa distinta es un cambio de plate', () => {
    expect(changedIdentifiers(STORED_VEHICLE, { plate: 'PBC5678' })).toEqual(['plate']);
  });

  it('[FR-019] la misma placa escrita con minúsculas, espacios o guiones no es un cambio', () => {
    expect(changedIdentifiers(STORED_VEHICLE, { plate: 'pba-1234' })).toEqual([]);
    expect(changedIdentifiers(STORED_VEHICLE, { plate: ' Pba 1234 ' })).toEqual([]);
    expect(changedIdentifiers(STORED_VEHICLE, { plate: 'PBA1234' })).toEqual([]);
  });

  it('[FR-019] un VIN distinto es un cambio; el mismo en minúsculas o con guiones no', () => {
    expect(changedIdentifiers(STORED_VEHICLE, { vin: '2HGCM82633A004352' })).toEqual(['vin']);
    expect(changedIdentifiers(STORED_VEHICLE, { vin: '1hgcm82633a004352' })).toEqual([]);
    expect(changedIdentifiers(STORED_VEHICLE, { vin: '1HGCM-82633-A004352' })).toEqual([]);
  });

  it('[FR-019] quitar el VIN guardado (vin: null) es un cambio; dejar null un VIN que ya era null no', () => {
    expect(changedIdentifiers(STORED_VEHICLE, { vin: null })).toEqual(['vin']);
    expect(changedIdentifiers({ ...STORED_VEHICLE, vin: null }, { vin: null })).toEqual([]);
  });

  it('[FR-019] poner un VIN a un vehículo que no lo tenía es un cambio', () => {
    expect(
      changedIdentifiers({ ...STORED_VEHICLE, vin: null }, { vin: '1HGCM82633A004352' }),
    ).toEqual(['vin']);
  });

  it('[FR-019] un número de documento distinto es un cambio; el mismo normalizado no', () => {
    expect(changedIdentifiers(STORED_CLIENT, { documentNumber: 'AB999999' })).toEqual([
      'document',
    ]);
    expect(changedIdentifiers(STORED_CLIENT, { documentNumber: 'ab-123 456' })).toEqual([]);
    expect(
      changedIdentifiers(STORED_CLIENT, { documentType: 'passport', documentNumber: 'AB123456' }),
    ).toEqual([]);
  });

  it('[FR-019] cambiar el tipo de documento es un cambio de document', () => {
    expect(
      changedIdentifiers(
        { documentType: 'cedula', documentNumber: '1710034065' },
        { documentType: 'passport' },
      ),
    ).toEqual(['document']);
  });

  it('[US4-AC7][FR-019] transferir a otro cliente es un cambio de owner; al mismo (en otra caja) no', () => {
    expect(
      changedIdentifiers(STORED_VEHICLE, {
        ownerClientId: '0d3b9f6a-1c2e-4a7b-9d8c-5e4f3a2b1c0d',
      }),
    ).toEqual(['owner']);
    expect(
      changedIdentifiers(STORED_VEHICLE, {
        ownerClientId: STORED_VEHICLE.ownerClientId.toUpperCase(),
      }),
    ).toEqual([]);
  });

  it('[US4-AC11] placa y VIN a la vez, junto con el color, devuelve solo plate y vin', () => {
    const changed = changedIdentifiers(STORED_VEHICLE, {
      plate: 'PBC5678',
      vin: '2HGCM82633A004352',
      color: 'Rojo',
    });
    expect(sorted(changed)).toEqual(['plate', 'vin']);
  });

  it('[US4-AC15] la placa igual tras normalizar no pide motivo al asesor', () => {
    const changed = changedIdentifiers(STORED_VEHICLE, { plate: 'pba-1234', color: 'Rojo' });
    expect(checkReason('asesor', changed, undefined)).toBeNull();
  });
});

describe('normalizeReason (T066, US4-AC8, US4-AC16)', () => {
  it('[US4-AC8] guarda el motivo sin los espacios de los extremos', () => {
    expect(normalizeReason(`  ${VALID_REASON}  `)).toBe(VALID_REASON);
  });

  it('[US4-AC16] sin motivo (undefined o null) queda null en la auditoría', () => {
    expect(normalizeReason(undefined)).toBeNull();
    expect(normalizeReason(null)).toBeNull();
  });

  it('[US4-AC16] un motivo vacío o de solo espacios cuenta como omitido: null', () => {
    expect(normalizeReason('')).toBeNull();
    expect(normalizeReason('   ')).toBeNull();
    expect(normalizeReason(' \t \n ')).toBeNull();
  });
});
