# Data Model: Soporte de la plataforma y recuperación de acceso

**Feature**: `specs/003-soporte-plataforma/spec.md` | **Decisiones**: [research.md](./research.md) R1–R12

Las migraciones nuevas van en `backend/src/database/migrations/`, después de `1761000000900-AddLastAdminTrigger`. Las aplica `motorsync_migrator`. Como en la 002, el SQL de este documento es la fuente para los implementers. Todas las fechas son `timestamptz` (UTC).

## Resumen de entidades

| Entidad (spec) | Tabla | `tenant_id` | RLS | Acceso de `motorsync_app` | PR |
|---|---|---|---|---|---|
| Cuenta de soporte | `support_accounts` | **no** (plataforma) | `ENABLE`, política `app_current_tenant() IS NULL` | `SELECT`; `UPDATE` solo de columnas de contraseña | PR1 |
| Sesión de soporte | `support_sessions` | **no** | igual | `SELECT, INSERT, UPDATE` | PR1 |
| (técnica) Refresh de soporte | `support_refresh_tokens` | **no** | igual | `SELECT, INSERT, UPDATE, DELETE` | PR1 |
| Ticket de soporte | `support_tickets` | sí (taller afectado) | `ENABLE`, solo `TO motorsync_support` | **ninguno** (solo funciones) | PR1 |
| Historial del ticket | `support_ticket_events` | no (va por el ticket) | `ENABLE`, solo `TO motorsync_support` | **ninguno** | PR1 |
| Contador de solicitudes | `help_request_throttle` | **no** | sin RLS | **ninguno** | PR1 |
| Bitácora de soporte | `support_access_log` | sí (taller consultado) | `ENABLE`, solo `TO motorsync_support` | **ninguno** | PR3 |
| Registro de auditoría del taller | `audit_log` (existe) | sí | sin cambios | sin cambios | PR2 (CHECK de `actor_role`) |
| Taller, cuenta de taller | `tenants`, `users` (existen) | — | + políticas `SELECT TO motorsync_support` | sin cambios | PR1 |

## Valores enumerados

| Campo | Valores |
|---|---|
| `support_accounts.status` | `active`, `inactive` |
| `support_sessions.revoke_reason` | `logout`, `deactivated`, `password_changed`, `password_reset`, `refresh_reuse`, `temp_password_expired` |
| `support_tickets.status` | `open`, `resolved`, `discarded` |
| `support_ticket_events.action` | `discarded`, `temporary_password_generated` |
| `support_access_log.action` | `workshop.accounts_viewed` |
| `audit_log.actor_role` (nuevo valor) | `platform_support` |
| `audit_log.action` (nueva) | `user.password_reset_by_support` |
| `audit_log.channel` (nuevo valor) | `support_panel` |

## Reglas de validación (fuente: spec)

| Campo | Regla | Dónde |
|---|---|---|
| Correo ("¿Olvidaste tu contraseña?", login de soporte, operaciones) | `normalizeEmail()` de la 002: recorta y pasa a minúsculas; formato estándar; hasta 254 caracteres | DTO / pipe + CHECK en `support_accounts` |
| Nombre de la cuenta de soporte | 2–120 caracteres tras recortar | script + CHECK |
| Contraseña de soporte | 8–128 caracteres Unicode, sin recorte (FR-005 de la 002) | DTO (`IsPassword`) |
| Nota de verificación (FR-023) | obligatoria; 1–1000 caracteres tras recortar; vacía o solo espacios → `REQUIRED` | DTO + función + CHECK |
| Motivo de descarte (US2-AC12) | obligatorio; 1–500 caracteres tras recortar | DTO + función + CHECK |
| Búsqueda de talleres (US4-AC2) | 1–120 caracteres; si al normalizar como documento (`normalizeDocument`) quedan solo dígitos, busca también por prefijo de RUC | DTO + función |
| Página de talleres (US4-AC1) | `page` entero ≥ 1; tamaño fijo 50 | DTO |
| Temporal generada (FR-019) | `^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$`: 16 caracteres sin 0/O ni 1/I/L, en 4 bloques con guiones que **forman parte** de la contraseña (19 caracteres, dentro de 8–128 de FR-005 de la 002); research R9 | servidor (no hay DTO: no la envía nadie) |
| Filtros de la bitácora (US4-AC8) | `workshopId` y `agentId` opcionales, uuid; `page` entero ≥ 1; tamaño fijo 50 | DTO |

