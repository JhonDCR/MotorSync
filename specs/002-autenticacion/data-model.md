# Data Model: Autenticación, talleres y usuarios

**Feature**: `specs/002-autenticacion/spec.md` | **Decisiones**: [research.md](./research.md) R1–R10

Las migraciones nuevas van en `backend/src/database/migrations/`, después de `1761000000300-CreateAuditLog`. Las aplica `motorsync_migrator`. El SQL de este documento es la fuente para los implementers (en la 001 las migraciones copian el DDL "verbatim"). Todas las fechas son `timestamptz` (UTC).

## Resumen de entidades

| Entidad (spec) | Tabla | `tenant_id` | RLS | Notas |
|---|---|---|---|---|
| Taller | `tenants` (existe) | es el tenant | `ENABLE` (sin `FORCE`) | Nueva columna `ruc`, nullable para los talleres de la 001 y de prueba (R9) |
| Cuenta de usuario | `users` | sí | `ENABLE` + `FORCE` | Correo único global; no hay `DELETE` |
| Sesión | `user_sessions` | sí | `ENABLE` + `FORCE` | Familia de refresh tokens; inactividad por `last_activity_at` |
| (técnica) Refresh token | `refresh_tokens` | sí | `ENABLE` + `FORCE` | Solo el hash SHA-256 |
| (técnica) Intentos fallidos | `login_attempts` | **no** | sin RLS, sin privilegios para `motorsync_app` | Por hash del correo; ver Complexity Tracking del plan |
| Registro de auditoría | `audit_log` (existe) | sí | sin cambios | Acciones nuevas `user.*` |

## Valores enumerados

| Campo | Valores |
|---|---|
| `users.role` | `asesor`, `admin` (igual que `AUTH_ROLES` de la 001) |
| `users.status` | `active`, `inactive` |
| `user_sessions.revoke_reason` | `logout`, `deactivated`, `password_changed`, `password_reset`, `refresh_reuse`, `temp_password_expired` |
| `audit_log.action` (nuevas) | `user.role_changed`, `user.deactivated`, `user.reactivated`, `user.password_reset` |
| `audit_log.entity_type` (nuevo) | `user` |

## Reglas de validación (fuente: spec)

| Campo | Regla | Dónde |
|---|---|---|
| Nombre comercial | 2–120 caracteres tras recortar espacios | DTO; la BD mantiene su CHECK 1–200 de la 001 |
| RUC del taller | `normalizeDocument()` + `isValidRuc()` de `src/common/identifiers` (FR-002) | DTO (`IsEcDocument` en modo RUC) + CHECK de forma + índice único |
| Nombre de la persona | 2–120 caracteres tras recortar espacios | DTO + CHECK |
| Correo | se recortan los espacios y se pasa a minúsculas; formato estándar; hasta 254 caracteres (FR-003) | `normalizeEmail()` nuevo en `identifiers/` + DTO + CHECK de normalización + índice único global |
| Contraseña | 8–128 caracteres Unicode, sin recorte (FR-005) | DTO (`IsPassword`) |
| Rol | `asesor` o `admin` | DTO + CHECK |
| Contraseña temporal | igual que la contraseña; vence a las 72 h (FR-026) | DTO + `temp_password_expires_at` |

## DDL

### Bootstrap (`backend/db/bootstrap.sql`, lo ejecuta el superusuario, idempotente)

Se agrega al archivo existente:

```sql
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
```

### Migración `1761000000400-AddTenantRuc`

```sql
ALTER TABLE tenants ADD COLUMN ruc text COLLATE "C"
  CHECK (ruc IS NULL OR ruc ~ '^[0-9]{10}001$');
CREATE UNIQUE INDEX tenants_ruc_key ON tenants (ruc);          -- FR-002 (los NULL no chocan)

-- La app solo ve su propio taller (para GET /auth/me). Sin FORCE: el migrator (dueño) sigue
-- insertando talleres en fixtures, seed-dev y seed-volume.sql como en la 001 (R9).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_self ON tenants FOR SELECT TO motorsync_app
  USING (id = app_current_tenant());
CREATE POLICY tenants_auth_register ON tenants FOR INSERT TO motorsync_auth
  WITH CHECK (id = app_current_tenant());

GRANT SELECT ON tenants TO motorsync_app;
GRANT INSERT (id, name, ruc) ON tenants TO motorsync_auth;
```

### Migración `1761000000500-CreateUsers`

