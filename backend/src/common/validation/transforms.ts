import type { TransformFnParams } from 'class-transformer';
import { ValidateIf, type ValidationOptions } from 'class-validator';

/** Applies `fn` to strings only; other values reach the validators untouched. */
export function onString(fn: (value: string) => string): (params: TransformFnParams) => unknown {
  return ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? fn(value) : value);
}

export const trim = (value: string): string => value.trim();

/**
 * PATCH fields that may be omitted but not set to null: validated whenever the key is present
 * (unlike @IsOptional, which also skips null).
 */
export function IfPresent(options?: ValidationOptions): PropertyDecorator {
  return ValidateIf((_object: object, value: unknown) => value !== undefined, options);
}