## DDL

### Bootstrap (`backend/db/bootstrap.sql`, superusuario, idempotente)

Se agrega al archivo existente, después del bloque de `motorsync_auth`:

```sql
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
```

### Migración `1761000001000-CreateSupportAccounts` (PR1)

```sql
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
);
CREATE UNIQUE INDEX support_accounts_email_key ON support_accounts (email);

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
);
CREATE INDEX support_sessions_open_by_account_idx
  ON support_sessions (support_account_id) WHERE revoked_at IS NULL;

CREATE TABLE support_refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES support_sessions(id),
  token_hash  text COLLATE "C" NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz
);
CREATE UNIQUE INDEX support_refresh_tokens_token_hash_key ON support_refresh_tokens (token_hash);
CREATE INDEX support_refresh_tokens_session_idx ON support_refresh_tokens (session_id);

-- R2: tablas de plataforma. Visibles para la app solo SIN taller fijado: una ruta de un taller
-- (que siempre fija app.tenant_id) las ve vacías y no puede escribirlas. Sin FORCE, como tenants:
-- el migrator (dueño) las usa en el procedimiento de operaciones, seed-dev y fixtures.
ALTER TABLE support_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_refresh_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_accounts_platform_only ON support_accounts TO motorsync_app
  USING (app_current_tenant() IS NULL) WITH CHECK (app_current_tenant() IS NULL);
CREATE POLICY support_sessions_platform_only ON support_sessions TO motorsync_app
  USING (app_current_tenant() IS NULL) WITH CHECK (app_current_tenant() IS NULL);
CREATE POLICY support_refresh_tokens_platform_only ON support_refresh_tokens TO motorsync_app
  USING (app_current_tenant() IS NULL) WITH CHECK (app_current_tenant() IS NULL);
-- Para las funciones de motorsync_support (compuerta de sesión, triggers de FR-024).
CREATE POLICY support_accounts_support_read ON support_accounts FOR SELECT TO motorsync_support USING (true);
CREATE POLICY support_sessions_support_read ON support_sessions FOR SELECT TO motorsync_support USING (true);

-- FR-007, US2-AC2: la app no crea, renombra, reactiva ni desactiva cuentas de soporte.
GRANT SELECT ON support_accounts TO motorsync_app;
GRANT UPDATE (password_hash, must_change_password, temp_password_expires_at, updated_at)
  ON support_accounts TO motorsync_app;
GRANT SELECT, INSERT, UPDATE ON support_sessions TO motorsync_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON support_refresh_tokens TO motorsync_app;

-- motorsync_support: lo justo para la compuerta de sesión, los nombres de agente de los tickets
-- y los triggers de FR-024. Nunca password_hash.
GRANT SELECT (id, name, email, status, must_change_password) ON support_accounts TO motorsync_support;
GRANT SELECT (id, support_account_id, last_activity_at, revoked_at) ON support_sessions TO motorsync_support;
```

### Migración `1761000001100-CreateSupportTickets` (PR1)

