-- MotorSync database bootstrap (research R2). Run as the container superuser through
-- `npm run db:bootstrap` (scripts/db-bootstrap.ts, DATABASE_ADMIN_URL). Idempotent.
-- Passwords are parameters: the script sets the session settings
-- motorsync.migrator_password and motorsync.app_password before running this file.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motorsync_migrator') THEN
    CREATE ROLE motorsync_migrator;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motorsync_app') THEN
    CREATE ROLE motorsync_app;
  END IF;

  -- Attributes are (re)applied on every run so an existing role converges to them.
  EXECUTE format(
    'ALTER ROLE motorsync_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE PASSWORD %L',
    current_setting('motorsync.migrator_password')
  );
  EXECUTE format(
    'ALTER ROLE motorsync_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT PASSWORD %L',
    current_setting('motorsync.app_password')
  );

  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO motorsync_migrator, motorsync_app',
    current_database()
  );
END
$$;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gin;

ALTER SCHEMA public OWNER TO motorsync_migrator;
GRANT USAGE ON SCHEMA public TO motorsync_app;

-- Feature 002 (specs/002-autenticacion/data-model.md, "Bootstrap"; research R1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motorsync_auth') THEN
    CREATE ROLE motorsync_auth;
  END IF;
  -- Dueño de las funciones SECURITY DEFINER (R1). Sin login y sin BYPASSRLS.
  ALTER ROLE motorsync_auth NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT;
END
$$;

GRANT USAGE ON SCHEMA public TO motorsync_auth;
-- El migrator debe poder hacer ALTER FUNCTION ... OWNER TO motorsync_auth (PG16: SET),
-- sin heredar sus privilegios.
GRANT motorsync_auth TO motorsync_migrator WITH INHERIT FALSE, SET TRUE;

-- Feature 003 (specs/003-soporte-plataforma/data-model.md, "Bootstrap"; research R1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motorsync_support') THEN
    CREATE ROLE motorsync_support;
  END IF;
  -- Dueño de las funciones SECURITY DEFINER del panel (R1). Sin login y sin BYPASSRLS.
  ALTER ROLE motorsync_support NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT;
END
$$;

GRANT USAGE ON SCHEMA public TO motorsync_support;
GRANT motorsync_support TO motorsync_migrator WITH INHERIT FALSE, SET TRUE;
