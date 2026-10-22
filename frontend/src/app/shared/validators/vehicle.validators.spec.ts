// T045: ValidatorFn de Angular para el formulario de vehículos, construidos sobre shared/identifiers/plate.ts
// y vin.ts (mismos vectores que T038). Contrato para el implementer (T046), archivo
// shared/validators/vehicle.validators.ts:
//   - plateValidator(bodyTypeControlName = 'bodyType'): ValidatorFn → se pone en el control de la placa y lee la
//     carrocería del control hermano (control.parent?.get(bodyTypeControlName)). Normaliza con
//     normalizePlateForWrite: si devuelve null (caracteres no permitidos) o la placa normalizada no cumple el
//     formato de la carrocería (isValidPlate), el error es { INVALID_PLATE: true }. Sin padre o sin una
//     carrocería válida se valida con el formato de auto. El validador NO se revalida solo al cambiar la
//     carrocería: eso lo hace el formulario (plate.updateValueAndValidity() al cambiar bodyType).
//   - vinValidator: ValidatorFn → VIN opcional; si se informa, normalizeVin + isValidVin. Error: { INVALID_VIN: true }.
//   - yearValidator: ValidatorFn → entero entre 1950 y el año UTC en curso + 1 (lo calcula al validar, con
//     new Date()). Error: { INVALID_YEAR: true }.
//   - mileageValidator: ValidatorFn → entero entre 0 y 9 999 999. Error: { INVALID_MILEAGE: true }.
// year y mileage aceptan number (input type="number") o string numérica (input de texto); cualquier otra cosa
// no numérica es un error de formato.
// Las claves de error son los códigos errors[].code del contrato, para traducirlas con fieldErrorMessage().
// Un valor vacío (null, '' o solo espacios) devuelve null: de lo obligatorio se encarga el formulario.
import { FormControl, FormGroup } from '@angular/forms';
import type { BodyType } from '../../core/api/api.models';
import { mileageValidator, plateValidator, vinValidator, yearValidator } from './vehicle.validators';

const CAR_BODY_TYPES: BodyType[] = ['sedan', 'suv', 'pickup', 'other'];

function run(validator: (control: FormControl) => unknown, value: unknown): unknown {
  return validator(new FormControl(value));
}

/**
 * Formulario mínimo: plate con plateValidator() y su hermano bodyType. Al construir un FormGroup, Angular valida
 * cada control ANTES de asignarle el padre, así que se revalida la placa una vez creada (igual que hace el
 * formulario real al cambiar bodyType).
 */
function plateForm(plate: string | null, bodyType: BodyType | '' | null) {
  const group = new FormGroup({
    bodyType: new FormControl<BodyType | '' | null>(bodyType),
    plate: new FormControl<string | null>(plate, plateValidator()),
  });
  group.controls.plate.updateValueAndValidity();
  return group;
}