```sql
CREATE TABLE support_tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  user_id             uuid NOT NULL,
  email               text COLLATE "C" NOT NULL CHECK (email = lower(btrim(email))),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'discarded')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_requested_at   timestamptz NOT NULL DEFAULT now(),
  request_count       integer NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  verification_note   text CHECK (verification_note IS NULL
                                  OR length(btrim(verification_note)) BETWEEN 1 AND 1000),
  resolved_by         uuid REFERENCES support_accounts(id),
  resolved_at         timestamptz,
  discard_reason      text CHECK (discard_reason IS NULL
                                  OR length(btrim(discard_reason)) BETWEEN 1 AND 500),
  discarded_by        uuid REFERENCES support_accounts(id),
  discarded_at        timestamptz,
  CONSTRAINT support_tickets_number_key UNIQUE (number),
  -- El ticket no puede apuntar a una cuenta de otro taller que el suyo.
  CONSTRAINT support_tickets_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  -- FR-014: cada estado con exactamente sus datos de cierre.
  CONSTRAINT support_tickets_state_coherent CHECK (
    (status = 'open'      AND verification_note IS NULL AND resolved_by IS NULL AND resolved_at IS NULL
                          AND discard_reason IS NULL AND discarded_by IS NULL AND discarded_at IS NULL)
 OR (status = 'resolved'  AND verification_note IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
                          AND discard_reason IS NULL AND discarded_by IS NULL AND discarded_at IS NULL)
 OR (status = 'discarded' AND verification_note IS NULL AND resolved_by IS NULL AND resolved_at IS NULL
                          AND discard_reason IS NOT NULL AND discarded_by IS NOT NULL AND discarded_at IS NOT NULL))
);
-- FR-002, SC-008: como máximo un ticket abierto por cuenta, también ante solicitudes simultáneas.
CREATE UNIQUE INDEX support_tickets_one_open_per_user ON support_tickets (user_id) WHERE status = 'open';
CREATE INDEX support_tickets_open_inbox_idx ON support_tickets (created_at) WHERE status = 'open';
CREATE INDEX support_tickets_tenant_id_idx ON support_tickets (tenant_id);

CREATE TABLE support_ticket_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id           uuid NOT NULL REFERENCES support_tickets(id),
  support_account_id  uuid NOT NULL REFERENCES support_accounts(id),
  action              text NOT NULL CHECK (action IN ('discarded', 'temporary_password_generated')),
  from_status         text NOT NULL CHECK (from_status = 'open'),
  to_status           text NOT NULL CHECK (to_status IN ('resolved', 'discarded')),
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  ip                  text
);
CREATE INDEX support_ticket_events_ticket_idx ON support_ticket_events (ticket_id, occurred_at);

-- R8: tabla técnica global; solo el hash de la IP, nunca correos.
CREATE TABLE help_request_throttle (
  origin_hash        text COLLATE "C" PRIMARY KEY CHECK (origin_hash ~ '^[0-9a-f]{64}$'),
  window_started_at  timestamptz NOT NULL DEFAULT now(),
  request_count      integer NOT NULL CHECK (request_count BETWEEN 1 AND 21),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- FR-014, FR-015, SC-010: un ticket cerrado no cambia; ningún ticket se borra.
CREATE FUNCTION support_tickets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'support_tickets rows are never deleted';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'closed support tickets are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_tickets_guard BEFORE UPDATE OR DELETE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION support_tickets_guard();

-- US2-AC8: historial append-only (reutiliza la función de la 001).
CREATE TRIGGER support_ticket_events_no_update_delete BEFORE UPDATE OR DELETE ON support_ticket_events
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- R6: solo las funciones de motorsync_support llegan a estas tablas.
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_tickets_support ON support_tickets TO motorsync_support USING (true) WITH CHECK (true);
CREATE POLICY support_ticket_events_support ON support_ticket_events TO motorsync_support
  USING (true) WITH CHECK (true);
REVOKE ALL ON support_tickets, support_ticket_events, help_request_throttle FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON support_tickets TO motorsync_support;
GRANT SELECT, INSERT ON support_ticket_events TO motorsync_support;
GRANT SELECT, INSERT, UPDATE, DELETE ON help_request_throttle TO motorsync_support;
-- motorsync_app no tiene ningún privilegio sobre las tres.

-- R1: lectura acotada de talleres y cuentas para las funciones del panel.
CREATE POLICY tenants_support_lookup ON tenants FOR SELECT TO motorsync_support USING (true);
CREATE POLICY users_support_lookup ON users FOR SELECT TO motorsync_support USING (true);
GRANT SELECT (id, name, ruc, created_at) ON tenants TO motorsync_support;
GRANT SELECT (id, tenant_id, name, email, role, status) ON users TO motorsync_support;
GRANT EXECUTE ON FUNCTION app_current_tenant(), immutable_unaccent(text) TO motorsync_support;
```

`support_tickets (tenant_id, user_id)` referencia `users (tenant_id, id)` (la clave única `users_tenant_id_id_key` de la 002). Las comprobaciones de integridad referencial de PostgreSQL no pasan por RLS, así que la FK funciona aunque la función que inserta el ticket no tenga taller fijado.

### Migración `1761000001200-CreateSupportFunctions` (PR1)

#### Funciones `SECURITY DEFINER` de `motorsync_support`

