// T016 (specs/002-autenticacion): new translations of PostgreSQL constraint errors (research R8, R12).
// pg-errors.spec.ts of the 001 is not touched; the 001 codes are re-checked here only to prove
// that adding the new entries did not change them.
import { QueryFailedError } from 'typeorm';
import { translatePgError } from './pg-errors.js';

function pgError(code: string, constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error(`pg error ${code} on ${constraint}`), { code, constraint });
}

function typeormError(code: string, constraint: string): QueryFailedError {
  return new QueryFailedError('INSERT ...', [], pgError(code, constraint));
}

describe('translatePgError: autenticación (T016, research R12)', () => {
  describe.each([
    ['pg (driver)', pgError],
    ['TypeORM QueryFailedError', typeormError],
  ])('con un error %s', (_label, make) => {
    it('[US1-AC5][FR-002] 23505 en tenants_ruc_key → 409 RUC_ALREADY_REGISTERED', () => {
      expect(translatePgError(make('23505', 'tenants_ruc_key'))).toEqual({
        status: 409,
        code: 'RUC_ALREADY_REGISTERED',
      });
    });

    it('[FR-003][FR-023] 23505 en users_email_key → 409 EMAIL_UNAVAILABLE, sin datos de la otra cuenta', () => {
      expect(translatePgError(make('23505', 'users_email_key'))).toEqual({
        status: 409,
        code: 'EMAIL_UNAVAILABLE',
      });
    });

    it('[FR-018][US4-AC9] 23514 en users_last_admin → 409 LAST_ADMIN', () => {
      expect(translatePgError(make('23514', 'users_last_admin'))).toEqual({
        status: 409,
        code: 'LAST_ADMIN',
      });
    });

    it('[T016] los nombres nuevos con otro código de error no se traducen', () => {
      expect(translatePgError(make('23514', 'tenants_ruc_key'))).toBeNull();
      expect(translatePgError(make('23514', 'users_email_key'))).toBeNull();
      expect(translatePgError(make('23505', 'users_last_admin'))).toBeNull();
      expect(translatePgError(make('42501', 'users_email_key'))).toBeNull();
    });

    it('[T016] otras restricciones de las tablas nuevas no se traducen', () => {
      expect(translatePgError(make('23505', 'users_pkey'))).toBeNull();
      expect(translatePgError(make('23505', 'refresh_tokens_token_hash_key'))).toBeNull();
      expect(translatePgError(make('23514', 'user_sessions_revoked_coherent'))).toBeNull();
    });

    it('[T016] los códigos de la 001 no cambian', () => {
      expect(translatePgError(make('23505', 'clients_tenant_document_key'))).toMatchObject({
        status: 409,
        code: 'DOCUMENT_ALREADY_EXISTS',
      });
      expect(translatePgError(make('23505', 'vehicles_tenant_plate_key'))).toMatchObject({
        status: 409,
        code: 'PLATE_ALREADY_EXISTS',
      });
      expect(translatePgError(make('23505', 'vehicles_tenant_vin_key'))).toMatchObject({
        status: 409,
        code: 'VIN_ALREADY_EXISTS',
      });
      expect(translatePgError(make('23514', 'vehicles_plate_format'))).toMatchObject({
        status: 400,
        code: 'VALIDATION_ERROR',
        errors: [expect.objectContaining({ field: 'plate', code: 'INVALID_PLATE' })],
      });
    });
  });
});
