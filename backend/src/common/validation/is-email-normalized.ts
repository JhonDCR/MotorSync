import { Transform } from 'class-transformer';
import { registerDecorator, type ValidationOptions } from 'class-validator';
import { isValidEmail, normalizeEmail } from '../identifiers/email.js';
import { onString } from './transforms.js';

/**
 * Normalizes the email (trim + lowercase, FR-003) and validates the normalized value.
 * Emits INVALID_EMAIL through `context.code`. Non-string values are rejected untouched.
 */
export function IsEmailNormalized(options: ValidationOptions = {}): PropertyDecorator {
  const transform = Transform(onString(normalizeEmail));
  return (target: object, propertyName: string | symbol): void => {
    transform(target, propertyName);
    registerDecorator({
      name: 'isEmailNormalized',
      target: target.constructor,
      propertyName: String(propertyName),
      options: {
        message: 'Correo electrónico inválido',
        context: { code: 'INVALID_EMAIL' },
        ...options,
      },
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidEmail(value);
        },
      },
    });
  };
}
