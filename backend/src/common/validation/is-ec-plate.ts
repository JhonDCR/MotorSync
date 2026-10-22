import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { isBodyType, isValidPlate } from '../identifiers/plate.js';

/**
 * Validates an already normalized plate (normalizePlateForWrite) against the body type found
 * in `bodyTypeProperty` of the same DTO. Emits INVALID_PLATE through `context.code`.
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
        message:
          'Placa inválida: auto ABC123 o ABC1234; moto AB123C, según la carrocería',
        context: { code: 'INVALID_PLATE' },
        ...options,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') return false;
          const bodyType = (args.object as Record<string, unknown>)[
            bodyTypeProperty
          ];
          if (!isBodyType(bodyType)) return true;
          return isValidPlate(value, bodyType);
        },
      },
    });
  };
}
