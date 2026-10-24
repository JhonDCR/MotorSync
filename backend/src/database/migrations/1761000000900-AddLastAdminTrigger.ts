import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration 1761000000900-AddLastAdminTrigger (T052, FR-018, US4-AC9).
 * Defense in depth at database level (research R8): ensures a tenant always
 * keeps at least one active administrator upon transaction commit.
 */
export class AddLastAdminTrigger1761000000900 implements MigrationInterface {
  name = 'AddLastAdminTrigger1761000000900';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION users_require_active_admin() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM users
                        WHERE tenant_id = NEW.tenant_id AND role = 'admin' AND status = 'active') THEN
          RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'users_last_admin',
                                MESSAGE = 'tenant must keep at least one active admin';
        END IF;
        RETURN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER users_keep_active_admin
        AFTER UPDATE OF role, status ON users
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        WHEN (OLD.role = 'admin' AND OLD.status = 'active')
        EXECUTE FUNCTION users_require_active_admin();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER IF EXISTS users_keep_active_admin ON users');
    await queryRunner.query('DROP FUNCTION IF EXISTS users_require_active_admin()');
  }
}
