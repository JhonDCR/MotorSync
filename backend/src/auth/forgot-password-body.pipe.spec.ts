// T020 (specs/003-soporte-plataforma): ForgotPasswordBodyPipe, el body del endpoint público
// "¿Olvidaste tu contraseña?" (research R7; US1-AC8, US1-AC9). Normaliza el correo (trim +
// minúsculas), lo valida y descarta cualquier otro campo en lugar de rechazarlo
// (`whitelist: true, forbidNonWhitelisted: false`). Entrega en rojo: el pipe llega en T021.
import { EMAIL_MAX_LENGTH } from '../common/identifiers/email.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { REQUIRED } from './dto/register.dto.js';
import { ForgotPasswordBodyPipe } from './forgot-password-body.pipe.js';

const INVALID_EMAIL_MESSAGE = 'Correo electrónico inválido';
const VALID_EMAIL = 'ana.perez@taller.ec';

const pipe = new ForgotPasswordBodyPipe();

function problemOf(run: () => unknown): ProblemException {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemException);
    return error as ProblemException;
  }
  throw new Error('se esperaba un ProblemException');
}

/** Asserts 400 VALIDATION_ERROR with exactly one error in `email` carrying `code`. */
function expectProblem(
  value: unknown,
  code: 'REQUIRED' | 'INVALID_EMAIL',
): ProblemException {
  const error = problemOf(() => pipe.transform(value));
  expect(error.getStatus()).toBe(400);
  expect(error.code).toBe('VALIDATION_ERROR');
  expect(error.extra.errors).toEqual([
    {
      field: 'email',
      code,
      message: code === 'REQUIRED' ? REQUIRED : INVALID_EMAIL_MESSAGE,
    },
  ]);
  return error;
}

/**
 * Well-formed address of exactly `total` characters: a 64-character local part (the limit of
 * `isValidEmail`) and a domain padded with labels of at most 63 characters. Used for the
 * 254/255 boundary without exceeding the local-part limit.
 */
function wellFormedEmailOfLength(total: number): string {
  const local = 'a'.repeat(64);
  const labels = ['ec'];
  let remaining = total - local.length - 1 - labels[0].length;
  while (remaining > 0) {
    const labelLength = Math.min(63, remaining - 1);
    labels.unshift('b'.repeat(labelLength));
    remaining -= labelLength + 1;
  }
  return `${local}@${labels.join('.')}`;
}

describe('ForgotPasswordBodyPipe (T020, research R7)', () => {
  it('[US1-AC9] conserva solo el correo normalizado e ignora tenantId, userId y ticketId', () => {
    const result = pipe.transform({
      email: ' Ana.Perez@Taller.EC ',
      tenantId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      ticketId: '33333333-3333-4333-8333-333333333333',
    });

    expect(result).toEqual({ email: VALID_EMAIL });
    expect(Object.keys(result)).toEqual(['email']);
  });

  it('[US1-AC8] sin email → 400 REQUIRED en email', () => {
    expectProblem({}, 'REQUIRED');
  });

  it('[US1-AC8] con email de solo espacios → 400 REQUIRED en email', () => {
    expectProblem({ email: '   ' }, 'REQUIRED');
  });

  it('[US1-AC8] con email que no es texto → 400 REQUIRED en email', () => {
    expectProblem({ email: 42 }, 'REQUIRED');
  });

  it('[US1-AC8] con email sin arroba → 400 INVALID_EMAIL en email', () => {
    expectProblem({ email: 'nadie' }, 'INVALID_EMAIL');
  });

  it('[US1-AC8] con TLD de una letra → 400 INVALID_EMAIL en email', () => {
    expectProblem({ email: 'a@b.c' }, 'INVALID_EMAIL');
  });

  it('[US1-AC8] rechaza más de 254 caracteres y acepta exactamente 254 bien formados', () => {
    const tooLong = wellFormedEmailOfLength(EMAIL_MAX_LENGTH + 1);
    expect(tooLong).toHaveLength(255);
    expectProblem({ email: tooLong }, 'INVALID_EMAIL');

    const atLimit = wellFormedEmailOfLength(EMAIL_MAX_LENGTH);
    expect(atLimit).toHaveLength(254);
    expect(pipe.transform({ email: atLimit })).toEqual({ email: atLimit });
  });

  it('[US1-AC8] el literal de tasks.md mide 254 pero su parte local supera el límite → INVALID_EMAIL', () => {
    // `'a'.repeat(243) + '@ejemplo.ec'` tiene 254 caracteres (no 255) y una parte local de 243,
    // por encima de los 64 de `isValidEmail`: es inválido por formato, no por longitud total.
    const literal = `${'a'.repeat(243)}@ejemplo.ec`;
    expect(literal).toHaveLength(EMAIL_MAX_LENGTH);
    expectProblem({ email: literal }, 'INVALID_EMAIL');
  });

  it.each([
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'texto', value: 'texto' },
    { label: 'número', value: 42 },
    { label: 'array', value: [] },
  ])(
    '[US1-AC8] un body que no es objeto ($label) → 400 REQUIRED en email',
    ({ value }) => {
      expectProblem(value, 'REQUIRED');
    },
  );

  it('[US1-AC9] con __proto__, constructor y otras claves raras devuelve solo { email }', () => {
    const body = JSON.parse(
      `{"email":"${VALID_EMAIL}","__proto__":{"polluted":true},"constructor":"x","otra":1}`,
    ) as Record<string, unknown>;

    const result = pipe.transform(body);

    expect(result).toEqual({ email: VALID_EMAIL });
    expect(Object.keys(result)).toEqual(['email']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
