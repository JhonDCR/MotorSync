import type { FieldError, Problem } from './api.models';
import { fieldErrorMessage, fieldErrorMessages, isProblem, problemMessage } from './problem';

// Traducción de `code` (Problem) y `errors[].code` (FieldError) de contracts/openapi.yaml
// a los mensajes en español de spec.md. Los mensajes que la spec fija literalmente se
// comparan exactos; el resto debe existir, estar en español y no ser el código crudo.

function problem(code: Problem['code'], extra: Partial<Problem> = {}): Problem {
  return { type: 'about:blank', title: 'Error', status: 400, code, ...extra };
}

function fieldError(code: string, field = 'campo'): FieldError {
  return { field, code, message: 'mensaje del servidor' };
}

describe('problem: errores de campo (errors[].code)', () => {
  it('[US2-AC4] INVALID_CEDULA → "Cédula inválida"', () => {
    expect(fieldErrorMessage(fieldError('INVALID_CEDULA', 'documentNumber'))).toBe('Cédula inválida');
  });

  it('[US2-AC5] INVALID_RUC → "RUC inválido"', () => {
    expect(fieldErrorMessage(fieldError('INVALID_RUC', 'documentNumber'))).toBe('RUC inválido');
  });

  it('[US3-AC12] INVALID_PLATE con carrocería de auto → mensaje de formato de auto', () => {
    const expected = 'Placa inválida: para autos use 3 letras y 3 o 4 dígitos (ej. PBA1234)';
    for (const bodyType of ['sedan', 'suv', 'pickup', 'other'] as const) {
      expect(fieldErrorMessage(fieldError('INVALID_PLATE', 'plate'), { bodyType })).toBe(expected);
    }
  });

  it('[US3-AC13] INVALID_PLATE con carrocería moto → mensaje de formato de moto', () => {
    expect(fieldErrorMessage(fieldError('INVALID_PLATE', 'plate'), { bodyType: 'motorcycle' })).toBe(
      'Placa inválida: para motos use 2 letras, 3 dígitos y 1 letra (ej. AB123C)',
    );
  });

  it('[US3-AC14] INVALID_PLATE sin carrocería conocida → mensaje que empieza por "Placa inválida"', () => {
    expect(fieldErrorMessage(fieldError('INVALID_PLATE', 'plate'))).toMatch(/^Placa inválida/);
  });

  it('[US3-AC4] INVALID_VIN → "VIN inválido"', () => {
    expect(fieldErrorMessage(fieldError('INVALID_VIN', 'vin'))).toBe('VIN inválido');
  });

  it('[US4-AC15] REASON_REQUIRED → "El motivo es obligatorio (entre 10 y 500 caracteres)"', () => {
    expect(fieldErrorMessage(fieldError('REASON_REQUIRED', 'reason'))).toBe(
      'El motivo es obligatorio (entre 10 y 500 caracteres)',
    );
  });

  it.each([
    'INVALID_PASSPORT',
    'INVALID_DOCUMENT_TYPE',
    'INVALID_PHONE',
    'INVALID_EMAIL',
    'INVALID_YEAR',
    'INVALID_MILEAGE',
    'REQUIRED',
    'UNKNOWN_FIELD',
  ])('[contrato ValidationError] %s tiene un mensaje propio en español', (code) => {
    const message = fieldErrorMessage(fieldError(code));
    expect(message.trim().length).toBeGreaterThan(0);
    expect(message).not.toBe(code);
    expect(message).not.toBe('mensaje del servidor');
  });

  it('[contrato ValidationError] cada código de campo produce un mensaje distinto', () => {
    const codes = [
      'INVALID_VIN',
      'INVALID_CEDULA',
      'INVALID_RUC',
      'INVALID_PASSPORT',
      'INVALID_DOCUMENT_TYPE',
      'INVALID_PHONE',
      'INVALID_EMAIL',
      'INVALID_YEAR',
      'INVALID_MILEAGE',
      'REASON_REQUIRED',
      'REQUIRED',
      'UNKNOWN_FIELD',
    ];
    const messages = new Set(codes.map((code) => fieldErrorMessage(fieldError(code))));
    expect(messages.size).toBe(codes.length);
  });

  it('[contrato FieldError] un código desconocido usa el `message` que envió el servidor', () => {
    expect(fieldErrorMessage(fieldError('SOMETHING_NEW'))).toBe('mensaje del servidor');
  });

  it('[US2-AC4][US3-AC12] fieldErrorMessages agrupa errors[] por campo con el mensaje traducido', () => {
    const body = problem('VALIDATION_ERROR', {
      errors: [
        { field: 'plate', code: 'INVALID_PLATE', message: 'x' },
        { field: 'vin', code: 'INVALID_VIN', message: 'x' },
      ],
    });
    expect(fieldErrorMessages(body, { bodyType: 'sedan' })).toEqual({
      plate: 'Placa inválida: para autos use 3 letras y 3 o 4 dígitos (ej. PBA1234)',
      vin: 'VIN inválido',
    });
  });

  it('[contrato Problem] fieldErrorMessages sin errors[] devuelve un objeto vacío', () => {
    expect(fieldErrorMessages(problem('NOT_FOUND', { status: 404 }))).toEqual({});
  });
});

