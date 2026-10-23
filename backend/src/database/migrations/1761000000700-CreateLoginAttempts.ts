import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DDL from specs/002-autenticacion/data-model.md, "Migración `1761000000700-CreateLoginAttempts`",
 * verbatim. Global technical table (research R4): no tenant data and no plain-text emails.
 * motorsync_app has no privilege on it: it only reaches it through the auth_* functions.
 */
export class CreateLoginAttempts1761000000700 implements MigrationInterface {
  name = 'CreateLoginAttempts1761000000700';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE login_attempts (
        email_hash    text COLLATE "C" PRIMARY KEY CHECK (email_hash ~ '^[0-9a-f]{64}$'),
        failed_count  integer NOT NULL CHECK (failed_count >= 0),
        locked_until  timestamptz,
        updated_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('REVOKE ALL ON login_attempts FROM PUBLIC');
    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempts TO motorsync_auth',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE login_attempts');
  }
}
