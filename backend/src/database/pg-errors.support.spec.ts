// T017 (specs/003-soporte-plataforma): new translations of PostgreSQL errors (data-model 003).
// 28000 raised by a support_* function → 401 SESSION_REVOKED; P0002 (no_data_found) → 404
// NOT_FOUND; the 23505 of users_email_key raised by the users_email_not_support trigger keeps the
// generic 002 translation (EMAIL_UNAVAILABLE) and never mentions support. The 001/002 specs are
// not touched; their codes are re-checked here only as regression.
import { QueryFailedError } from 'typeorm';
import { translatePgError } from './pg-errors.js';

interface PgErrorOptions {
  constraint?: string;
  where?: string;
}

type PgError = Error & { code: string } & PgErrorOptions;

function pgError(code: string, options: PgErrorOptions = {}): PgError {
  return Object.assign(new Error(`pg error ${code}`), { code, ...options });
}

function typeormError(
  code: string,
  options: PgErrorOptions = {},
): QueryFailedError {
  return new QueryFailedError('SELECT ...', [], pgError(code, options));
}

const LIST_OPEN_TICKETS_WHERE =
  'PL/pgSQL function support_list_open_tickets(uuid) line 12 at RAISE';
const DISCARD_TICKET_WHERE =
  'PL/pgSQL function support_discard_ticket(uuid,uuid,text,text) line 20 at RAISE';
const AUTH_WHERE =
  'PL/pgSQL function auth_login_attempt(text,text) line 9 at RAISE';
const EMAIL_TRIGGER_WHERE =
  'PL/pgSQL function users_email_not_support() line 4 at RAISE';

describe('translatePgError: soporte (T017, data-model 003)', () => {
  describe.each([
    ['pg (driver)', pgError],
    ['TypeORM QueryFailedError', typeormError],
  ])('con un error %s', (_label, make) => {
    it('[T017][US2-AC9] 28000 lanzado por support_list_open_tickets → 401 SESSION_REVOKED', () => {
      expect(
        translatePgError(make('28000', { where: LIST_OPEN_TICKETS_WHERE })),
      ).toEqual({
        status: 401,
        code: 'SESSION_REVOKED',
      });
    });

    it('[T017][US2-AC9] 28000 lanzado por support_discard_ticket → 401 SESSION_REVOKED', () => {
      expect(
        translatePgError(make('28000', { where: DISCARD_TICKET_WHERE })),
      ).toEqual({
        status: 401,
        code: 'SESSION_REVOKED',
      });
    });

    it('[T017] un 28000 sin where o de una función que no es support_* no se traduce', () => {
      expect(translatePgError(make('28000'))).toBeNull();
      expect(translatePgError(make('28000', { where: AUTH_WHERE }))).toBeNull();
      expect(
        translatePgError(
          make('28000', {
            where: 'PL/pgSQL function tenants_lookup() line 3 at RAISE',
          }),
        ),
      ).toBeNull();
    });

    it('[T017][US4-AC7] P0002 (no_data_found) → 404 NOT_FOUND', () => {
      expect(translatePgError(make('P0002'))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
      expect(
        translatePgError(
          make('P0002', {
            where:
              'PL/pgSQL function support_list_workshop_accounts(uuid,uuid,text) line 30 at RAISE',
          }),
        ),
      ).toEqual({ status: 404, code: 'NOT_FOUND' });
    });

    it('[T017][FR-024] 23505 en users_email_key lanzado por users_email_not_support → 409 EMAIL_UNAVAILABLE sin datos de soporte', () => {
      const translated = translatePgError(
        make('23505', {
          constraint: 'users_email_key',
          where: EMAIL_TRIGGER_WHERE,
        }),
      );
      expect(translated).toEqual({ status: 409, code: 'EMAIL_UNAVAILABLE' });
      expect(translated).not.toHaveProperty('errors');
      expect(JSON.stringify(translated).toLowerCase()).not.toContain('support');
    });

    it('[T017] regresión: 23505 en users_email_key sin where sigue dando EMAIL_UNAVAILABLE', () => {
      expect(
        translatePgError(make('23505', { constraint: 'users_email_key' })),
      ).toEqual({
        status: 409,
        code: 'EMAIL_UNAVAILABLE',
      });
    });

    it('[T017] regresión: 23505 en tenants_ruc_key sigue dando RUC_ALREADY_REGISTERED', () => {
      expect(
        translatePgError(make('23505', { constraint: 'tenants_ruc_key' })),
      ).toEqual({
        status: 409,
        code: 'RUC_ALREADY_REGISTERED',
      });
    });

    it('[T017] regresión: 23503 y 23514 desconocidos devuelven null', () => {
      expect(
        translatePgError(
          make('23503', { constraint: 'support_tickets_user_fk' }),
        ),
      ).toBeNull();
      expect(
        translatePgError(
          make('23514', { constraint: 'support_tickets_state_coherent' }),
        ),
      ).toBeNull();
    });
  });
});
