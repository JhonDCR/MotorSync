import type { MigrationInterface, QueryRunner } from 'typeorm';

const SUPPORT_PASSWORD_FUNCTION_SIGNATURES = `support_lock_open_ticket(uuid, uuid), support_resolve_ticket(uuid, uuid, text, text)`;

/**
 * DDL from specs/003-soporte-plataforma/data-model.md, "Migración
 * `1761000001400-CreateSupportPasswordFunctions`", verbatim (research R9).
 *
 * SECURITY DEFINER functions for support password reset:
 * - support_lock_open_ticket: locks the ticket row and returns ticket/tenant/user metadata.
 * - support_resolve_ticket: verifies verification note, resolves the ticket for the current tenant,
 *   and logs the event into support_ticket_events.
 */
export class CreateSupportPasswordFunctions1761000001400 implements MigrationInterface {
  name = 'CreateSupportPasswordFunctions1761000001400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // US3 (R9), step 1: locks the ticket and returns workshop and account. 0 rows if it does not exist.
    // Also returns status to distinguish 404 from 409 TICKET_NOT_OPEN.
    await queryRunner.query(`
      CREATE FUNCTION support_lock_open_ticket(p_session_id uuid, p_ticket_id uuid)
        RETURNS TABLE (tenant_id uuid, user_id uuid, number bigint, status text)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        PERFORM public.support_require_platform_context();
        PERFORM public.support_session_agent(p_session_id);
        RETURN QUERY
          SELECT k.tenant_id, k.user_id, k.number, k.status
            FROM public.support_tickets k WHERE k.id = p_ticket_id FOR UPDATE;
      END $$;
    `);

    // US3 (R9), step 8: closes the ticket as resolved with the verification note. Requires the
    // workshop of the ticket to be pinned (pinned by step 3) and the ticket still open (locked by step 1).
    // Returns resolved_at to build the response without re-reading the ticket with the pinned tenant.
    await queryRunner.query(`
      CREATE FUNCTION support_resolve_ticket(p_session_id uuid, p_ticket_id uuid, p_note text, p_ip text)
        RETURNS timestamptz
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE
        v_agent uuid;
        v_rows  integer;
      BEGIN
        v_agent := public.support_session_agent(p_session_id);
        IF p_note IS NULL OR length(btrim(p_note)) = 0 THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'verification note required';
        END IF;
        UPDATE public.support_tickets
           SET status = 'resolved', verification_note = btrim(p_note), resolved_by = v_agent, resolved_at = now()
         WHERE id = p_ticket_id AND status = 'open' AND tenant_id = public.app_current_tenant();
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 1 THEN
          RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'ticket not open for this tenant';
        END IF;
        INSERT INTO public.support_ticket_events (ticket_id, support_account_id, action, from_status, to_status, ip)
             VALUES (p_ticket_id, v_agent, 'temporary_password_generated', 'open', 'resolved', p_ip);
        RETURN now();
      END $$;
    `);

    // Owner and privileges, identical to 1761000001200 (lesson of CLAUDE.md).
    await queryRunner.query('GRANT CREATE ON SCHEMA public TO motorsync_support');
    await queryRunner.query(
      'ALTER FUNCTION support_lock_open_ticket(uuid, uuid) OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_resolve_ticket(uuid, uuid, text, text) OWNER TO motorsync_support',
    );
    await queryRunner.query('REVOKE CREATE ON SCHEMA public FROM motorsync_support');

    await queryRunner.query('SET ROLE motorsync_support');
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION ${SUPPORT_PASSWORD_FUNCTION_SIGNATURES}
        FROM PUBLIC
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION ${SUPPORT_PASSWORD_FUNCTION_SIGNATURES}
        TO motorsync_app
    `);
    await queryRunner.query('RESET ROLE');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('GRANT CREATE ON SCHEMA public TO motorsync_support');
    await queryRunner.query('SET ROLE motorsync_support');
    await queryRunner.query(`DROP FUNCTION ${SUPPORT_PASSWORD_FUNCTION_SIGNATURES}`);
    await queryRunner.query('RESET ROLE');
    await queryRunner.query('REVOKE CREATE ON SCHEMA public FROM motorsync_support');
  }
}
