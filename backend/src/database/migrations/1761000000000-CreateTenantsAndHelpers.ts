import type { MigrationInterface, QueryRunner } from 'typeorm';

/** DDL from specs/001-clientes-vehiculos/data-model.md, "Funciones auxiliares". */
export class CreateTenantsAndHelpers1761000000000 implements MigrationInterface {
  name = 'CreateTenantsAndHelpers1761000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tenants (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
        created_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Tenant of the current transaction. NULL if not pinned, so policies show no rows.
    await queryRunner.query(`
      CREATE FUNCTION app_current_tenant() RETURNS uuid
        LANGUAGE sql STABLE PARALLEL SAFE
        AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$
    `);

    // unaccent() is STABLE; this IMMUTABLE wrapper allows generated columns and indexes.
    await queryRunner.query(`
      CREATE FUNCTION immutable_unaccent(text) RETURNS text
        LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
        AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$
    `);

    await queryRunner.query(
      'GRANT EXECUTE ON FUNCTION app_current_tenant(), immutable_unaccent(text) TO motorsync_app',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP FUNCTION immutable_unaccent(text)');
    await queryRunner.query('DROP FUNCTION app_current_tenant()');
    await queryRunner.query('DROP TABLE tenants');
  }
}