```sql
CREATE TABLE users (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
  name                      text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  email                     text COLLATE "C" NOT NULL CHECK (
                              email = lower(btrim(email))
                              AND length(email) BETWEEN 3 AND 254
                              AND email ~ '^[^@\s]+@[^@\s]+$'),
  password_hash             text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  role                      text NOT NULL CHECK (role IN ('asesor', 'admin')),
  status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  must_change_password      boolean NOT NULL DEFAULT false,
  temp_password_expires_at  timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid NOT NULL,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid NOT NULL,
  updated_by_name           text NOT NULL,
  CONSTRAINT users_temp_password_coherent
    CHECK (must_change_password = (temp_password_expires_at IS NOT NULL)),
  CONSTRAINT users_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX users_email_key ON users (email);          -- FR-003: único en todo MotorSync
CREATE INDEX users_tenant_id_idx ON users (tenant_id);
CREATE INDEX users_tenant_admins_idx ON users (tenant_id) WHERE role = 'admin' AND status = 'active';

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON users
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
-- Excepciones acotadas al dueño de las funciones SECURITY DEFINER (R1).
CREATE POLICY users_auth_lookup ON users FOR SELECT TO motorsync_auth USING (true);
CREATE POLICY users_auth_register ON users FOR INSERT TO motorsync_auth
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON users TO motorsync_app;        -- sin DELETE (FR-017)
GRANT SELECT (id, tenant_id, name, email, password_hash, role, status,
              must_change_password, temp_password_expires_at) ON users TO motorsync_auth;
GRANT INSERT (id, tenant_id, name, email, password_hash, role, status,
              must_change_password, created_by, updated_by, updated_by_name) ON users TO motorsync_auth;
```

### Migración `1761000000600-CreateSessions`

```sql
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
);

CREATE INDEX user_sessions_tenant_id_idx ON user_sessions (tenant_id);
CREATE INDEX user_sessions_open_by_user_idx ON user_sessions (tenant_id, user_id) WHERE revoked_at IS NULL;

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY user_sessions_tenant_isolation ON user_sessions
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON user_sessions TO motorsync_app;

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
  session_id  uuid NOT NULL,
  token_hash  text COLLATE "C" NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz,
  CONSTRAINT refresh_tokens_session_fk FOREIGN KEY (tenant_id, session_id)
    REFERENCES user_sessions (tenant_id, id)
);

CREATE UNIQUE INDEX refresh_tokens_token_hash_key ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_tenant_id_idx ON refresh_tokens (tenant_id);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (tenant_id, session_id);

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_tokens_tenant_isolation ON refresh_tokens
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY refresh_tokens_auth_lookup ON refresh_tokens FOR SELECT TO motorsync_auth USING (true);

-- DELETE solo para podar tokens rotados de más de 1 día de la misma sesión (R5).
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO motorsync_app;
GRANT SELECT (id, tenant_id, session_id, token_hash, rotated_at) ON refresh_tokens TO motorsync_auth;
```

### Migración `1761000000700-CreateLoginAttempts`

```sql
-- Tabla técnica global (R4): no contiene datos de ningún taller ni correos en claro.
CREATE TABLE login_attempts (
  email_hash    text COLLATE "C" PRIMARY KEY CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  failed_count  integer NOT NULL CHECK (failed_count >= 0),
  locked_until  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON login_attempts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempts TO motorsync_auth;
-- motorsync_app no tiene ningún privilegio: solo llega a través de las funciones.
```

### Migración `1761000000800-CreateAuthFunctions`: funciones SECURITY DEFINER

Reglas comunes:
- `SECURITY DEFINER` con dueño `motorsync_auth` y `SET search_path = pg_catalog, public, pg_temp`.
- SQL estático y nombres calificados.
- `REVOKE ALL … FROM PUBLIC` y `GRANT EXECUTE … TO motorsync_app`.

