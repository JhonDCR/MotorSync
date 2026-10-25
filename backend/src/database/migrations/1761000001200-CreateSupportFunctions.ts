import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Signatures of the SECURITY DEFINER functions, as used by ALTER, REVOKE, GRANT and DROP. */
const SUPPORT_FUNCTION_SIGNATURES = `support_session_agent(uuid), support_require_platform_context(),
                       support_request_help(text, text), support_list_open_tickets(uuid),
                       support_get_ticket(uuid, uuid), support_discard_ticket(uuid, uuid, text, text),
                       support_workshop_email_exists(text), users_email_not_support(),
                       support_accounts_email_not_workshop()`;

/**
 * DDL from specs/003-soporte-plataforma/data-model.md, "Migración
 * `1761000001200-CreateSupportFunctions`", verbatim (research R1, R5, R7, R8).
 *
 * SECURITY DEFINER functions owned by motorsync_support (NOLOGIN, NOBYPASSRLS, NOINHERIT), with a
 * fixed search_path, static SQL and qualified names. The panel functions start with the session
 * gate (support_session_agent) and the read ones also require app_current_tenant() IS NULL.
 *
 * Maintenance: with INHERIT FALSE the migrator is not the owner after ALTER ... OWNER, so any
 * statement that changes the privileges of these functions, replaces them or drops them runs
 * between SET ROLE motorsync_support and RESET ROLE (data-model, "Mantenimiento").
 */
export class CreateSupportFunctions1761000001200 implements MigrationInterface {
  name = 'CreateSupportFunctions1761000001200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // R1: session gate. Internal: no EXECUTE for the app. ERRCODE 28000 -> 401 SESSION_REVOKED.
    await queryRunner.query(`
      CREATE FUNCTION support_session_agent(p_session_id uuid) RETURNS uuid
        LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_agent uuid;
      BEGIN
        SELECT s.support_account_id INTO v_agent
          FROM public.support_sessions s
          JOIN public.support_accounts a ON a.id = s.support_account_id
         WHERE s.id = p_session_id AND s.revoked_at IS NULL
           AND s.last_activity_at > now() - interval '30 minutes'
           AND a.status = 'active' AND a.must_change_password = false;
        IF v_agent IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'support session required';
        END IF;
        RETURN v_agent;
      END $$
    `);

    // The panel reads do not run with a pinned workshop (R1, context gate).
    await queryRunner.query(`
      CREATE FUNCTION support_require_platform_context() RETURNS void
        LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        IF public.app_current_tenant() IS NOT NULL THEN
          RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'support functions run without a tenant';
        END IF;
      END $$
    `);

    // US1 (R7, R8): per-origin limit + ticket. Public. Returns 'accepted' or 'rate_limited'.
    // Does not touch users, sessions, login_attempts or audit_log (FR-005). Unknown email: not stored.
    await queryRunner.query(`
      CREATE FUNCTION support_request_help(p_email text, p_origin_hash text) RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE
        v_count  integer;
        v_user   uuid;
        v_tenant uuid;
      BEGIN
        INSERT INTO public.help_request_throttle AS t (origin_hash, window_started_at, request_count, updated_at)
             VALUES (p_origin_hash, now(), 1, now())
        ON CONFLICT (origin_hash) DO UPDATE SET
          window_started_at = CASE WHEN t.window_started_at <= now() - interval '1 hour'
                                   THEN now() ELSE t.window_started_at END,
          request_count     = CASE WHEN t.window_started_at <= now() - interval '1 hour'
                                   THEN 1 ELSE LEAST(t.request_count + 1, 21) END,
          updated_at        = now()
        RETURNING t.request_count INTO v_count;

        DELETE FROM public.help_request_throttle
         WHERE origin_hash IN (SELECT origin_hash FROM public.help_request_throttle
                                WHERE updated_at < now() - interval '1 day'
                                LIMIT 100 FOR UPDATE SKIP LOCKED);

        IF v_count > 20 THEN
          RETURN 'rate_limited';
        END IF;

        SELECT u.id, u.tenant_id INTO v_user, v_tenant FROM public.users u WHERE u.email = p_email;
        IF v_user IS NOT NULL THEN
          INSERT INTO public.support_tickets AS k (tenant_id, user_id, email)
               VALUES (v_tenant, v_user, p_email)
          ON CONFLICT (user_id) WHERE status = 'open' DO UPDATE SET
            last_requested_at = now(),
            request_count     = k.request_count + 1;
        END IF;
        RETURN 'accepted';
      END $$
    `);

