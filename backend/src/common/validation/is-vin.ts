import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isValidVin } from '../identifiers/vin.js';

/**
 * Validates an already normalized VIN (normalizeVin): 17 characters without I, O or Q.
 * Emits INVALID_VIN through `context.code`.
 */
export function IsVin(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isVin',
      target: target.constructor,
      propertyName: String(propertyName),
      options: {
        message: 'VIN inválido: 17 letras o dígitos, sin I, O ni Q',
        context: { code: 'INVALID_VIN' },
        ...options,
      },
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidVin(value);
        },
      },
    });
  };
}
