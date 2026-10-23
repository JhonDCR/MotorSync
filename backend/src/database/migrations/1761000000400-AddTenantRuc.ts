import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DDL from specs/002-autenticacion/data-model.md, "Migración `1761000000400-AddTenantRuc`",
 * verbatim. RLS on tenants is ENABLE without FORCE: the migrator (owner) keeps inserting
 * workshops in fixtures and seeds as in feature 001 (research R9).
 */
export class AddTenantRuc1761000000400 implements MigrationInterface {
  name = 'AddTenantRuc1761000000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tenants ADD COLUMN ruc text COLLATE "C"
        CHECK (ruc IS NULL OR ruc ~ '^[0-9]{10}001$')
    `);
    // FR-002 (NULLs do not collide).
    await queryRunner.query('CREATE UNIQUE INDEX tenants_ruc_key ON tenants (ruc)');

    await queryRunner.query('ALTER TABLE tenants ENABLE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY tenants_self ON tenants FOR SELECT TO motorsync_app
        USING (id = app_current_tenant())
    `);
    await queryRunner.query(`
      CREATE POLICY tenants_auth_register ON tenants FOR INSERT TO motorsync_auth
        WITH CHECK (id = app_current_tenant())
    `);

    await queryRunner.query('GRANT SELECT ON tenants TO motorsync_app');
    await queryRunner.query('GRANT INSERT (id, name, ruc) ON tenants TO motorsync_auth');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('REVOKE INSERT (id, name, ruc) ON tenants FROM motorsync_auth');
    await queryRunner.query('REVOKE SELECT ON tenants FROM motorsync_app');
    await queryRunner.query('DROP POLICY tenants_auth_register ON tenants');
    await queryRunner.query('DROP POLICY tenants_self ON tenants');
    await queryRunner.query('ALTER TABLE tenants DISABLE ROW LEVEL SECURITY');
    // Drops tenants_ruc_key and the CHECK as well.
    await queryRunner.query('ALTER TABLE tenants DROP COLUMN ruc');
  }
}