Reglas comunes (las mismas de la 002):
- `SECURITY DEFINER`, dueño `motorsync_support`, `SET search_path = pg_catalog, public, pg_temp`, SQL estático y nombres calificados con `public.`.
- `REVOKE ALL … FROM PUBLIC`; `GRANT EXECUTE … TO motorsync_app` salvo donde se indica.
- Las del panel (todas menos `support_request_help` y `support_workshop_email_exists`) empiezan por `public.support_session_agent(p_session_id)`, y las de lectura exigen además `app_current_tenant() IS NULL` (R1).

```sql
-- R1: compuerta de sesión. Interna: sin EXECUTE para la app. ERRCODE 28000 → 401 SESSION_REVOKED.
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
END $$;

-- Las lecturas del panel no corren con un taller fijado (R1, compuerta de contexto).
CREATE FUNCTION support_require_platform_context() RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.app_current_tenant() IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'support functions run without a tenant';
  END IF;
END $$;

-- US1 (R7, R8): límite por origen + ticket. Pública. Devuelve 'accepted' o 'rate_limited'.
-- No toca users, sesiones, login_attempts ni audit_log (FR-005). Correo inexistente: no se guarda.
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
END $$;

-- US2-AC7: bandeja. Solo los campos de FR-013, del más antiguo al más reciente.
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
END $$;

-- US2, US3: un ticket (abierto o cerrado) con sus datos de cierre. 0 filas si no existe.
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
END $$;

-- US2-AC12, US2-AC13, US3-AC12: descartar. 'discarded' | 'not_open' | 'not_found'.
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
END $$;

-- FR-024 (R5): solo para el procedimiento de operaciones (EXECUTE para el migrator, no para la app).
CREATE FUNCTION support_workshop_email_exists(p_email text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.email = p_email)
$$;

-- FR-024 en ambos sentidos (R5). En users, el error usa users_email_key: la 002 lo traduce a
-- REGISTRATION_FAILED o EMAIL_UNAVAILABLE (genéricos), sin revelar que es una cuenta de soporte.
CREATE FUNCTION users_email_not_support() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.support_accounts a WHERE a.email = NEW.email) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', CONSTRAINT = 'users_email_key',
                          MESSAGE = 'email unavailable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_email_not_support BEFORE INSERT OR UPDATE OF email ON users
  FOR EACH ROW EXECUTE FUNCTION users_email_not_support();

CREATE FUNCTION support_accounts_email_not_workshop() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.email = NEW.email) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', CONSTRAINT = 'support_accounts_email_workshop',
                          MESSAGE = 'email belongs to a workshop account';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_accounts_email_not_workshop BEFORE INSERT OR UPDATE OF email ON support_accounts
  FOR EACH ROW EXECUTE FUNCTION support_accounts_email_not_workshop();

-- Dueño y permisos, igual que la 002 (data-model 002, "Mantenimiento").
GRANT CREATE ON SCHEMA public TO motorsync_support;
ALTER FUNCTION support_session_agent(uuid)                       OWNER TO motorsync_support;
ALTER FUNCTION support_require_platform_context()                OWNER TO motorsync_support;
ALTER FUNCTION support_request_help(text, text)                  OWNER TO motorsync_support;
ALTER FUNCTION support_list_open_tickets(uuid)                   OWNER TO motorsync_support;
ALTER FUNCTION support_get_ticket(uuid, uuid)                    OWNER TO motorsync_support;
ALTER FUNCTION support_discard_ticket(uuid, uuid, text, text)    OWNER TO motorsync_support;
ALTER FUNCTION support_workshop_email_exists(text)               OWNER TO motorsync_support;
ALTER FUNCTION users_email_not_support()                         OWNER TO motorsync_support;
ALTER FUNCTION support_accounts_email_not_workshop()             OWNER TO motorsync_support;
REVOKE CREATE ON SCHEMA public FROM motorsync_support;

SET ROLE motorsync_support;
REVOKE ALL ON FUNCTION support_session_agent(uuid), support_require_platform_context(),
                       support_request_help(text, text), support_list_open_tickets(uuid),
                       support_get_ticket(uuid, uuid), support_discard_ticket(uuid, uuid, text, text),
                       support_workshop_email_exists(text), users_email_not_support(),
                       support_accounts_email_not_workshop()
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_request_help(text, text), support_list_open_tickets(uuid),
                          support_get_ticket(uuid, uuid), support_discard_ticket(uuid, uuid, text, text)
  TO motorsync_app;
GRANT EXECUTE ON FUNCTION support_workshop_email_exists(text) TO motorsync_migrator;
RESET ROLE;
-- support_session_agent y support_require_platform_context: solo las llaman otras funciones del
-- mismo dueño. Los triggers no necesitan EXECUTE del que inserta.
```

