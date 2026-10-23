import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DDL from specs/002-autenticacion/data-model.md, "Migración `1761000000500-CreateUsers`",
 * verbatim. The email is unique across MotorSync (FR-003) and motorsync_app has no DELETE
 * (FR-017). The last-admin trigger is not here: it is migration 900 (T052, PR3).
 */
export class CreateUsers1761000000500 implements MigrationInterface {
  name = 'CreateUsers1761000000500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // String.raw keeps the backslashes of the email regex ('^[^@\s]+@[^@\s]+$') intact.
    await queryRunner.query(String.raw`
      CREATE TABLE users (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                 uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        name                      text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
        email                     text COLLATE "C" NOT NULL CHECK (
                                    email = lower(btrim(email))
                                    AND length(email) BETWEEN 3 AND 254
                                    AND email ~ '^[^@\s]+@[^@\s]+$'),
        password_hash             text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
        role                      text NOT NULL CHECK (role IN ('asesor', 'admin')),
        status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        must_change_password      boolean NOT NULL DEFAULT false,
        temp_password_expires_at  timestamptz,
        created_at                timestamptz NOT NULL DEFAULT now(),
        created_by                uuid NOT NULL,
        updated_at                timestamptz NOT NULL DEFAULT now(),
        updated_by                uuid NOT NULL,
        updated_by_name           text NOT NULL,
        CONSTRAINT users_temp_password_coherent
          CHECK (must_change_password = (temp_password_expires_at IS NOT NULL)),
        CONSTRAINT users_tenant_id_id_key UNIQUE (tenant_id, id)
      )
    `);

    // FR-003: unique in all of MotorSync.
    await queryRunner.query('CREATE UNIQUE INDEX users_email_key ON users (email)');
    await queryRunner.query('CREATE INDEX users_tenant_id_idx ON users (tenant_id)');
    await queryRunner.query(
      "CREATE INDEX users_tenant_admins_idx ON users (tenant_id) WHERE role = 'admin' AND status = 'active'",
    );

    await queryRunner.query('ALTER TABLE users ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE users FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY users_tenant_isolation ON users
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())
    `);
    // Bounded exceptions for the owner of the SECURITY DEFINER functions (R1).
    await queryRunner.query(
      'CREATE POLICY users_auth_lookup ON users FOR SELECT TO motorsync_auth USING (true)',
    );
    await queryRunner.query(`
      CREATE POLICY users_auth_register ON users FOR INSERT TO motorsync_auth
        WITH CHECK (tenant_id = app_current_tenant())
    `);

    // No DELETE (FR-017).
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON users TO motorsync_app');
    await queryRunner.query(`
      GRANT SELECT (id, tenant_id, name, email, password_hash, role, status,
                    must_change_password, temp_password_expires_at) ON users TO motorsync_auth
    `);
    await queryRunner.query(`
      GRANT INSERT (id, tenant_id, name, email, password_hash, role, status,
                    must_change_password, created_by, updated_by, updated_by_name) ON users TO motorsync_auth
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops its indexes, policies and grants as well.
    await queryRunner.query('DROP TABLE users');
  }
}
