import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DDL from specs/002-autenticacion/data-model.md, "Migración `1761000000600-CreateSessions`",
 * verbatim. The composite FKs keep a session and its tokens inside the tenant of the account.
 */
export class CreateSessions1761000000600 implements MigrationInterface {
  name = 'CreateSessions1761000000600';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE user_sessions (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        user_id           uuid NOT NULL,
        created_at        timestamptz NOT NULL DEFAULT now(),
        last_activity_at  timestamptz NOT NULL DEFAULT now(),
        revoked_at        timestamptz,
        revoke_reason     text CHECK (revoke_reason IN ('logout', 'deactivated', 'password_changed',
                                                        'password_reset', 'refresh_reuse',
                                                        'temp_password_expired')),
        ip                text,
        CONSTRAINT user_sessions_revoked_coherent CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
        CONSTRAINT user_sessions_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT user_sessions_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
      )
    `);

    await queryRunner.query('CREATE INDEX user_sessions_tenant_id_idx ON user_sessions (tenant_id)');
    await queryRunner.query(
      'CREATE INDEX user_sessions_open_by_user_idx ON user_sessions (tenant_id, user_id) WHERE revoked_at IS NULL',
    );

    await queryRunner.query('ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY user_sessions_tenant_isolation ON user_sessions
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())
    `);

    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON user_sessions TO motorsync_app');

    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        session_id  uuid NOT NULL,
        token_hash  text COLLATE "C" NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
        created_at  timestamptz NOT NULL DEFAULT now(),
        rotated_at  timestamptz,
        CONSTRAINT refresh_tokens_session_fk FOREIGN KEY (tenant_id, session_id)
          REFERENCES user_sessions (tenant_id, id)
      )
    `);

    await queryRunner.query(
      'CREATE UNIQUE INDEX refresh_tokens_token_hash_key ON refresh_tokens (token_hash)',
    );
    await queryRunner.query('CREATE INDEX refresh_tokens_tenant_id_idx ON refresh_tokens (tenant_id)');
    await queryRunner.query(
      'CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (tenant_id, session_id)',
    );

    await queryRunner.query('ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY refresh_tokens_tenant_isolation ON refresh_tokens
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())
    `);
    await queryRunner.query(
      'CREATE POLICY refresh_tokens_auth_lookup ON refresh_tokens FOR SELECT TO motorsync_auth USING (true)',
    );

    // DELETE only to prune rotated tokens older than 1 day of the same session (R5).
    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO motorsync_app',
    );
    await queryRunner.query(
      'GRANT SELECT (id, tenant_id, session_id, token_hash, rotated_at) ON refresh_tokens TO motorsync_auth',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops their indexes, policies and grants as well.
    await queryRunner.query('DROP TABLE refresh_tokens');
    await queryRunner.query('DROP TABLE user_sessions');
  }
}