**Mantenimiento**: idéntico a la 002, con el otro rol. Toda migración que reemplace o borre funciones `support_*` (o los dos triggers de FR-024) debe hacerlo como su dueño: `GRANT CREATE ON SCHEMA public TO motorsync_support; SET ROLE motorsync_support; …; RESET ROLE; REVOKE CREATE ON SCHEMA public FROM motorsync_support;`. Se propone agregar `motorsync_support` a la lección existente de `CLAUDE.md` (tarea del leader).

### Migración `1761000001300-AllowSupportAuditActor` (PR2)

```sql
-- R11: actor de soporte de la plataforma en la auditoría del taller. No toca filas.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_role_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_role_check
  CHECK (actor_role IN ('asesor', 'admin', 'platform_support'));
-- down: el CHECK de la 001 (falla, como debe, si ya hay registros de soporte).
```

### Migración `1761000001400-CreateSupportPasswordFunctions` (PR2)

```sql
-- US3 (R9), paso 1: bloquea el ticket y devuelve taller y cuenta. 0 filas si no existe.
-- Devuelve también el estado, para distinguir 404 de 409 TICKET_NOT_OPEN.
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

-- US3 (R9), paso 8: cierra el ticket como Resuelto con la nota. Exige el taller del ticket fijado
-- (lo fijó el paso 3) y el ticket todavía abierto (la fila ya está bloqueada por el paso 1).
CREATE FUNCTION support_resolve_ticket(p_session_id uuid, p_ticket_id uuid, p_note text, p_ip text)
  RETURNS void
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
END $$;
-- Dueño, REVOKE FROM PUBLIC y GRANT EXECUTE TO motorsync_app como en 1761000001200.
```

`support_session_agent` se evalúa con el taller ya fijado en `support_resolve_ticket`: lee `support_sessions` y `support_accounts` como `motorsync_support` (políticas `support_*_support_read`, sin la condición "sin taller" de la app), así que funciona.

### Migración `1761000001500-CreateSupportAccessLog` (PR3)

```sql
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

-- US4-AC1, US4-AC2: talleres, 50 por página, por prefijo de RUC o parte del nombre (sin tildes).
-- p_ruc_prefix: dígitos ya normalizados por la API, o NULL si la consulta no es un documento.
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
-- La API escapa % y _ de p_name_query antes de llamarla (con ESCAPE '\' implícito de LIKE).

-- US4-AC3, US4-AC6, US4-AC7: cuentas de un taller + registro en la bitácora, en una sola llamada.
-- Taller inexistente: P0002 (404) y sin registro.
CREATE FUNCTION support_list_workshop_accounts(p_session_id uuid, p_tenant_id uuid, p_ip text)
  RETURNS TABLE (user_id uuid, name text, email text, role text, status text, has_open_ticket boolean)
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
           EXISTS (SELECT 1 FROM public.support_tickets k WHERE k.user_id = u.id AND k.status = 'open')
      FROM public.users u
     WHERE u.tenant_id = p_tenant_id
     ORDER BY u.status, u.name, u.id;
END $$;

-- US4-AC8, US4-AC9, FR-027: lectura de la bitácora, de la más reciente a la más antigua, 50 por página,
-- filtrable por taller y por agente (NULL = sin filtro). Solo SELECT (STABLE): consultar la bitácora
-- no escribe en ella (research R10). Nunca devuelve el correo del agente ni cuentas de taller.
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
-- Dueño, REVOKE FROM PUBLIC y GRANT EXECUTE TO motorsync_app como en 1761000001200
-- (para las tres funciones de esta migración).
```

Los índices `support_access_log_tenant_idx` y `support_access_log_agent_idx` sirven a los dos filtros con el orden `occurred_at DESC`.

### `audit_log` (PR2)