    // US2-AC7: inbox. Only the FR-013 fields, oldest first.
    await queryRunner.query(`
      CREATE FUNCTION support_list_open_tickets(p_session_id uuid)
        RETURNS TABLE (ticket_id uuid, number bigint, created_at timestamptz, last_requested_at timestamptz,
                       request_count integer, email text, account_name text, account_role text,
                       account_status text, workshop_name text, workshop_ruc text)
        LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        PERFORM public.support_require_platform_context();
        PERFORM public.support_session_agent(p_session_id);
        RETURN QUERY
          SELECT k.id, k.number, k.created_at, k.last_requested_at, k.request_count, u.email,
                 u.name, u.role, u.status, t.name, t.ruc
            FROM public.support_tickets k
            JOIN public.users u ON u.id = k.user_id AND u.tenant_id = k.tenant_id
            JOIN public.tenants t ON t.id = k.tenant_id
           WHERE k.status = 'open'
           ORDER BY k.created_at, k.number;
      END $$
    `);

    // US2, US3: one ticket (open or closed) with its closing data. 0 rows if it does not exist.
    await queryRunner.query(`
      CREATE FUNCTION support_get_ticket(p_session_id uuid, p_ticket_id uuid)
        RETURNS TABLE (ticket_id uuid, number bigint, status text, created_at timestamptz,
                       last_requested_at timestamptz, request_count integer, email text,
                       account_name text, account_role text, account_status text,
                       workshop_name text, workshop_ruc text,
                       verification_note text, resolved_by_name text, resolved_at timestamptz,
                       discard_reason text, discarded_by_name text, discarded_at timestamptz)
        LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        PERFORM public.support_require_platform_context();
        PERFORM public.support_session_agent(p_session_id);
        RETURN QUERY
          SELECT k.id, k.number, k.status, k.created_at, k.last_requested_at, k.request_count, u.email,
                 u.name, u.role, u.status, t.name, t.ruc,
                 k.verification_note, ra.name, k.resolved_at, k.discard_reason, da.name, k.discarded_at
            FROM public.support_tickets k
            JOIN public.users u ON u.id = k.user_id AND u.tenant_id = k.tenant_id
            JOIN public.tenants t ON t.id = k.tenant_id
            LEFT JOIN public.support_accounts ra ON ra.id = k.resolved_by
            LEFT JOIN public.support_accounts da ON da.id = k.discarded_by
           WHERE k.id = p_ticket_id;
      END $$
    `);

    // US2-AC12, US2-AC13, US3-AC12: discard. 'discarded' | 'not_open' | 'not_found'.
    await queryRunner.query(`
      CREATE FUNCTION support_discard_ticket(p_session_id uuid, p_ticket_id uuid, p_reason text, p_ip text)
        RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE
        v_agent  uuid;
        v_status text;
      BEGIN
        PERFORM public.support_require_platform_context();
        v_agent := public.support_session_agent(p_session_id);
        IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'discard reason required';
        END IF;
        SELECT k.status INTO v_status FROM public.support_tickets k WHERE k.id = p_ticket_id FOR UPDATE;
        IF v_status IS NULL THEN RETURN 'not_found'; END IF;
        IF v_status <> 'open' THEN RETURN 'not_open'; END IF;
        UPDATE public.support_tickets
           SET status = 'discarded', discard_reason = btrim(p_reason), discarded_by = v_agent, discarded_at = now()
         WHERE id = p_ticket_id;
        INSERT INTO public.support_ticket_events (ticket_id, support_account_id, action, from_status, to_status, ip)
             VALUES (p_ticket_id, v_agent, 'discarded', 'open', 'discarded', p_ip);
        RETURN 'discarded';
      END $$
    `);

