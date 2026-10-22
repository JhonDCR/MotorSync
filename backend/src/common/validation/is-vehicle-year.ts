import { registerDecorator, type ValidationOptions } from 'class-validator';

export const MIN_VEHICLE_YEAR = 1950;

/** Latest accepted model year: the current UTC year + 1 (FR-011), evaluated on every call. */
export function maxVehicleYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

export function isValidVehicleYear(value: unknown, now: Date = new Date()): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_VEHICLE_YEAR &&
    value <= maxVehicleYear(now)
  );
}

/**
 * Validates the model year: an integer (never a numeric string) from 1950 to the current
 * UTC year + 1. Emits INVALID_YEAR through `context.code`.
 */
export function IsVehicleYear(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isVehicleYear',
      target: target.constructor,
      propertyName: String(propertyName),
      options: {
        message: (): string =>
          `Año inválido: entero entre ${MIN_VEHICLE_YEAR} y ${maxVehicleYear()}`,
        context: { code: 'INVALID_YEAR' },
        ...options,
      },
      validator: {
        validate(value: unknown): boolean {
          return isValidVehicleYear(value);
        },
      },
    });
  };
}
