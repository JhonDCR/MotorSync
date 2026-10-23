import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Signatures of the SECURITY DEFINER functions, as used by ALTER, REVOKE, GRANT and DROP. */
const AUTH_FUNCTION_SIGNATURES = `auth_register_workshop(text, text, text, text, text),
                       auth_find_user_for_login(text), auth_find_refresh_token(text),
                       auth_login_locked_until(text), auth_record_login_failure(text),
                       auth_record_login_success(text), auth_clear_login_failures(uuid)`;

/**
 * DDL from specs/002-autenticacion/data-model.md, "Migración `1761000000800-CreateAuthFunctions`",
 * verbatim (research R1, R4). SECURITY DEFINER functions owned by motorsync_auth (NOLOGIN,
 * NOBYPASSRLS, NOINHERIT), with a fixed search_path, static SQL and qualified names.
 *
 * Maintenance: with INHERIT FALSE the migrator is not the owner after ALTER ... OWNER, so any
 * statement that changes the privileges of these functions, replaces them or drops them runs
 * between SET ROLE motorsync_auth and RESET ROLE (data-model, "Mantenimiento").
 */
export class CreateAuthFunctions1761000000800 implements MigrationInterface {
  name = 'CreateAuthFunctions1761000000800';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // US1: creates workshop + first admin atomically (FR-004). Pins app.tenant_id of the new
    // workshop in the caller's transaction (is_local = true), so the app creates the session under
    // RLS. Inserts the workshop first: with duplicated RUC and email tenants_ruc_key wins (US1-AC5).
    await queryRunner.query(`
      CREATE FUNCTION auth_register_workshop(p_workshop_name text, p_ruc text, p_user_name text,
                                             p_email text, p_password_hash text)
        RETURNS TABLE (tenant_id uuid, user_id uuid)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE
        v_tenant uuid := gen_random_uuid();
        v_user   uuid := gen_random_uuid();
      BEGIN
        PERFORM set_config('app.tenant_id', v_tenant::text, true);
        INSERT INTO public.tenants (id, name, ruc) VALUES (v_tenant, p_workshop_name, p_ruc);
        INSERT INTO public.users (id, tenant_id, name, email, password_hash, role, status,
                                  must_change_password, created_by, updated_by, updated_by_name)
             VALUES (v_user, v_tenant, p_user_name, p_email, p_password_hash, 'admin', 'active',
                     false, v_user, v_user, p_user_name);
        RETURN QUERY SELECT v_tenant, v_user;
      END $$
    `);

    // US2: the minimum to verify the password and decide. 0 rows if the email does not exist.
    await queryRunner.query(`
      CREATE FUNCTION auth_find_user_for_login(p_email text)
        RETURNS TABLE (user_id uuid, tenant_id uuid, name text, role text, status text,
                       password_hash text, must_change_password boolean,
                       temp_password_expires_at timestamptz)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
        SELECT u.id, u.tenant_id, u.name, u.role, u.status, u.password_hash,
               u.must_change_password, u.temp_password_expires_at
          FROM public.users u WHERE u.email = p_email
      $$
    `);

    // US3: resolves the workshop and the session of a refresh token. The app does the rest under RLS.
    await queryRunner.query(`
      CREATE FUNCTION auth_find_refresh_token(p_token_hash text)
        RETURNS TABLE (token_id uuid, tenant_id uuid, session_id uuid, rotated_at timestamptz)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
        SELECT t.id, t.tenant_id, t.session_id, t.rotated_at
          FROM public.refresh_tokens t WHERE t.token_hash = p_token_hash
      $$
    `);

    // FR-009: current lock for an email (whether it exists or not). NULL if not locked.
    await queryRunner.query(`
      CREATE FUNCTION auth_login_locked_until(p_email_hash text) RETURNS timestamptz
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
        SELECT a.locked_until FROM public.login_attempts a
         WHERE a.email_hash = p_email_hash AND a.locked_until > now()
      $$
    `);

