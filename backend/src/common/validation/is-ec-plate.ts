import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { isBodyType, isValidPlate } from '../identifiers/plate.js';

/** Exact messages of spec.md US3-AC12 (cars) and US3-AC13 (motorcycles). */
export const CAR_PLATE_MESSAGE =
  'Placa inválida: para autos use 3 letras y 3 o 4 dígitos (ej. PBA1234)';
export const MOTORCYCLE_PLATE_MESSAGE =
  'Placa inválida: para motos use 2 letras, 3 dígitos y 1 letra (ej. AB123C)';

function bodyTypeOf(args: ValidationArguments, bodyTypeProperty: string): unknown {
  return (args.object as Record<string, unknown>)[bodyTypeProperty];
}

/**
 * Validates an already normalized plate (normalizePlateForWrite) against the body type found
 * in `bodyTypeProperty` of the same DTO. Emits INVALID_PLATE through `context.code`, with the
 * message of the expected format for that body type (FR-007). A plate that still carries a
 * character other than letters and digits fails the format as well (US3-AC14).
 * An unknown or missing body type is left to that property's own validators.
 */
export function IsEcPlate(
  bodyTypeProperty: string,
  options: ValidationOptions = {},
): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isEcPlate',
      target: target.constructor,
      propertyName: String(propertyName),
      constraints: [bodyTypeProperty],
      options: {
        message: (args: ValidationArguments): string =>
          bodyTypeOf(args, bodyTypeProperty) === 'motorcycle'
            ? MOTORCYCLE_PLATE_MESSAGE
            : CAR_PLATE_MESSAGE,
        context: { code: 'INVALID_PLATE' },
        ...options,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') return false;
          const bodyType = bodyTypeOf(args, bodyTypeProperty);
          if (!isBodyType(bodyType)) return true;
          return isValidPlate(value, bodyType);
        },
      },
    });
  };
}
