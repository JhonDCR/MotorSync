// T024 (002, PR1): mensajes de los códigos del contrato 002 (specs/002-autenticacion/contracts/openapi.yaml).
// Archivo nuevo: problem.spec.ts de la 001 no se modifica (tasks.md, "Tests").
//
// Contrato para el implementer-frontend (T025), archivos core/api/api.models.ts y core/api/problem.ts:
//   - PROBLEM_CODES incluye todos los códigos nuevos del enum Problem.code del contrato 002
//     (AUTH_PROBLEM_CODES de src/testing/auth-fixtures.ts), sin quitar los de la 001.
//   - problemMessage() devuelve EXACTAMENTE los mensajes que fija spec.md:
//       RUC_ALREADY_REGISTERED      "Este RUC ya tiene un taller registrado en MotorSync"            (US1-AC4)
//       REGISTRATION_FAILED         "No se pudo completar el registro con estos datos; si ya tiene una cuenta, inicie sesión" (US1-AC5)
//       INVALID_CREDENTIALS         "Correo o contraseña incorrectos"                                (US2-AC3)
//       ACCOUNT_LOCKED              "Demasiados intentos fallidos. Intente de nuevo en unos minutos" (US2-AC5)
//       TEMPORARY_PASSWORD_EXPIRED  "Su contraseña temporal venció. Pida al administrador de su taller que la restablezca" (US5-AC9)
//     El resto de códigos nuevos: mensaje propio en español, distinto del código y del title del servidor.
//     Todos los mensajes de PROBLEM_CODES siguen siendo distintos entre sí (lo exige también problem.spec.ts).
//   - fieldErrorMessage(): PASSWORD_TOO_SHORT menciona "8 caracteres"; PASSWORD_TOO_LONG menciona "128 caracteres".
//     Ningún mensaje repite el `message` del servidor (que podría traer datos enviados, p. ej. la contraseña).
import { PROBLEM_CODES, type FieldError } from './api.models';
import { fieldErrorMessage, problemMessage } from './problem';
import { AUTH_MESSAGES, AUTH_PROBLEM_CODES, authProblem } from '../../../testing/auth-fixtures';

function fieldError(code: string, field = 'password'): FieldError {
  return { field, code, message: 'mensaje del servidor' };
}

describe('problem: códigos de autenticación (T024, contrato 002)', () => {
  it.each(AUTH_PROBLEM_CODES)('[contrato 002 Problem] PROBLEM_CODES incluye %s', (code) => {
    expect(PROBLEM_CODES as readonly string[]).toContain(code);
  });

  it('[US1-AC4][FR-023] RUC_ALREADY_REGISTERED → "Este RUC ya tiene un taller registrado en MotorSync"', () => {
    expect(problemMessage(authProblem(409, 'RUC_ALREADY_REGISTERED'))).toBe(AUTH_MESSAGES.RUC_ALREADY_REGISTERED);
  });

  it('[US1-AC5][FR-023] REGISTRATION_FAILED → mensaje genérico que no confirma el correo', () => {
    const message = problemMessage(authProblem(409, 'REGISTRATION_FAILED'));
    expect(message).toBe(AUTH_MESSAGES.REGISTRATION_FAILED);
    expect(message).not.toMatch(/correo/i);
  });

  it('[US2-AC3][FR-008] INVALID_CREDENTIALS → "Correo o contraseña incorrectos"', () => {
    expect(problemMessage(authProblem(401, 'INVALID_CREDENTIALS'))).toBe(AUTH_MESSAGES.INVALID_CREDENTIALS);
  });

  it('[US2-AC5][US2-AC8] ACCOUNT_LOCKED → "Demasiados intentos fallidos. Intente de nuevo en unos minutos"', () => {
    expect(problemMessage(authProblem(429, 'ACCOUNT_LOCKED'))).toBe(AUTH_MESSAGES.ACCOUNT_LOCKED);
  });

  it('[US5-AC9] TEMPORARY_PASSWORD_EXPIRED → mensaje de temporal vencida', () => {
    expect(problemMessage(authProblem(401, 'TEMPORARY_PASSWORD_EXPIRED'))).toBe(
      AUTH_MESSAGES.TEMPORARY_PASSWORD_EXPIRED,
    );
  });

  it.each(AUTH_PROBLEM_CODES)('[contrato 002 Problem] %s tiene un mensaje propio en español', (code) => {
    const message = problemMessage(authProblem(400, code, { title: 'Titulo del servidor', detail: 'detalle del servidor' }));
    expect(message.trim().length).toBeGreaterThan(0);
    expect(message).not.toBe(code);
    expect(message).not.toBe('Titulo del servidor');
    expect(message).not.toBe('detalle del servidor');
  });

  it('[contrato 002 Problem] los mensajes de todos los códigos son distintos entre sí', () => {
    const messages = new Set(PROBLEM_CODES.map((code) => problemMessage(authProblem(400, code))));
    expect(messages.size).toBe(PROBLEM_CODES.length);
  });
});

describe('problem: errores de campo de autenticación (T024, contrato 002)', () => {
  it('[US1-AC6][FR-005] PASSWORD_TOO_SHORT indica el mínimo de 8 caracteres', () => {
    const message = fieldErrorMessage(fieldError('PASSWORD_TOO_SHORT'));
    expect(message).toMatch(/8 caracteres/);
    expect(message).not.toBe('mensaje del servidor');
  });

  it('[FR-005] PASSWORD_TOO_LONG indica el máximo de 128 caracteres', () => {
    const message = fieldErrorMessage(fieldError('PASSWORD_TOO_LONG'));
    expect(message).toMatch(/128 caracteres/);
    expect(message).not.toBe('mensaje del servidor');
  });

  it('[US1-AC3] INVALID_RUC en el campo ruc del registro → "RUC inválido"', () => {
    expect(fieldErrorMessage(fieldError('INVALID_RUC', 'ruc'))).toBe('RUC inválido');
  });
});
