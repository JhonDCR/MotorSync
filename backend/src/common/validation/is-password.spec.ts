// T008 (specs/002-autenticacion): @IsPassword(), 8 to 128 Unicode characters, never trimmed (FR-005, R3).
// The field code is read through validationExceptionFactory, the same path the API uses to build
// errors[] (contract FieldError).
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { validationExceptionFactory } from '../../app.setup.js';
import type { FieldError } from '../../database/pg-errors.js';
import { IsPassword } from './is-password.js';

class PasswordDto {
  @IsPassword()
  password: unknown;
}

async function fieldErrors(password: unknown): Promise<FieldError[]> {
  const dto = plainToInstance(PasswordDto, { password });
  const errors = await validate(dto);
  if (errors.length === 0) return [];
  return validationExceptionFactory(errors).extra.errors ?? [];
}

describe('@IsPassword (T008, FR-005)', () => {
  it.each([
    ['8 caracteres ASCII', 'abcdefgh'],
    ['128 caracteres ASCII', 'a'.repeat(128)],
    ["8 veces 'ñ'", 'ñ'.repeat(8)],
    ['8 emojis', '\u{1F600}'.repeat(8)],
    ['128 emojis (256 unidades UTF-16)', '\u{1F600}'.repeat(128)],
    ['una frase con espacios', 'mi clave de taller'],
  ])('[FR-005][US1-AC6] acepta %s', async (_label, password) => {
    expect(await fieldErrors(password)).toEqual([]);
  });

  it('[FR-005][US2-AC2] no recorta espacios: 3 + 4 + 3 caracteres con espacios a los lados es válida', async () => {
    // Trimmed it would have 4 characters and be rejected.
    expect(await fieldErrors('   abcd   ')).toEqual([]);
  });

  it('[FR-005] no transforma el valor (sin trim ni normalización Unicode)', async () => {
    const raw = '  ClavéTaller  ';
    const dto = plainToInstance(PasswordDto, { password: raw });
    await validate(dto);
    expect(dto.password).toBe(raw);
  });

  it.each([
    ['7 caracteres ASCII', 'abcdefg'],
    ['vacía', ''],
    ['7 emojis (14 unidades UTF-16)', '\u{1F600}'.repeat(7)],
    ['4 caracteres', 'abcd'],
  ])('[FR-005][US1-AC6] %s → PASSWORD_TOO_SHORT', async (_label, password) => {
    expect(await fieldErrors(password)).toEqual([
      expect.objectContaining({ field: 'password', code: 'PASSWORD_TOO_SHORT' }),
    ]);
  });

  it.each([
    ['129 caracteres ASCII', 'a'.repeat(129)],
    ['129 emojis', '\u{1F600}'.repeat(129)],
  ])('[FR-005] %s → PASSWORD_TOO_LONG', async (_label, password) => {
    expect(await fieldErrors(password)).toEqual([
      expect.objectContaining({ field: 'password', code: 'PASSWORD_TOO_LONG' }),
    ]);
  });

  it('[FR-005] los errores traen un mensaje en español no vacío', async () => {
    const [error] = await fieldErrors('corta');
    expect(typeof error.message).toBe('string');
    expect(error.message.length).toBeGreaterThan(0);
  });

  it.each([
    ['un número', 12345678],
    ['null', null],
    ['un arreglo', ['abcdefgh']],
  ])('[FR-005] rechaza %s', async (_label, password) => {
    const errors = await fieldErrors(password);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('password');
  });
});