```sql
-- US1: crea taller + primer admin de forma atómica (FR-004). Fija app.tenant_id del taller nuevo
-- en la transacción del llamador (is_local = true), para que la app cree la sesión bajo RLS.
-- Inserta primero el taller: con RUC y correo duplicados gana tenants_ruc_key (US1-AC5).
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
END $$;

-- US2: lo mínimo para verificar la contraseña y decidir. 0 filas si el correo no existe.
CREATE FUNCTION auth_find_user_for_login(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, name text, role text, status text,
                 password_hash text, must_change_password boolean,
                 temp_password_expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.name, u.role, u.status, u.password_hash,
         u.must_change_password, u.temp_password_expires_at
    FROM public.users u WHERE u.email = p_email
$$;

-- US3: resuelve el taller y la sesión de un refresh token. El resto lo hace la app bajo RLS.
CREATE FUNCTION auth_find_refresh_token(p_token_hash text)
  RETURNS TABLE (token_id uuid, tenant_id uuid, session_id uuid, rotated_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t.id, t.tenant_id, t.session_id, t.rotated_at
    FROM public.refresh_tokens t WHERE t.token_hash = p_token_hash
$$;

-- FR-009: bloqueo vigente para un correo (exista o no). NULL si no hay bloqueo.
CREATE FUNCTION auth_login_locked_until(p_email_hash text) RETURNS timestamptz
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a.locked_until FROM public.login_attempts a
   WHERE a.email_hash = p_email_hash AND a.locked_until > now()
$$;

-- FR-009: suma un fallo de forma atómica (el upsert serializa intentos simultáneos, US2-AC9).
-- Devuelve locked_until si con este fallo (o antes) quedó bloqueado.
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
END $$;

-- FR-009: éxito. false si en este instante hay un bloqueo vigente (carrera con otros fallos).
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
END $$;

-- US4-AC21: el restablecimiento quita el bloqueo, solo para cuentas del taller fijado.
CREATE FUNCTION auth_clear_login_failures(p_user_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  DELETE FROM public.login_attempts a
   USING public.users u
   WHERE u.id = p_user_id AND u.tenant_id = public.app_current_tenant()
     AND a.email_hash = encode(sha256(convert_to(u.email, 'UTF8')), 'hex')
$$;

-- Dueño y permisos (R1). CREATE en el esquema solo mientras se cambia el dueño.
GRANT CREATE ON SCHEMA public TO motorsync_auth;
ALTER FUNCTION auth_register_workshop(text, text, text, text, text) OWNER TO motorsync_auth;
ALTER FUNCTION auth_find_user_for_login(text)    OWNER TO motorsync_auth;
ALTER FUNCTION auth_find_refresh_token(text)     OWNER TO motorsync_auth;
ALTER FUNCTION auth_login_locked_until(text)     OWNER TO motorsync_auth;
ALTER FUNCTION auth_record_login_failure(text)   OWNER TO motorsync_auth;
ALTER FUNCTION auth_record_login_success(text)   OWNER TO motorsync_auth;
ALTER FUNCTION auth_clear_login_failures(uuid)   OWNER TO motorsync_auth;
REVOKE CREATE ON SCHEMA public FROM motorsync_auth;

GRANT EXECUTE ON FUNCTION app_current_tenant() TO motorsync_auth;

-- Los privilegios de las funciones solo los puede cambiar su dueño. Con INHERIT FALSE,
-- después del ALTER ... OWNER el migrator ya no lo es: hacer el REVOKE/GRANT sin SET ROLE
-- solo emite WARNING y PUBLIC conserva EXECUTE (defecto detectado por T001, 2026-10-23).
SET ROLE motorsync_auth;
REVOKE ALL ON FUNCTION auth_register_workshop(text, text, text, text, text),
                       auth_find_user_for_login(text), auth_find_refresh_token(text),
                       auth_login_locked_until(text), auth_record_login_failure(text),
                       auth_record_login_success(text), auth_clear_login_failures(uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_register_workshop(text, text, text, text, text),
                          auth_find_user_for_login(text), auth_find_refresh_token(text),
                          auth_login_locked_until(text), auth_record_login_failure(text),
                          auth_record_login_success(text), auth_clear_login_failures(uuid)
  TO motorsync_app;
RESET ROLE;
-- Resultado esperado del ACL: {motorsync_auth=X/motorsync_auth,motorsync_app=X/motorsync_auth}
```

**Mantenimiento**: por `INHERIT FALSE`, el migrator no tiene los privilegios de dueño de estas funciones. Toda migración posterior que las reemplace (`CREATE OR REPLACE`) o las borre (`down`) debe envolverse así: `GRANT CREATE ON SCHEMA public TO motorsync_auth; SET ROLE motorsync_auth; …; RESET ROLE; REVOKE CREATE ON SCHEMA public FROM motorsync_auth;`.

`email_hash` se calcula igual en Node y en SQL: SHA-256 en hex del correo normalizado codificado en UTF-8 (`createHash('sha256').update(email, 'utf8').digest('hex')`).

### Migración `1761000000900-AddLastAdminTrigger` (PR3)

Va en el PR3, junto con la gestión de usuarios, para que su prueba (T051) nazca en rojo.

