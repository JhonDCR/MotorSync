import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isValidPhone } from '../identifiers/phone.js';

/**
 * Validates an already normalized phone (normalizePhone): optional +, then 7 to 15 digits.
 * Emits INVALID_PHONE through `context.code`.
 */
export function IsEcPhone(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isEcPhone',
      target: target.constructor,
      propertyName: String(propertyName),
      options: {
        message: 'Teléfono inválido: de 7 a 15 dígitos, opcionalmente con + al inicio',
        context: { code: 'INVALID_PHONE' },
        ...options,
      },
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidPhone(value);
        },
      },
    });
  };
}
