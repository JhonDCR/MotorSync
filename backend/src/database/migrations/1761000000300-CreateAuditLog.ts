import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DDL from specs/001-clientes-vehiculos/data-model.md, "`audit_log` (Registro de auditoría)",
 * verbatim. The unnamed CHECKs keep the names PostgreSQL generates (audit_log_actor_role_check,
 * audit_log_reason_check). Append-only (principle IV): motorsync_app only has SELECT and INSERT,
 * and the trigger stops UPDATE and DELETE even for the owner.
 */
export class CreateAuditLog1761000000300 implements MigrationInterface {
  name = 'CreateAuditLog1761000000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE audit_log (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        actor_user_id  uuid NOT NULL,
        actor_name     text NOT NULL,
        actor_role     text NOT NULL CHECK (actor_role IN ('asesor', 'admin')),
        action         text NOT NULL,
        entity_type    text NOT NULL,
        entity_id      uuid NOT NULL,
        before         jsonb,
        after          jsonb,
        reason         text CHECK (reason IS NULL OR length(reason) BETWEEN 10 AND 500),
        occurred_at    timestamptz NOT NULL DEFAULT now(),
        ip             text,
        channel        text NOT NULL DEFAULT 'web',
        -- Refuerza FR-019 en la base: un asesor siempre deja motivo.
        CONSTRAINT audit_log_asesor_reason CHECK (actor_role <> 'asesor' OR reason IS NOT NULL)
      )
    `);

    await queryRunner.query('CREATE INDEX audit_log_tenant_id_idx ON audit_log (tenant_id)');
    await queryRunner.query(
      'CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id, occurred_at DESC)',
    );

    await queryRunner.query('ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE audit_log FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY audit_log_tenant_isolation ON audit_log
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())
    `);

    // Append-only (principle IV).
    await queryRunner.query('GRANT SELECT, INSERT ON audit_log TO motorsync_app');

    await queryRunner.query(`
      CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log is append-only';
      END $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER audit_log_no_update_delete
        BEFORE UPDATE OR DELETE ON audit_log
        FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops its indexes, policy and trigger as well.
    await queryRunner.query('DROP TABLE audit_log');
    await queryRunner.query('DROP FUNCTION audit_log_immutable()');
  }
}