describe('problem: código del Problem (code)', () => {
  it('[US1-AC6][US1-AC8] NOT_FOUND de un vehículo → "No se encontró ningún vehículo"', () => {
    expect(problemMessage(problem('NOT_FOUND', { status: 404 }), { resource: 'vehicle' })).toBe(
      'No se encontró ningún vehículo',
    );
  });

  it('[US1-AC9][FR-023] NOT_FOUND sin recurso indica "no encontrado" y no habla de acceso denegado', () => {
    const message = problemMessage(problem('NOT_FOUND', { status: 404 }));
    expect(message).toMatch(/no encontrado/i);
    expect(message).not.toMatch(/acceso|denegad|permiso|otro taller/i);
  });

  it('[US3-AC11] CLIENT_NOT_FOUND → "cliente no encontrado"', () => {
    expect(problemMessage(problem('CLIENT_NOT_FOUND', { status: 404 }))).toMatch(/^cliente no encontrado$/i);
  });

  it('[US4-AC7 edge case] SAME_OWNER → "El vehículo ya pertenece a este cliente"', () => {
    expect(problemMessage(problem('SAME_OWNER', { status: 422 }))).toBe('El vehículo ya pertenece a este cliente');
  });

  it('[US1-AC5] SEARCH_TERM_TOO_SHORT → "Escriba al menos 2 caracteres"', () => {
    expect(problemMessage(problem('SEARCH_TERM_TOO_SHORT'))).toBe('Escriba al menos 2 caracteres');
  });

  it('[US3-AC3][FR-024] PLATE_ALREADY_EXISTS indica que la placa ya está registrada, sin mencionar otros talleres', () => {
    const message = problemMessage(problem('PLATE_ALREADY_EXISTS', { status: 409, existingId: 'x' }));
    expect(message).toMatch(/placa ya está registrada/i);
    expect(message).not.toMatch(/otro taller/i);
  });

  it('[US3-AC5][FR-024] VIN_ALREADY_EXISTS indica que el VIN ya está registrado, sin mencionar otros talleres', () => {
    const message = problemMessage(problem('VIN_ALREADY_EXISTS', { status: 409, existingId: 'x' }));
    expect(message).toMatch(/VIN ya está registrado/);
    expect(message).not.toMatch(/otro taller/i);
  });

  it('[US2-AC6][FR-024] DOCUMENT_ALREADY_EXISTS indica que el documento ya está registrado, sin mencionar otros talleres', () => {
    const message = problemMessage(problem('DOCUMENT_ALREADY_EXISTS', { status: 409, existingId: 'x' }));
    expect(message).toMatch(/documento ya está registrado/i);
    expect(message).not.toMatch(/otro taller/i);
  });

  it.each(['UNAUTHORIZED', 'VALIDATION_ERROR', 'VERSION_CONFLICT'] as const)(
    '[contrato Problem] %s tiene un mensaje propio en español',
    (code) => {
      const message = problemMessage(problem(code, { title: 'Titulo del servidor' }));
      expect(message.trim().length).toBeGreaterThan(0);
      expect(message).not.toBe(code);
      expect(message).not.toBe('Titulo del servidor');
    },
  );

  it('[contrato Problem] cada code del enum produce un mensaje distinto', () => {
    const codes: Problem['code'][] = [
      'UNAUTHORIZED',
      'VALIDATION_ERROR',
      'SEARCH_TERM_TOO_SHORT',
      'NOT_FOUND',
      'CLIENT_NOT_FOUND',
      'PLATE_ALREADY_EXISTS',
      'VIN_ALREADY_EXISTS',
      'DOCUMENT_ALREADY_EXISTS',
      'VERSION_CONFLICT',
      'SAME_OWNER',
    ];
    const messages = new Set(codes.map((code) => problemMessage(problem(code))));
    expect(messages.size).toBe(codes.length);
  });

  it('[contrato Problem] un code desconocido usa `detail` y, si no hay, `title`', () => {
    const unknown = { type: 'about:blank', title: 'Título', status: 500, code: 'NEW_CODE' } as unknown as Problem;
    expect(problemMessage({ ...unknown, detail: 'Detalle' })).toBe('Detalle');
    expect(problemMessage(unknown)).toBe('Título');
  });
});

describe('problem: isProblem', () => {
  it('[contrato Problem] reconoce un cuerpo application/problem+json', () => {
    expect(isProblem(problem('NOT_FOUND', { status: 404 }))).toBe(true);
  });

  it('[contrato Problem] rechaza cuerpos que no son Problem', () => {
    expect(isProblem(null)).toBe(false);
    expect(isProblem('error')).toBe(false);
    expect(isProblem({ status: 404 })).toBe(false);
    expect(isProblem({ code: 'NOT_FOUND' })).toBe(false);
  });
});
