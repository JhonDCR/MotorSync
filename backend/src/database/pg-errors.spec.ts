// T013: translation of PostgreSQL constraint errors to the contract error codes (research R5).
// pg reports the name of the unique index in `constraint` for 23505.
import { QueryFailedError } from 'typeorm';
import { translatePgError } from './pg-errors.js';

function pgError(code: string, constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(new Error(`pg error ${code} on ${constraint}`), { code, constraint });
}

function typeormError(code: string, constraint: string): QueryFailedError {
  return new QueryFailedError('INSERT ...', [], pgError(code, constraint));
}

describe('translatePgError (T013, research R5)', () => {
  describe.each([
    ['pg (driver)', pgError],
    ['TypeORM QueryFailedError', typeormError],
  ])('con un error %s', (_label, make) => {
    it('[T013][US2-AC6] 23505 en clients_tenant_document_key → 409 DOCUMENT_ALREADY_EXISTS', () => {
      expect(translatePgError(make('23505', 'clients_tenant_document_key'))).toMatchObject({
        status: 409,
        code: 'DOCUMENT_ALREADY_EXISTS',
      });
    });

    it('[T013] 23505 en vehicles_tenant_plate_key → 409 PLATE_ALREADY_EXISTS', () => {
      expect(translatePgError(make('23505', 'vehicles_tenant_plate_key'))).toMatchObject({
        status: 409,
        code: 'PLATE_ALREADY_EXISTS',
      });
    });

    it('[T013] 23505 en vehicles_tenant_vin_key → 409 VIN_ALREADY_EXISTS', () => {
      expect(translatePgError(make('23505', 'vehicles_tenant_vin_key'))).toMatchObject({
        status: 409,
        code: 'VIN_ALREADY_EXISTS',
      });
    });

    it('[T013] 23514 en vehicles_plate_format → 400 VALIDATION_ERROR con errors[] INVALID_PLATE en plate', () => {
      const translated = translatePgError(make('23514', 'vehicles_plate_format'));
      expect(translated).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
      expect(translated?.errors).toEqual([
        expect.objectContaining({ field: 'plate', code: 'INVALID_PLATE' }),
      ]);
      expect(typeof translated?.errors?.[0].message).toBe('string');
    });

    it('[T013] un 23505 de otra restricción no se traduce', () => {
      expect(translatePgError(make('23505', 'tenants_pkey'))).toBeNull();
    });

    it('[T013] el mismo nombre de restricción con otro código no se traduce', () => {
      expect(translatePgError(make('23514', 'clients_tenant_document_key'))).toBeNull();
      expect(translatePgError(make('42501', 'vehicles_plate_format'))).toBeNull();
    });
  });

  it('[T013] errores que no son de PostgreSQL devuelven null', () => {
    expect(translatePgError(new Error('boom'))).toBeNull();
    expect(translatePgError(undefined)).toBeNull();
    expect(translatePgError(null)).toBeNull();
    expect(translatePgError('23505')).toBeNull();
    expect(translatePgError({ code: '23505' })).toBeNull();
  });

  it('[T013] el resultado de un duplicado no inventa existingId (lo añade el servicio consultando bajo RLS)', () => {
    const translated = translatePgError(pgError('23505', 'clients_tenant_document_key'));
    expect(translated).not.toBeNull();
    expect(translated).not.toHaveProperty('existingId');
  });
});