```sql
-- FR-018, defensa en la base (R8): al confirmar, el taller conserva al menos un admin activo.
-- La garantía ante concurrencia la da el advisory lock del taller (R8); esto atrapa olvidos del código.
CREATE FUNCTION users_require_active_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users
                  WHERE tenant_id = NEW.tenant_id AND role = 'admin' AND status = 'active') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'users_last_admin',
                          MESSAGE = 'tenant must keep at least one active admin';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER users_keep_active_admin
  AFTER UPDATE OF role, status ON users
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.role = 'admin' AND OLD.status = 'active')
  EXECUTE FUNCTION users_require_active_admin();
```

### `audit_log` (sin cambios de DDL)

Solo se amplían `AUDIT_ACTIONS` y `AuditEntityType` en `src/audit/audit-log.entity.ts`. Contenido de `before` y `after` (claves en camelCase, como en la 001):

| Acción | `before` | `after` |
|---|---|---|
| `user.role_changed` | `{ "role": "asesor" }` | `{ "role": "admin" }` |
| `user.deactivated` | `{ "status": "active" }` | `{ "status": "inactive", "sessionsClosed": 2 }` |
| `user.reactivated` | `{ "status": "inactive" }` | `{ "status": "active" }` |
| `user.password_reset` | `{ "mustChangePassword": false }` | `{ "mustChangePassword": true, "temporaryPasswordExpiresAt": "…Z", "sessionsClosed": 2 }` |

Nunca se incluyen `password_hash` ni contraseñas (FR-006, US4-AC24).

## Relaciones

- `users (tenant_id) → tenants(id)`; `users.email` es único global.
- `user_sessions (tenant_id, user_id) → users (tenant_id, id)`: una sesión no puede apuntar a una cuenta de otro taller, aunque falle la aplicación.
- `refresh_tokens (tenant_id, session_id) → user_sessions (tenant_id, id)`.
- `audit_log.entity_id = users.id` cuando `entity_type = 'user'` (sin FK, como en la 001).

## Transiciones de estado

**Cuenta (`users.status`)**

```
active ──deactivate (admin; no deja 0 admins activos)──▶ inactive   [revoca sesiones, audita]
inactive ──reactivate (admin)──▶ active                              [audita; no revive sesiones]
```

**Contraseña (`must_change_password`)**

```
(registro del dueño) ─▶ false
(crear por admin | restablecer) ─▶ true, expires = now()+72h   [restablecer: revoca sesiones, quita bloqueo, audita]
true ──POST /auth/password con la temporal vigente──▶ false, expires = NULL   [revoca las otras sesiones]
true y expires < now() ──login──▶ 401 TEMPORARY_PASSWORD_EXPIRED (sin sesión)
```

**Sesión (`user_sessions`)**

```
abierta (revoked_at NULL)
  ├─ request autenticado o refresh con last_activity_at > now()-30min ─▶ abierta (last_activity_at = now())
  ├─ sin actividad 30 min ─▶ inutilizable (calculado; no se escribe)
  └─ logout | deactivated | password_changed | password_reset | refresh_reuse | temp_password_expired
       ─▶ revocada (revoked_at = now(), revoke_reason)
```

## Consultas de referencia (las implementa `implementer-backend`)

- **Validación por request (R6)**: la sentencia `UPDATE user_sessions … RETURNING` de research R6, bajo RLS.
- **Revocar sesiones de una cuenta**: `UPDATE user_sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL [AND id <> $current]`. Con `RETURNING id` se cuentan las sesiones cerradas (`sessionsClosed`).
- **Último administrador (R8)**:
  1. `SELECT pg_advisory_xact_lock(hashtextextended('users-admins:' || app_current_tenant()::text, 0))`. Lo toma el interceptor antes de validar la sesión, en los handlers con `@LocksTenantAdmins()` (orden de locks en R8), no el servicio;
  2. `SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active' AND id <> $target`;
  3. si es 0 y el cambio quita el rol o desactiva a `$target`, responder 409 `LAST_ADMIN`.
- **Listado (US4-AC1)**: `SELECT id, name, email, role, status, must_change_password, temp_password_expires_at, created_at, updated_at, updated_by_name FROM users ORDER BY status, name`. Bajo RLS; nunca se selecciona `password_hash`.
- **Historial de una cuenta**: `SELECT … FROM audit_log WHERE entity_type = 'user' AND entity_id = $1 ORDER BY occurred_at DESC`. Bajo RLS.