    // FR-009: adds a failure atomically (the upsert serializes concurrent attempts, US2-AC9).
    // Returns locked_until if this failure (or an earlier one) locked the email.
    // Opportunistic pruning of locks expired more than 1 day ago (R4).
    await queryRunner.query(`
      CREATE FUNCTION auth_record_login_failure(p_email_hash text) RETURNS timestamptz
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
                               WHERE updated_at < now() - interval '1 day' LIMIT 100);
        RETURN v_locked;
      END $$
    `);

    // FR-009: success. false if there is a current lock right now (race with other failures).
    await queryRunner.query(`
      CREATE FUNCTION auth_record_login_success(p_email_hash text) RETURNS boolean
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v_locked timestamptz;
      BEGIN
        SELECT a.locked_until INTO v_locked FROM public.login_attempts a
         WHERE a.email_hash = p_email_hash FOR UPDATE;
        IF v_locked IS NOT NULL AND v_locked > now() THEN
          RETURN false;
        END IF;
        DELETE FROM public.login_attempts WHERE email_hash = p_email_hash;
        RETURN true;
      END $$
    `);

    // US4-AC21: the password reset clears the lock, only for accounts of the pinned workshop.
    await queryRunner.query(`
      CREATE FUNCTION auth_clear_login_failures(p_user_id uuid) RETURNS void
        LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
        DELETE FROM public.login_attempts a
         USING public.users u
         WHERE u.id = p_user_id AND u.tenant_id = public.app_current_tenant()
           AND a.email_hash = encode(sha256(convert_to(u.email, 'UTF8')), 'hex')
      $$
    `);

    // Owner and privileges (R1). CREATE on the schema only while the owner changes.
    await queryRunner.query('GRANT CREATE ON SCHEMA public TO motorsync_auth');
    await queryRunner.query(
      'ALTER FUNCTION auth_register_workshop(text, text, text, text, text) OWNER TO motorsync_auth',
    );
    await queryRunner.query('ALTER FUNCTION auth_find_user_for_login(text)    OWNER TO motorsync_auth');
    await queryRunner.query('ALTER FUNCTION auth_find_refresh_token(text)     OWNER TO motorsync_auth');
    await queryRunner.query('ALTER FUNCTION auth_login_locked_until(text)     OWNER TO motorsync_auth');
    await queryRunner.query('ALTER FUNCTION auth_record_login_failure(text)   OWNER TO motorsync_auth');
    await queryRunner.query('ALTER FUNCTION auth_record_login_success(text)   OWNER TO motorsync_auth');
    await queryRunner.query('ALTER FUNCTION auth_clear_login_failures(uuid)   OWNER TO motorsync_auth');
    await queryRunner.query('REVOKE CREATE ON SCHEMA public FROM motorsync_auth');

    await queryRunner.query('GRANT EXECUTE ON FUNCTION app_current_tenant() TO motorsync_auth');

    // Only the owner can change the privileges of the functions. With INHERIT FALSE, after
    // ALTER ... OWNER the migrator no longer is: a REVOKE/GRANT without SET ROLE only emits a
    // WARNING and PUBLIC keeps EXECUTE (defect detected by T001, 2026-10-23).
    await queryRunner.query('SET ROLE motorsync_auth');
    await queryRunner.query(`
      REVOKE ALL ON FUNCTION ${AUTH_FUNCTION_SIGNATURES}
        FROM PUBLIC
    `);
    await queryRunner.query(`
      GRANT EXECUTE ON FUNCTION ${AUTH_FUNCTION_SIGNATURES}
        TO motorsync_app
    `);
    await queryRunner.query('RESET ROLE');
    // Expected ACL: {motorsync_auth=X/motorsync_auth,motorsync_app=X/motorsync_auth}
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // data-model, "Mantenimiento": only the owner (motorsync_auth) can drop the functions.
    await queryRunner.query('GRANT CREATE ON SCHEMA public TO motorsync_auth');
    await queryRunner.query('SET ROLE motorsync_auth');
    await queryRunner.query(`DROP FUNCTION ${AUTH_FUNCTION_SIGNATURES}`);
    await queryRunner.query('RESET ROLE');
    await queryRunner.query('REVOKE CREATE ON SCHEMA public FROM motorsync_auth');
    await queryRunner.query('REVOKE EXECUTE ON FUNCTION app_current_tenant() FROM motorsync_auth');
  }
}