describe('plateValidator (T045)', () => {
  describe('autos (US3-AC12)', () => {
    describe.each(CAR_BODY_TYPES)('bodyType %s', (bodyType) => {
      it.each(['PBA123', 'PBA1234', 'GYE0123'])('[US3-AC12] acepta %s', (plate) => {
        expect(plateForm(plate, bodyType).controls.plate.errors).toBeNull();
      });

      it.each(['PB1234', 'PBA12', 'PBA12345', '1234PBA', 'AB123C'])(
        '[US3-AC12] rechaza "%s" con INVALID_PLATE',
        (plate) => {
          expect(plateForm(plate, bodyType).controls.plate.errors).toEqual({ INVALID_PLATE: true });
        },
      );
    });
  });

  describe('motos (US3-AC13)', () => {
    it('[US3-AC13] acepta AB123C', () => {
      expect(plateForm('AB123C', 'motorcycle').controls.plate.errors).toBeNull();
    });

    it.each(['PBA1234', 'AB1234', 'PBA123', 'A123BC', 'AB12C', 'AB1234C'])(
      '[US3-AC13] rechaza "%s" con INVALID_PLATE',
      (plate) => {
        expect(plateForm(plate, 'motorcycle').controls.plate.errors).toEqual({ INVALID_PLATE: true });
      },
    );
  });

  describe('normalización antes de validar (US3-AC2)', () => {
    it.each([
      ['pba-1234', 'sedan'],
      [' pba 1234 ', 'suv'],
      ['Pba 12-34', 'pickup'],
      ['gye0123', 'other'],
      ['ab-123-c', 'motorcycle'],
    ] as const)('[US3-AC2] acepta "%s" (%s): normaliza mayúsculas, espacios y guiones', (plate, bodyType) => {
      expect(plateForm(plate, bodyType).controls.plate.errors).toBeNull();
    });
  });

  describe('caracteres no permitidos (US3-AC14)', () => {
    it.each(['PBA*1234', 'PBA.1234', 'PBA_1234', 'PBA/1234', '#PBA1234'])(
      '[US3-AC14] "%s" se rechaza con INVALID_PLATE en lugar de limpiarse en silencio',
      (plate) => {
        expect(plateForm(plate, 'sedan').controls.plate.errors).toEqual({ INVALID_PLATE: true });
      },
    );

    it('[US3-AC14] una placa de moto con un símbolo tampoco es válida como moto', () => {
      expect(plateForm('AB*123C', 'motorcycle').controls.plate.errors).toEqual({ INVALID_PLATE: true });
    });
  });

  describe('depende de la carrocería (US3-AC14)', () => {
    it('[US3-AC14] AB123C es válida como moto e inválida al cambiar a sedán y revalidar', () => {
      const form = plateForm('AB123C', 'motorcycle');
      expect(form.controls.plate.errors).toBeNull();

      form.controls.bodyType.setValue('sedan');
      form.controls.plate.updateValueAndValidity();

      expect(form.controls.plate.errors).toEqual({ INVALID_PLATE: true });
    });

    it('[US3-AC14] PBA1234 es válida como sedán e inválida al cambiar a moto y revalidar', () => {
      const form = plateForm('PBA1234', 'sedan');
      expect(form.controls.plate.errors).toBeNull();

      form.controls.bodyType.setValue('motorcycle');
      form.controls.plate.updateValueAndValidity();

      expect(form.controls.plate.errors).toEqual({ INVALID_PLATE: true });
    });

    it('[US3-AC14] AB123C inválida como SUV pasa a válida al cambiar a moto y revalidar', () => {
      const form = plateForm('AB123C', 'suv');
      expect(form.controls.plate.errors).toEqual({ INVALID_PLATE: true });

      form.controls.bodyType.setValue('motorcycle');
      form.controls.plate.updateValueAndValidity();

      expect(form.controls.plate.errors).toBeNull();
    });

    it('[US3-AC12] sin carrocería elegida se valida con el formato de auto', () => {
      expect(plateForm('PBA1234', '').controls.plate.errors).toBeNull();
      expect(plateForm('AB123C', null).controls.plate.errors).toEqual({ INVALID_PLATE: true });
    });

    it('[US3-AC12] un control sin padre se valida con el formato de auto', () => {
      expect(run(plateValidator(), 'PBA1234')).toBeNull();
      expect(run(plateValidator(), 'AB123C')).toEqual({ INVALID_PLATE: true });
    });

    it('[US3-AC14] acepta otro nombre para el control de la carrocería', () => {
      const form = new FormGroup({
        kind: new FormControl<BodyType>('motorcycle'),
        plate: new FormControl('AB123C', plateValidator('kind')),
      });
      form.controls.plate.updateValueAndValidity();
      expect(form.controls.plate.errors).toBeNull();
    });
  });

  it.each([null, '', '   '])('[US3-AC12] una placa vacía (%j) no es un error de formato (lo marca required)', (plate) => {
    expect(plateForm(plate, 'sedan').controls.plate.errors).toBeNull();
    expect(plateForm(plate, 'motorcycle').controls.plate.errors).toBeNull();
  });
});