    // FR-024 (R5): only for the operations procedure (EXECUTE for the migrator, not for the app).
    await queryRunner.query(`
      CREATE FUNCTION support_workshop_email_exists(p_email text) RETURNS boolean
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
        SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.email = p_email)
      $$
    `);

    // FR-024 in both directions (R5). On users, the error uses users_email_key: feature 002
    // translates it to REGISTRATION_FAILED or EMAIL_UNAVAILABLE (generic), without revealing
    // that it is a support account.
    await queryRunner.query(`
      CREATE FUNCTION users_email_not_support() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.support_accounts a WHERE a.email = NEW.email) THEN
          RAISE EXCEPTION USING ERRCODE = '23505', CONSTRAINT = 'users_email_key',
                                MESSAGE = 'email unavailable';
        END IF;
        RETURN NEW;
      END $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER users_email_not_support BEFORE INSERT OR UPDATE OF email ON users
        FOR EACH ROW EXECUTE FUNCTION users_email_not_support()
    `);

    await queryRunner.query(`
      CREATE FUNCTION support_accounts_email_not_workshop() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.users u WHERE u.email = NEW.email) THEN
          RAISE EXCEPTION USING ERRCODE = '23505', CONSTRAINT = 'support_accounts_email_workshop',
                                MESSAGE = 'email belongs to a workshop account';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TRIGGER support_accounts_email_not_workshop BEFORE INSERT OR UPDATE OF email ON support_accounts
        FOR EACH ROW EXECUTE FUNCTION support_accounts_email_not_workshop()
    `);

    // Owner and privileges, as in feature 002 (data-model 002, "Mantenimiento"). CREATE on the
    // schema only while the owner changes.
    await queryRunner.query('GRANT CREATE ON SCHEMA public TO motorsync_support');
    await queryRunner.query(
      'ALTER FUNCTION support_session_agent(uuid)                       OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_require_platform_context()                OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_request_help(text, text)                  OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_list_open_tickets(uuid)                   OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_get_ticket(uuid, uuid)                    OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_discard_ticket(uuid, uuid, text, text)    OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_workshop_email_exists(text)               OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION users_email_not_support()                         OWNER TO motorsync_support',
    );
    await queryRunner.query(
      'ALTER FUNCTION support_accounts_email_not_workshop()             OWNER TO motorsync_support',
    );
    await queryRunner.query('REVOKE CREATE ON SCHEMA public FROM motorsync_support');

    // Only the owner can change the privileges of the functions. With INHERIT FALSE, after
    // ALTER ... OWNER the migrator no longer is: a REVOKE/GRANT without SET ROLE only emits a
    // WARNING and PUBLIC keeps EXECUTE (lesson of CLAUDE.md, feature 002).
    await queryRunner.query('SET ROLE motorsync_support');
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION ${SUPPORT_FUNCTION_SIGNATURES}
        FROM PUBLIC
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION support_request_help(text, text), support_list_open_tickets(uuid),
                              support_get_ticket(uuid, uuid), support_discard_ticket(uuid, uuid, text, text)
        TO motorsync_app
    `);
    await queryRunner.query(
      'GRANT EXECUTE ON FUNCTION support_workshop_email_exists(text) TO motorsync_migrator',
    );
    await queryRunner.query('RESET ROLE');
    // support_session_agent and support_require_platform_context: only other functions of the same
    // owner call them. The triggers do not need EXECUTE from the inserting role.
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DROP TRIGGER requires ownership of the table (motorsync_migrator), so the triggers are
    // dropped before SET ROLE; the functions are owned by motorsync_support and are dropped as
    // their owner (data-model, "Mantenimiento").
    await queryRunner.query('DROP TRIGGER IF EXISTS users_email_not_support ON users');
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS support_accounts_email_not_workshop ON support_accounts',
    );
    await queryRunner.query('GRANT CREATE ON SCHEMA public TO motorsync_support');
    await queryRunner.query('SET ROLE motorsync_support');
    await queryRunner.query(`DROP FUNCTION ${SUPPORT_FUNCTION_SIGNATURES}`);
    await queryRunner.query('RESET ROLE');
    await queryRunner.query('REVOKE CREATE ON SCHEMA public FROM motorsync_support');
  }
}
