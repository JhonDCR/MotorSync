import { registerDecorator, type ValidationOptions } from 'class-validator';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Length in Unicode code points, not UTF-16 units (FR-005, research R3). */
function codePointLength(value: string): number {
  let length = 0;
  // for...of iterates code points, so an emoji (two UTF-16 units) counts as one character.
  for (const _codePoint of value) length += 1;
  return length;
}

/**
 * Password of 8 to 128 Unicode characters, compared as typed: never trimmed nor normalized.
 * Registers two constraints so that each value fails at most one of them, and the field gets a
 * single code through `context.code`: PASSWORD_TOO_SHORT (also for a non-string value) or
 * PASSWORD_TOO_LONG.
 */
export function IsPassword(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    const property = String(propertyName);
    registerDecorator({
      name: 'isPasswordMinLength',
      target: target.constructor,
      propertyName: property,
      options: {
        message: `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`,
        context: { code: 'PASSWORD_TOO_SHORT' },
        ...options,
      },
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && codePointLength(value) >= PASSWORD_MIN_LENGTH;
        },
      },
    });
    registerDecorator({
      name: 'isPasswordMaxLength',
      target: target.constructor,
      propertyName: property,
      options: {
        message: `La contraseña debe tener como máximo ${PASSWORD_MAX_LENGTH} caracteres`,
        context: { code: 'PASSWORD_TOO_LONG' },
        ...options,
      },
      validator: {
        validate(value: unknown): boolean {
          return typeof value !== 'string' || codePointLength(value) <= PASSWORD_MAX_LENGTH;
        },
      },
    });
  };
}
