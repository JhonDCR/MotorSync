import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DDL from specs/003-soporte-plataforma/data-model.md, "Migración
 * `1761000001300-AllowSupportAuditActor`", verbatim (research R11).
 *
 * Allows 'platform_support' as an actor_role in audit_log.
 */
export class AllowSupportAuditActor1761000001300 implements MigrationInterface {
  name = 'AllowSupportAuditActor1761000001300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_role_check');
    await queryRunner.query(`
      ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_role_check
        CHECK (actor_role IN ('asesor', 'admin', 'platform_support'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_role_check');
    await queryRunner.query(`
      ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_role_check
        CHECK (actor_role IN ('asesor', 'admin'))
    `);
  }
}
