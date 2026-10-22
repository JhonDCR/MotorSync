// T023: ValidatorFn de Angular para el formulario de clientes, construidos sobre shared/identifiers
// (mismos vectores que T015). Contrato para el implementer (T024):
//   - documentNumberValidator(documentType): ValidatorFn → normaliza (normalizeDocument) y valida según
//     el tipo. Error: { INVALID_CEDULA: true } | { INVALID_RUC: true } | { INVALID_PASSPORT: true }.
//   - phoneValidator: ValidatorFn → normaliza (normalizePhone) y valida. Error: { INVALID_PHONE: true }.
//   - emailValidator: ValidatorFn → correo opcional; si se informa, formato estándar. Error: { INVALID_EMAIL: true }.
// Las claves de error son los códigos de errors[].code del contrato, para traducirlas con fieldErrorMessage().
// Un valor vacío (null, '' o solo espacios) devuelve null: de lo obligatorio se encarga Validators.required.
import { FormControl } from '@angular/forms';
import { documentNumberValidator, emailValidator, phoneValidator } from './client.validators';

function run(validator: (control: FormControl) => unknown, value: unknown): unknown {
  return validator(new FormControl(value));
}

describe('documentNumberValidator (T023)', () => {
  describe('cédula (US2-AC4)', () => {
    it.each(['1710034065', '0100000009', '2400000002', '3000000004', '1750000000', '0912345675'])(
      '[US2-AC4] acepta la cédula válida %s',
      (value) => {
        expect(run(documentNumberValidator('cedula'), value)).toBeNull();
      },
    );

    it.each(['171003406-5', ' 1710 034 065 ', '17-1003-4065'])(
      '[US2-AC4] acepta "%s": normaliza espacios y guiones antes de validar',
      (value) => {
        expect(run(documentNumberValidator('cedula'), value)).toBeNull();
      },
    );

    it.each([
      ['1710034064', 'wrong check digit (-1)'],
      ['1710034066', 'wrong check digit (+1)'],
      ['0000000000', 'province 00'],
      ['2500000001', 'province 25'],
      ['1760000008', 'third digit 6'],
      ['171003406', '9 digits'],
      ['17100340650', '11 digits'],
      ['17100340A5', 'contains a letter'],
      ['171003406/5', 'other symbol'],
    ])('[US2-AC4] rechaza %s (%s) con INVALID_CEDULA', (value) => {
      expect(run(documentNumberValidator('cedula'), value)).toEqual({ INVALID_CEDULA: true });
    });
  });

  describe('RUC (US2-AC5, decisión P1)', () => {
    it.each([
      ['1710034065001', 'natural person'],
      ['0912345675001', 'natural person (Guayas)'],
      ['1790011674001', 'private company'],
      ['1790000000001', 'private company that FAILS modulo 11: structure only (P1)'],
      ['3090000000001', 'private company, province 30'],
      ['1760000000001', 'public entity, structure only (P1)'],
      ['0160000000001', 'public entity, province 01'],
      ['1710034065-001', 'with hyphen, normalized'],
    ])('[US2-AC5] acepta %s (%s)', (value) => {
      expect(run(documentNumberValidator('ruc'), value)).toBeNull();
    });

    it.each([
      ['1710034065002', 'natural person not ending in 001'],
      ['1710034064001', 'invalid cedula in first 10 digits'],
      ['1790011674002', 'private company not ending in 001'],
      ['1770000000001', 'third digit 7'],
      ['2590000000001', 'province 25'],
      ['179001167400', '12 digits'],
      ['17900116740A1', 'contains a letter'],
      ['1710034065', 'a cedula is not a RUC'],
    ])('[US2-AC5] rechaza %s (%s) con INVALID_RUC', (value) => {
      expect(run(documentNumberValidator('ruc'), value)).toEqual({ INVALID_RUC: true });
    });
  });

  describe('pasaporte (US2-AC3)', () => {
    it.each(['AB123456', 'A1234', '12345', 'X'.repeat(20), 'P0012345678', 'ab-123456', 'ab 123 456'])(
      '[US2-AC3] acepta "%s" (alfanumérico de 5 a 20 tras normalizar)',
      (value) => {
        expect(run(documentNumberValidator('passport'), value)).toBeNull();
      },
    );

    it.each([
      ['A123', '4 characters'],
      ['A'.repeat(21), '21 characters'],
      ['AB.123456', 'other symbol'],
      ['ÑA12345', 'non ASCII letter'],
    ])('[US2-AC3] rechaza %s (%s) con INVALID_PASSPORT', (value) => {
      expect(run(documentNumberValidator('passport'), value)).toEqual({ INVALID_PASSPORT: true });
    });
  });

  it.each([null, '', '   '])('[US2-AC8] un valor vacío (%j) no es un error de formato (lo marca required)', (value) => {
    for (const type of ['cedula', 'ruc', 'passport'] as const) {
      expect(run(documentNumberValidator(type), value)).toBeNull();
    }
  });
});

describe('phoneValidator (T023, US2-AC7)', () => {
  it.each(['2551234', '0991234567', '022551234', '+593991234567', '123456789012345', '+123456789012345'])(
    '[US2-AC7] acepta %s',
    (value) => {
      expect(run(phoneValidator, value)).toBeNull();
    },
  );

  it.each(['099 123 4567', '099-123-4567', '(02) 255-1234', '+593 99 123 4567', '+593 (2) 255-1234'])(
    '[US2-AC7] acepta "%s": normaliza espacios, guiones y paréntesis',
    (value) => {
      expect(run(phoneValidator, value)).toBeNull();
    },
  );

  it.each([
    ['123456', '6 digits'],
    ['+123456', '+ and 6 digits'],
    ['1234567890123456', '16 digits'],
    ['+', 'only +'],
    ['++593991234567', 'double +'],
    ['593+991234567', '+ in the middle'],
    ['099123456A', 'contains a letter'],
    ['099.123.4567', 'dots'],
    ['099-12', 'too short after normalizing'],
    ['(0) 123 456 789 012 345', 'too long after normalizing'],
  ])('[US2-AC7] rechaza %s (%s) con INVALID_PHONE', (value) => {
    expect(run(phoneValidator, value)).toEqual({ INVALID_PHONE: true });
  });

  it.each([null, ''])('[US2-AC8] un teléfono vacío (%j) no es un error de formato (lo marca required)', (value) => {
    expect(run(phoneValidator, value)).toBeNull();
  });
});

describe('emailValidator (T023, US2-AC7)', () => {
  it.each([null, '', '   '])('[US2-AC7] el correo es opcional: %j es válido', (value) => {
    expect(run(emailValidator, value)).toBeNull();
  });

  it.each(['ana@example.com', 'ANA.PEREZ@taller.com.ec', 'jose+motorsync@correo.ec', 'n.nunez@sub.dominio.org'])(
    '[US2-AC7] acepta el correo %s',
    (value) => {
      expect(run(emailValidator, value)).toBeNull();
    },
  );

  it.each([
    ['ana', 'without @'],
    ['ana@', 'without domain'],
    ['@example.com', 'without local part'],
    ['ana@@example.com', 'double @'],
    ['ana perez@example.com', 'space in local part'],
    ['ana@example', 'domain without dot'],
  ])('[US2-AC7] rechaza %s (%s) con INVALID_EMAIL', (value) => {
    expect(run(emailValidator, value)).toEqual({ INVALID_EMAIL: true });
  });
});
