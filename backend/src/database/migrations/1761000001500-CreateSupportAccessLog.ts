import type { MigrationInterface, QueryRunner } from 'typeorm';

const SUPPORT_ACCESS_LOG_FUNCTION_SIGNATURES = `support_list_workshops(uuid, text, text, integer, integer), support_list_workshop_accounts(uuid, uuid, text), support_list_access_log(uuid, uuid, uuid, integer, integer)`;

/**
 * DDL from specs/003-soporte-plataforma/data-model.md, "Migración
 * `1761000001500-CreateSupportAccessLog`", verbatim.
 *
 * Append-only support access log (FR-018) and the SECURITY DEFINER functions of US4:
 * workshop list, workshop accounts (logging the access) and access log reading.
 */
export class CreateSupportAccessLog1761000001500 implements MigrationInterface {
  name = 'CreateSupportAccessLog1761000001500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE support_access_log (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        support_account_id  uuid NOT NULL REFERENCES support_accounts(id),
        tenant_id           uuid NOT NULL REFERENCES tenants(id),
        action              text NOT NULL CHECK (action IN ('workshop.accounts_viewed')),
        occurred_at         timestamptz NOT NULL DEFAULT now(),
        ip                  text,
        channel             text NOT NULL DEFAULT 'support_panel'
      );
      CREATE INDEX support_access_log_tenant_idx ON support_access_log (tenant_id, occurred_at DESC);
      CREATE INDEX support_access_log_agent_idx ON support_access_log (support_account_id, occurred_at DESC);
      CREATE TRIGGER support_access_log_no_update_delete BEFORE UPDATE OR DELETE ON support_access_log
        FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
      ALTER TABLE support_access_log ENABLE ROW LEVEL SECURITY;
      CREATE POLICY support_access_log_support ON support_access_log TO motorsync_support
        USING (true) WITH CHECK (true);
      REVOKE ALL ON support_access_log FROM PUBLIC;
      GRANT SELECT, INSERT ON support_access_log TO motorsync_support;   -- append-only (FR-018)
    `);

    // US4-AC1, US4-AC2: workshops, 50 per page, by RUC prefix or part of the name (unaccented).
    // The API escapes % and _ of p_name_query before calling it (LIKE's implicit backslash ESCAPE).
    await queryRunner.query(`
      CREATE FUNCTION support_list_workshops(p_session_id uuid, p_name_query text, p_ruc_prefix text,
                                             p_limit integer, p_offset integer)
        RETURNS TABLE (tenant_id uuid, name text, ruc text, created_at timestamptz, total bigint)
        LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        PERFORM public.support_require_platform_context();
        PERFORM public.support_session_agent(p_session_id);
        RETURN QUERY
          SELECT t.id, t.name, t.ruc, t.created_at, count(*) OVER ()
            FROM public.tenants t
           WHERE (p_name_query IS NULL AND p_ruc_prefix IS NULL)
              OR (p_ruc_prefix IS NOT NULL AND t.ruc LIKE p_ruc_prefix || '%')
              OR (p_name_query IS NOT NULL AND public.immutable_unaccent(lower(t.name))
                    LIKE '%' || public.immutable_unaccent(lower(p_name_query)) || '%')
           ORDER BY t.name, t.id
           LIMIT LEAST(p_limit, 50) OFFSET p_offset;
      END $$;
    `);

    // US4-AC3, US4-AC6, US4-AC7: workshop accounts plus the access log entry, in a single call.
    await queryRunner.query(`
      CREATE FUNCTION support_list_workshop_accounts(p_session_id uuid, p_tenant_id uuid, p_ip text)
        RETURNS TABLE (user_id uuid, name text, email text, role text, status text, has_open_ticket boolean,
                       workshop_name text, workshop_ruc text, workshop_created_at timestamptz)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_agent uuid;
      BEGIN
        PERFORM public.support_require_platform_context();
        v_agent := public.support_session_agent(p_session_id);
        IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = p_tenant_id) THEN
          RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'workshop not found';
        END IF;
        INSERT INTO public.support_access_log (support_account_id, tenant_id, action, ip)
             VALUES (v_agent, p_tenant_id, 'workshop.accounts_viewed', p_ip);
        RETURN QUERY
          SELECT u.id, u.name, u.email, u.role, u.status,
                 CASE WHEN u.id IS NULL THEN NULL
                      ELSE EXISTS (SELECT 1 FROM public.support_tickets k WHERE k.user_id = u.id AND k.status = 'open')
                 END,
                 t.name, t.ruc, t.created_at
            FROM public.tenants t
            LEFT JOIN public.users u ON u.tenant_id = t.id
           WHERE t.id = p_tenant_id
           ORDER BY u.status, u.name, u.id;
      END $$;
    `);

    // US4-AC8, US4-AC9, FR-027: access log reading (read-only, STABLE).
    await queryRunner.query(`
      CREATE FUNCTION support_list_access_log(p_session_id uuid, p_tenant_id uuid, p_agent_id uuid,
                                              p_limit integer, p_offset integer)
        RETURNS TABLE (entry_id uuid, occurred_at timestamptz, agent_id uuid, agent_name text,
                       tenant_id uuid, workshop_name text, workshop_ruc text, ip text, channel text,
                       total bigint)
        LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        PERFORM public.support_require_platform_context();
        PERFORM public.support_session_agent(p_session_id);
        RETURN QUERY
          SELECT l.id, l.occurred_at, a.id, a.name, t.id, t.name, t.ruc, l.ip, l.channel, count(*) OVER ()
            FROM public.support_access_log l
            JOIN public.support_accounts a ON a.id = l.support_account_id
            JOIN public.tenants t ON t.id = l.tenant_id
           WHERE (p_tenant_id IS NULL OR l.tenant_id = p_tenant_id)
             AND (p_agent_id IS NULL OR l.support_account_id = p_agent_id)
           ORDER BY l.occurred_at DESC, l.id
           LIMIT LEAST(p_limit, 50) OFFSET p_offset;
      END $$;
    `);

    // Owner and privileges, identical to 1761000001200 (lesson of CLAUDE.md).
    await queryRunner.query(
      'GRANT CREATE ON SCHEMA public TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_list_workshops(uuid, text, text, integer, integer) OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_list_workshop_accounts(uuid, uuid, text) OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_list_access_log(uuid, uuid, uuid, integer, integer) OWNER TO motorsync_support',
    );
    await queryRunner.query('SET ROLE motorsync_support');
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION ${SUPPORT_ACCESS_LOG_FUNCTION_SIGNATURES} FROM PUBLIC`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION ${SUPPORT_ACCESS_LOG_FUNCTION_SIGNATURES} TO motorsync_app`,
    );
    await queryRunner.query('RESET ROLE');
    await queryRunner.query(
      'REVOKE CREATE ON SCHEMA public FROM motorsync_support',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'GRANT CREATE ON SCHEMA public TO motorsync_support',
    );
    await queryRunner.query('SET ROLE motorsync_support');
    await queryRunner.query(
      `DROP FUNCTION ${SUPPORT_ACCESS_LOG_FUNCTION_SIGNATURES}`,
    );
    await queryRunner.query('RESET ROLE');
    await queryRunner.query(
      'REVOKE CREATE ON SCHEMA public FROM motorsync_support',
    );
    await queryRunner.query('DROP TABLE support_access_log');
  }
}
