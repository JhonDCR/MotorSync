import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DDL from specs/003-soporte-plataforma/data-model.md, "Migración
 * `1761000001000-CreateSupportAccounts`", verbatim (research R2).
 *
 * Platform tables: support accounts do not belong to any workshop. RLS is ENABLE without FORCE,
 * like tenants, so motorsync_migrator (their owner) keeps using them in the operations procedure,
 * seed-dev and fixtures. With a workshop pinned, motorsync_app sees no rows and cannot write.
 */
export class CreateSupportAccounts1761000001000 implements MigrationInterface {
  name = 'CreateSupportAccounts1761000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // String.raw keeps the backslashes of the email regex ('^[^@\s]+@[^@\s]+$') intact.
    await queryRunner.query(String.raw`
      CREATE TABLE support_accounts (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name                      text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
        email                     text COLLATE "C" NOT NULL CHECK (
                                    email = lower(btrim(email))
                                    AND length(email) BETWEEN 3 AND 254
                                    AND email ~ '^[^@\s]+@[^@\s]+$'),
        password_hash             text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
        status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        must_change_password      boolean NOT NULL DEFAULT true,
        temp_password_expires_at  timestamptz,
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT support_accounts_temp_password_coherent
          CHECK (must_change_password = (temp_password_expires_at IS NOT NULL))
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX support_accounts_email_key ON support_accounts (email)');

    await queryRunner.query(`
      CREATE TABLE support_sessions (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        support_account_id  uuid NOT NULL REFERENCES support_accounts(id),
        created_at          timestamptz NOT NULL DEFAULT now(),
        last_activity_at    timestamptz NOT NULL DEFAULT now(),
        revoked_at          timestamptz,
        revoke_reason       text CHECK (revoke_reason IN ('logout', 'deactivated', 'password_changed',
                                                          'password_reset', 'refresh_reuse',
                                                          'temp_password_expired')),
        ip                  text,
        CONSTRAINT support_sessions_revoked_coherent CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX support_sessions_open_by_account_idx
        ON support_sessions (support_account_id) WHERE revoked_at IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE support_refresh_tokens (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id  uuid NOT NULL REFERENCES support_sessions(id),
        token_hash  text COLLATE "C" NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        created_at  timestamptz NOT NULL DEFAULT now(),
        rotated_at  timestamptz
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX support_refresh_tokens_token_hash_key ON support_refresh_tokens (token_hash)',
    );
    await queryRunner.query(
      'CREATE INDEX support_refresh_tokens_session_idx ON support_refresh_tokens (session_id)',
    );

    // R2: platform tables. Visible to the app only WITHOUT a pinned workshop: a workshop route
    // (which always pins app.tenant_id) sees them empty and cannot write. No FORCE, like tenants:
    // the migrator (owner) uses them in the operations procedure, seed-dev and fixtures.
    await queryRunner.query('ALTER TABLE support_accounts ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE support_refresh_tokens ENABLE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY support_accounts_platform_only ON support_accounts TO motorsync_app
        USING (app_current_tenant() IS NULL) WITH CHECK (app_current_tenant() IS NULL)
    `);
    await queryRunner.query(`
      CREATE POLICY support_sessions_platform_only ON support_sessions TO motorsync_app
        USING (app_current_tenant() IS NULL) WITH CHECK (app_current_tenant() IS NULL)
    `);
    await queryRunner.query(`
      CREATE POLICY support_refresh_tokens_platform_only ON support_refresh_tokens TO motorsync_app
        USING (app_current_tenant() IS NULL) WITH CHECK (app_current_tenant() IS NULL)
    `);
    // For the motorsync_support functions (session gate, FR-024 triggers).
    await queryRunner.query(
      'CREATE POLICY support_accounts_support_read ON support_accounts FOR SELECT TO motorsync_support USING (true)',
    );
    await queryRunner.query(
      'CREATE POLICY support_sessions_support_read ON support_sessions FOR SELECT TO motorsync_support USING (true)',
    );

    // FR-007, US2-AC2: the app does not create, rename, reactivate or deactivate support accounts.
    await queryRunner.query('GRANT SELECT ON support_accounts TO motorsync_app');
    await queryRunner.query(`
      GRANT UPDATE (password_hash, must_change_password, temp_password_expires_at, updated_at)
        ON support_accounts TO motorsync_app
    `);
    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON support_sessions TO motorsync_app');
    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON support_refresh_tokens TO motorsync_app',
    );

    // motorsync_support: just what the session gate, the ticket agent names and the FR-024
    // triggers need. Never password_hash.
    await queryRunner.query(
      'GRANT SELECT (id, name, email, status, must_change_password) ON support_accounts TO motorsync_support',
    );
    await queryRunner.query(
      'GRANT SELECT (id, support_account_id, last_activity_at, revoked_at) ON support_sessions TO motorsync_support',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops their indexes, policies and grants as well.
    await queryRunner.query('DROP TABLE support_refresh_tokens');
    await queryRunner.query('DROP TABLE support_sessions');
    await queryRunner.query('DROP TABLE support_accounts');
  }
}