describe('vinValidator (T045, US3-AC4, US3-AC6)', () => {
  it.each(['1HGCM82633A004352', 'WVWZZZ1JZXW000001', 'JH4KA7561PC008269', '12345678901234567'])(
    '[US3-AC4] acepta %s',
    (vin) => {
      expect(run(vinValidator, vin)).toBeNull();
    },
  );

  it.each(['1hgcm82633a004352', ' 1HGCM 82633 A004352 ', '1HGCM-82633-A004352'])(
    '[US3-AC4] acepta "%s": normaliza mayúsculas, espacios y guiones antes de validar',
    (vin) => {
      expect(run(vinValidator, vin)).toBeNull();
    },
  );

  it.each([
    ['1HGCM82633A00435', '16 caracteres'],
    ['1HGCM82633A0043521', '18 caracteres'],
    ['1HGCM82633I004352', 'contiene I'],
    ['1HGCM82633O004352', 'contiene O'],
    ['1HGCM82633Q004352', 'contiene Q'],
    ['1HGCM82633A00435*', 'carácter no alfanumérico'],
    ['1HGCM*82633A004352', 'símbolo que no se limpia en silencio'],
    ['1HGCM.82633A004352', 'punto'],
    ['1HGCM_82633A004352', 'guion bajo'],
  ])('[US3-AC4] rechaza "%s" (%s) con INVALID_VIN', (vin) => {
    expect(run(vinValidator, vin)).toEqual({ INVALID_VIN: true });
  });

  it.each([null, '', '   '])('[US3-AC6] el VIN es opcional: %j es válido', (vin) => {
    expect(run(vinValidator, vin)).toBeNull();
  });
});

describe('yearValidator (T045, US3-AC7)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 2026-12-31 23:30 en Ecuador (UTC-5) ya es 2027 en UTC: el tope es 2027 + 1 = 2028.
    vi.setSystemTime(new Date('2027-01-01T04:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([1950, 2000, 2026, 2027, 2028, '2015', ' 2020 '])('[US3-AC7] acepta el año %j', (year) => {
    expect(run(yearValidator, year)).toBeNull();
  });

  it.each<[number | string, string]>([
    [1949, 'anterior a 1950'],
    [2029, 'posterior al año UTC en curso + 1'],
    [2020.5, 'no entero'],
    ['2020.5', 'no entero (texto)'],
    ['dos mil', 'no numérico'],
    [-2020, 'negativo'],
  ])('[US3-AC7] rechaza %j (%s) con INVALID_YEAR', (year) => {
    expect(run(yearValidator, year)).toEqual({ INVALID_YEAR: true });
  });

  it('[US3-AC7] el tope se calcula con el año UTC del momento de validar', () => {
    vi.setSystemTime(new Date('2026-10-21T15:00:00.000Z'));
    expect(run(yearValidator, 2027)).toBeNull();
    expect(run(yearValidator, 2028)).toEqual({ INVALID_YEAR: true });
  });

  it.each([null, '', '   '])('[US3-AC7] un año vacío (%j) no es un error de formato (lo marca required)', (year) => {
    expect(run(yearValidator, year)).toBeNull();
  });
});

describe('mileageValidator (T045, US3-AC7)', () => {
  it.each([0, 1, 85000, 9999999, '120000'])('[US3-AC7] acepta el kilometraje %j', (mileage) => {
    expect(run(mileageValidator, mileage)).toBeNull();
  });

  it.each<[number | string, string]>([
    [-1, 'negativo'],
    [10000000, 'mayor que 9 999 999'],
    [1500.5, 'no entero'],
    ['1500.5', 'no entero (texto)'],
    ['-5', 'negativo (texto)'],
    ['mucho', 'no numérico'],
  ])('[US3-AC7] rechaza %j (%s) con INVALID_MILEAGE', (mileage) => {
    expect(run(mileageValidator, mileage)).toEqual({ INVALID_MILEAGE: true });
  });

  it.each([null, ''])('[US3-AC7] un kilometraje vacío (%j) no es un error de formato (lo marca required)', (mileage) => {
    expect(run(mileageValidator, mileage)).toBeNull();
  });
});
