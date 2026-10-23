import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * auth_record_login_failure as created by 1761000000800, with the subquery of the opportunistic
 * prune given `pruneLocking` (empty in the original version).
 */
function recordLoginFailureSql(pruneLocking: string): string {
  return `
      CREATE OR REPLACE FUNCTION auth_record_login_failure(p_email_hash text) RETURNS timestamptz
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_locked timestamptz;
      BEGIN
        INSERT INTO public.login_attempts AS a (email_hash, failed_count, locked_until, updated_at)
             VALUES (p_email_hash, 1, NULL, now())
        ON CONFLICT (email_hash) DO UPDATE SET
          failed_count = CASE WHEN a.locked_until IS NOT NULL AND a.locked_until <= now() THEN 1
                              ELSE a.failed_count + 1 END,
          locked_until = CASE
            WHEN a.locked_until > now() THEN a.locked_until
            WHEN (CASE WHEN a.locked_until IS NOT NULL AND a.locked_until <= now() THEN 1
                       ELSE a.failed_count + 1 END) >= 5 THEN now() + interval '15 minutes'
            ELSE NULL END,
          updated_at = now()
        RETURNING a.locked_until INTO v_locked;

        -- Poda oportunista de bloqueos vencidos hace más de 1 día (R4).
        DELETE FROM public.login_attempts
         WHERE email_hash IN (SELECT email_hash FROM public.login_attempts
                               WHERE updated_at < now() - interval '1 day' LIMIT 100${pruneLocking});
        RETURN v_locked;
      END $$
    `;
}

/**
 * Adjustment 1 of the T031 review (specs/002-autenticacion, tasks.md "# PR2"; research R4): the
 * prune of auth_record_login_failure could deadlock (40P01) two concurrent failures on different
 * emails, each holding the row of its own email and waiting for the row of the other. With
 * `FOR UPDATE SKIP LOCKED` the prune skips the rows another transaction holds; they are pruned by a
 * later call.
 *
 * data-model, "Mantenimiento": with INHERIT FALSE only motorsync_auth (the owner) can replace the
 * function, so CREATE OR REPLACE runs between SET ROLE motorsync_auth and RESET ROLE, with CREATE
 * on the schema granted meanwhile. CREATE OR REPLACE keeps the owner and the ACL (EXECUTE only for
 * motorsync_app); SECURITY DEFINER and search_path are restated in the definition.
 */
export class FixLoginFailurePruneLocking1761000000850 implements MigrationInterface {
  name = 'FixLoginFailurePruneLocking1761000000850';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.replaceAsOwner(queryRunner, recordLoginFailureSql('\n                               FOR UPDATE SKIP LOCKED'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The version of 1761000000800.
    await this.replaceAsOwner(queryRunner, recordLoginFailureSql(''));
  }

  private async replaceAsOwner(queryRunner: QueryRunner, sql: string): Promise<void> {
    await queryRunner.query('GRANT CREATE ON SCHEMA public TO motorsync_auth');
    await queryRunner.query('SET ROLE motorsync_auth');
    await queryRunner.query(sql);
    await queryRunner.query('RESET ROLE');
    await queryRunner.query('REVOKE CREATE ON SCHEMA public FROM motorsync_auth');
  }
}