Solo el CHECK de `actor_role` (migración 1300). Se amplían `AUDIT_ACTIONS` (`user.password_reset_by_support`) y el tipo del rol del actor en `src/audit/audit-log.entity.ts` (`AuditActorRole = AuthRole | 'platform_support'`).

| Acción | `before` | `after` |
|---|---|---|
| `user.password_reset_by_support` | `{ "mustChangePassword": false }` | `{ "mustChangePassword": true, "temporaryPasswordExpiresAt": "…Z", "sessionsClosed": 2, "supportTicketNumber": 123 }` |

Nunca se incluyen la temporal, el hash ni la nota de verificación (FR-020, US3-AC6).

## Relaciones

- `support_sessions.support_account_id → support_accounts(id)`; `support_refresh_tokens.session_id → support_sessions(id)`.
- `support_tickets (tenant_id, user_id) → users (tenant_id, id)`; `support_tickets.tenant_id → tenants(id)`; `resolved_by`, `discarded_by → support_accounts(id)`.
- `support_ticket_events.ticket_id → support_tickets(id)`; `support_account_id → support_accounts(id)`.
- `support_access_log.support_account_id → support_accounts(id)`; `tenant_id → tenants(id)`.
- `audit_log.actor_user_id = support_accounts.id` cuando `actor_role = 'platform_support'` (sin FK, como en la 001).
- `users.updated_by = support_accounts.id` tras una temporal por soporte (sin FK, como en la 002).

## Transiciones de estado

**Ticket (`support_tickets.status`)**

```
(¿Olvidaste tu contraseña? con cuenta de taller y sin ticket abierto) ─▶ open
open ──nueva solicitud (mismo correo)──▶ open   [last_requested_at = now(), request_count + 1]
open ──generar temporal (nota, cuenta activa)──▶ resolved   [contraseña, sesiones, bloqueo, audit_log del taller, evento]
open ──descartar (motivo)──▶ discarded                      [evento; la cuenta no cambia; sin audit_log]
resolved | discarded ──(cualquier cosa)──▶ rechazado (trigger)   [una solicitud nueva crea otro ticket]
```

**Cuenta de soporte (`support_accounts.status`)**: solo por el procedimiento de operaciones.

```
(create) ─▶ active, must_change_password = true, expires = now()+72h
active ──deactivate──▶ inactive   [revoca sesiones en la misma transacción]
inactive ──reactivate──▶ active   [no revive sesiones]
(reset-password) ─▶ must_change_password = true, expires = now()+72h   [revoca sesiones, quita bloqueo]
true ──POST /support/auth/password──▶ false   [revoca las otras sesiones]
```

**Sesión de soporte**: idéntica a la sesión de la 002 (data-model 002, "Sesión").

**Cuenta de taller tras una temporal por soporte**: igual que "restablecer" en la 002 (`must_change_password = true`, vence a las 72 h, sesiones revocadas con `password_reset`, bloqueo borrado); rol y estado sin cambios.

## Consultas de referencia (las implementa `implementer-backend`)

- **Validación por request del panel (R4)**: la sentencia `UPDATE support_sessions … RETURNING` de research R4, sin taller fijado.
- **Login de soporte**: `SELECT id, name, email, status, password_hash, must_change_password, temp_password_expires_at, temp_password_expires_at <= now() AS temp_password_expired FROM support_accounts WHERE email = $1`, sin taller fijado; y, en la transacción que abre la sesión, `SELECT … FROM support_accounts WHERE id = $1 AND password_hash = $2 AND status = 'active' FOR SHARE` (R4).
- **Revocar sesiones de soporte**: `UPDATE support_sessions SET revoked_at = now(), revoke_reason = $2 WHERE support_account_id = $1 AND revoked_at IS NULL [AND id <> $current]`.
- **Temporal por soporte (R9)**: los pasos 0–9 de research R9; las sentencias de `applyTemporaryPassword` son las de `UsersService.resetPassword` de la 002.
- **Bitácora (operador)**: `SELECT l.occurred_at, a.name, a.email, t.name, l.ip FROM support_access_log l JOIN support_accounts a ON a.id = l.support_account_id JOIN tenants t ON t.id = l.tenant_id ORDER BY l.occurred_at DESC` como migrator (o `support:account -- access-log`).
