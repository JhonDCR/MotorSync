---

description: "Tareas de 003-soporte-plataforma, agrupadas por PR y por historia, en pares TDD"
---

# Tasks: Soporte de la plataforma y recuperación de acceso

**Input**: Design documents from `specs/003-soporte-plataforma/`

**Prerequisites**: [plan.md](./plan.md) (aprobado el 2026-10-25, commit 7be4261), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/openapi.yaml](./contracts/openapi.yaml), [quickstart.md](./quickstart.md)

**Tests**: obligatorios (constitución, principio II).
- Cada tarea de prueba precede a su tarea de implementación y cita los IDs de los criterios que cubre.
- Cada `it()` empieza por el ID del criterio (`US3-AC12 …`) o del requisito (`FR-024 …`, `SC-008 …`).
- La prueba se entrega **en rojo**; el implementer la pone en verde **sin tocarla**.
- **Las pruebas existentes de la 001 y la 002 no se modifican.** Los casos nuevos van en archivos nuevos. Excepciones, justificadas en su PR:
  - T003: `backend/test/setup/db-fixtures.ts` (tablas nuevas en `BUSINESS_TABLES` y helpers nuevos, como en la 002);
  - T032: el fixture `frontend/src/testing/auth-fixtures.ts` y los comentarios de cabecera de 4 specs por el cambio de requisito **FR-022** (research R12). Cambia el valor esperado de 3 pruebas de la 002; requiere nota de justificación en el PR y **aprobación humana** antes del merge.

**Organization**: enmienda (PR0) + 3 PRs (plan, "Entrega propuesta"). Dentro de cada PR hay una base técnica y luego fases por historia.

## Format: `[ID] [P?] [Story] Descripción — ruta(s) — agente`

- **[P]**: se puede hacer en paralelo con otras tareas [P] de la misma fase (archivos distintos, sin dependencias pendientes).
- **[USn]**: historia de la spec a la que pertenece.
- **Agentes**:
  - `tester`: solo `*.spec.ts`, `*.e2e-spec.ts`, `backend/test/**` y `frontend/src/testing/**`.
  - `implementer-backend`: solo `backend/`, sin pruebas.
  - `implementer-frontend`: solo `frontend/`, sin pruebas.
  - `reviewer`: solo lectura.
  - `leader`: constitución, `.env.example`, `backend/vitest.config.ts`, `backend/vitest.shared.ts`, `.github/workflows/ci.yml`, `CLAUDE.md` y la ejecución de las verificaciones.
- Rutas relativas a la raíz del repo.
- **Códigos de error** (contrato): "400 `REQUIRED`", "400 `INVALID_EMAIL`" o "400 `UNKNOWN_FIELD`" significan `400` con `code = VALIDATION_ERROR` y ese valor en `errors[].code` del campo. El resto (`FORBIDDEN`, `SESSION_REVOKED`, `HELP_RATE_LIMITED`, `TICKET_NOT_OPEN`, `ACCOUNT_INACTIVE`…) va en `code`.
- **Tiempo simulado**: las e2e no esperan 30 minutos, 1 hora ni 72 horas. Escriben las fechas con el migrator mediante los helpers de T003 (`support_sessions.last_activity_at`, `support_accounts.temp_password_expires_at`, `help_request_throttle.window_started_at`, `users.temp_password_expires_at`, `support_refresh_tokens.rotated_at`).
- **Orígenes simulados** (FR-004): las e2e de "¿Olvidaste tu contraseña?" activan `trust proxy` (`'loopback'`) **solo en la app de prueba** (helper de T003) y mandan `X-Forwarded-For` por petición. La API de producción no cambia (plan, riesgo 3).
- **Orden de locks de la temporal por soporte** (research R9), que citan las tareas de concurrencia: **sesión de soporte propia → ticket (`FOR UPDATE`) → advisory lock del taller → sesiones del objetivo → fila de `users`**. Los caminos del taller de la 002 toman **advisory lock → sesión propia → sesiones del objetivo → `users`** y nunca un ticket ni una sesión de soporte.

---

# PR0: enmienda de la constitución 1.3.0 (prerrequisito)

- [x] T001 Aplicar la enmienda MINOR 1.3.0 con el texto **literal** de research R1 ("Enmienda de la constitución necesaria") en `.specify/memory/constitution.md` (principio I: tercera y cuarta viñetas y viñeta nueva; principio IV: primera y segunda viñetas; pie `**Version**: 1.3.0 | **Ratified**: 2026-10-21 | **Last Amended**: <fecha del merge>`). PR propio `docs: amend constitution 1.3.0`, aprobado por ambos integrantes en GitHub, integrado en `main` **antes** de integrar cualquier código del PR1. Revisar que `CLAUDE.md` y `.claude/agents/reviewer.md` sigan siendo coherentes (research R1, "Procedimiento"). **Completada**: PR #16 mergeado en `main` el 2026-10-25 — leader

---

# PR1: pedir ayuda, acceso de soporte y bandeja (US1, US2, FR-022)

Al terminar, "¿Olvidaste tu contraseña?" crea o actualiza tickets sin revelar si el correo existe; el operador crea cuentas de soporte con el procedimiento de operaciones; los agentes entran al panel, ven la bandeja y descartan tickets; las zonas de taller y de soporte están separadas en ambos sentidos; y la 001 y la 002 siguen en verde (salvo el cambio de texto de FR-022, justificado).

## Phase 1: Setup (PR1)

**Purpose**: rol `motorsync_support`, migraciones con sus funciones `SECURITY DEFINER`, fixtures y variable de entorno.

- [x] T002 Escribir la e2e de BD que demuestra el diseño de `motorsync_support` (research R1, R2, R5, R6, R7, R8; data-model) en `backend/test/db/support-roles.e2e-spec.ts`. Conexiones como `motorsync_app` (`DATABASE_URL`) y como `motorsync_migrator`; datos con los fixtures de T003. Debe comprobar:
  - (a) **Rol**: en `pg_roles`, `motorsync_support` tiene `rolcanlogin = false`, `rolbypassrls = false`, `rolinherit = false`, `rolsuper = false`. `pg_has_role('motorsync_app', 'motorsync_support', 'MEMBER')` es `false` y `SET ROLE motorsync_support` como app falla con *permission denied*. Ningún rol de la base tiene `rolbypassrls = true` salvo superusuarios (principio I).
  - (b) **Funciones**: las 9 de la migración 1200 (`support_session_agent`, `support_require_platform_context`, `support_request_help`, `support_list_open_tickets`, `support_get_ticket`, `support_discard_ticket`, `support_workshop_email_exists`, `users_email_not_support`, `support_accounts_email_not_workshop`) tienen `prosecdef = true`, dueño `motorsync_support` y `proconfig` con `search_path=pg_catalog, public, pg_temp`; ninguna concede `EXECUTE` a `PUBLIC` (aclexplode de `proacl`). `motorsync_app` tiene `EXECUTE` **solo** sobre `support_request_help`, `support_list_open_tickets`, `support_get_ticket` y `support_discard_ticket`; **no** sobre `support_session_agent`, `support_require_platform_context` ni `support_workshop_email_exists` (esta última sí para `motorsync_migrator`).
  - (c) **RLS y privilegios de la app** (R2, R6):
    - `relrowsecurity = true` y `relforcerowsecurity = false` en `support_accounts`, `support_sessions`, `support_refresh_tokens`, `support_tickets` y `support_ticket_events`; `help_request_throttle` sin RLS y sin ningún privilegio para la app;
    - como app: `SELECT`, `INSERT`, `UPDATE` y `DELETE` sobre `support_tickets`, `support_ticket_events` y `help_request_throttle` dan *permission denied*; `INSERT` y `DELETE` sobre `support_accounts` dan *permission denied*; `UPDATE support_accounts SET name|email|status = …` da *permission denied* y `UPDATE … SET password_hash = …` sin taller fijado funciona (FR-007, US2-AC2, SC-009);
    - sin taller fijado, la app ve las filas de `support_accounts` y `support_sessions`; con `set_config('app.tenant_id', <A>, true)` ve 0 filas y un `INSERT` en `support_sessions` falla por `WITH CHECK` (separación de zonas en la base);
    - las tablas del taller (`users`, `user_sessions`, `audit_log`, `clients`, `vehicles`) conservan `relforcerowsecurity = true` (FR-025).
  - (d) **Columnas de `motorsync_support`** (`information_schema.column_privileges`): en `tenants` solo `id, name, ruc, created_at`; en `users` solo `id, tenant_id, name, email, role, status`; en `support_accounts` solo `id, name, email, status, must_change_password`. **Sin** privilegio alguno sobre `users.password_hash`, `user_sessions`, `refresh_tokens`, `login_attempts`, `clients`, `vehicles` ni `audit_log` (`has_table_privilege` / `has_column_privilege` en `false`).
  - (e) **Compuertas** (R1): con un uuid al azar, `support_list_open_tickets`, `support_get_ticket` y `support_discard_ticket` lanzan `28000`; con una sesión de soporte válida pero revocada, con `last_activity_at` de hace 31 minutos, con la cuenta `inactive` o con `must_change_password = true`, también `28000`; con una sesión válida y **con el taller A fijado**, lanzan `28000` (compuerta de contexto).
  - (f) **Columnas devueltas**: `support_list_open_tickets` devuelve exactamente las 11 columnas de data-model, ordenadas por `created_at, number`, con tickets de A y de B; `support_get_ticket` exactamente sus 18 columnas y 0 filas con un id inexistente.
  - (g) **`support_request_help`** (R7, R8): con el correo de una cuenta de A sin ticket, devuelve `accepted` y crea un ticket `open` con `tenant_id = A`, `user_id` y `email` normalizado; una segunda llamada no crea otro y deja `request_count = 2` y `last_requested_at` posterior; con un correo inexistente o de una cuenta de soporte, `accepted` y 0 filas nuevas en `support_tickets` (US1-AC3, US1-AC10); la 21.ª llamada con el mismo `origin_hash` en la ventana devuelve `rate_limited` y no crea ni actualiza tickets; con `window_started_at` de hace más de 1 hora, reinicia en 1. Tras todas las llamadas, `users`, `user_sessions`, `login_attempts` y `audit_log` no cambian (FR-005).
  - (h) **Tickets** (R6): el índice único parcial impide un segundo `open` para la misma cuenta (`23505`) y permite uno nuevo si el anterior está `resolved` o `discarded`; como migrator, `UPDATE` de un ticket `discarded` lanza "closed support tickets are immutable" y `DELETE` de cualquier ticket lanza excepción (FR-014, FR-015, SC-010); `UPDATE`/`DELETE` en `support_ticket_events` lanza excepción (append-only); la FK compuesta rechaza un ticket con `tenant_id = A` y la cuenta de B; el CHECK `support_tickets_state_coherent` rechaza `resolved` sin nota.
  - (i) **`support_discard_ticket`**: con sesión válida y motivo de solo espacios lanza `22023`; con motivo, devuelve `discarded`, guarda `discard_reason` recortado, `discarded_by` = la cuenta de la sesión (nunca un parámetro) e inserta el evento `open → discarded`; una segunda llamada devuelve `not_open`; un id inexistente, `not_found`.
  - (j) **FR-024 en ambos sentidos** (R5): como migrator, insertar en `support_accounts` el correo de una cuenta de taller lanza `23505` con `constraint = 'support_accounts_email_workshop'`; insertar en `users` (con el taller fijado) el correo de una cuenta de soporte lanza `23505` con `constraint = 'users_email_key'` y mensaje sin la palabra "support"; `support_workshop_email_exists` responde `true`/`false` como migrator y da *permission denied* como app.

  Cubre el principio I (1.3.0), FR-005, FR-007, FR-008, FR-014, FR-015, FR-024, FR-025, US1-AC3, US1-AC10, US2-AC2, SC-008 y SC-009 — tester
- [x] T003 [P] Ampliar el arnés e2e (justificar en el PR1: edición de un archivo de pruebas existente, como en la 002).
  - `backend/test/setup/db-fixtures.ts`:
    - agregar `support_accounts`, `support_sessions`, `support_refresh_tokens`, `support_tickets`, `support_ticket_events` y `help_request_throttle` a `BUSINESS_TABLES` (y `support_access_log`, que no existe hasta el PR3: `truncateBusinessTables` ya tolera tablas inexistentes);
    - `createSupportAccount({ name, email, password, status?, mustChangePassword?, tempPasswordExpiresAt? })` como migrator (sin taller), con el mismo formato de hash que `createUser`;
    - `createTicket({ tenantId, userId, email, status?, requestCount? })` como migrator; para `resolved` o `discarded`, insertar como `open` y cerrarlo con los datos de cierre coherentes;
    - helpers `setSupportSessionLastActivity(sessionId, minutesAgo)`, `setSupportTemporaryPasswordExpiry(accountId, hoursFromNow)`, `setSupportRefreshRotatedAt(tokenHash, secondsAgo)`, `setHelpThrottle(originHash, count, minutesAgo)`, `originHash(ip)` (SHA-256 hex), `readTickets(userId)`, `readTicketEvents(ticketId)`, `readSupportSessions(accountId)`, `countRows(table)`.
  - `backend/test/setup/support.ts` (nuevo): `loginAsSupport(app, email, password)` → `{ accessToken, refreshCookie, body }`; `supportRefreshCookieFrom(response)`; `withSupportRefreshCookie(cookie)` (headers `Cookie` y `X-Requested-With: motorsync`); `enableTrustProxyForTests(app)` (`app.getHttpAdapter().getInstance().set('trust proxy', 'loopback')`); `forgotPassword(app, body, { ip })`, que manda `X-Forwarded-For: <ip>` y devuelve la respuesta y su duración en ms.

  — tester
- [x] T004 [P] Variable `SUPPORT_JWT_SECRET` (research R3, decisión 2 del humano; **sin valor por defecto en el código**):
  - `.env.example`: `SUPPORT_JWT_SECRET=` con un valor de ejemplo de al menos 32 caracteres distinto de `JWT_SECRET` y el comentario "cambiar; distinto de JWT_SECRET; la API no arranca sin ella";
  - `backend/vitest.config.ts`: agregar `SUPPORT_JWT_SECRET` de prueba a `test.env`;
  - `backend/vitest.shared.ts`: función `supportJwtSecretInTests()` con `process.env.SUPPORT_JWT_SECRET ??= '<valor de prueba>'`, llamada desde `vitest.config.e2e.ts` y `vitest.config.perf.ts` (el valor exportado o el de `.env` gana; en CI `JWT_SECRET` es aleatorio, así que el de prueba siempre difiere);
  - `.github/workflows/ci.yml`: cambiar solo si algún job arranca la API fuera de Vitest.

  — leader
- [x] T005 Ampliar `backend/db/bootstrap.sql` con el bloque de `motorsync_support` de data-model.md, "Bootstrap", **literal**, después del de `motorsync_auth`: `CREATE ROLE` si no existe, `ALTER ROLE motorsync_support NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT`, `GRANT USAGE ON SCHEMA public TO motorsync_support`, `GRANT motorsync_support TO motorsync_migrator WITH INHERIT FALSE, SET TRUE`. Debe seguir siendo idempotente (correr `npm run db:bootstrap` dos veces seguidas sin error) — implementer-backend
- [x] T006 Crear las migraciones con el DDL de data-model.md **literal** y registrarlas por referencia de clase en `backend/src/database/data-source.ts`:
  - `backend/src/database/migrations/1761000001000-CreateSupportAccounts.ts`: `support_accounts` (`name` "length(btrim(name)) BETWEEN 2 AND 120", correo `email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254`, `password_hash LIKE 'scrypt$%'`, `status IN ('active', 'inactive')`, `support_accounts_temp_password_coherent`), `support_sessions` (`revoke_reason IN ('logout', 'deactivated', 'password_changed', 'password_reset', 'refresh_reuse', 'temp_password_expired')`, `support_sessions_revoked_coherent`), `support_refresh_tokens` (`token_hash ~ '^[0-9a-f]{64}$'`), RLS `ENABLE` sin `FORCE`, políticas `*_platform_only` y `*_support_read`, grants a `motorsync_app` (sin `INSERT` ni `DELETE` en `support_accounts`; `UPDATE` solo de `password_hash, must_change_password, temp_password_expires_at, updated_at`) y por columna a `motorsync_support`.
  - `1761000001100-CreateSupportTickets.ts`: `support_tickets` (`number bigint GENERATED ALWAYS AS IDENTITY`, FK compuesta `(tenant_id, user_id) → users (tenant_id, id)`, `verification_note` 1–1000 y `discard_reason` 1–500 tras `btrim`, `support_tickets_state_coherent`), índices `support_tickets_one_open_per_user` (único parcial `WHERE status = 'open'`), `support_tickets_open_inbox_idx` y `support_tickets_tenant_id_idx`; `support_ticket_events`; `help_request_throttle` (`request_count BETWEEN 1 AND 21`); trigger `support_tickets_guard`; trigger append-only de eventos con `audit_log_immutable()`; políticas `TO motorsync_support`; `REVOKE ALL … FROM PUBLIC`; políticas `tenants_support_lookup` y `users_support_lookup` y los `GRANT SELECT (…)` por columna.
  - `1761000001200-CreateSupportFunctions.ts`: las 7 funciones y los 2 triggers de FR-024. **Lección de `CLAUDE.md`**: `GRANT CREATE ON SCHEMA public TO motorsync_support` alrededor de los `ALTER FUNCTION … OWNER TO motorsync_support`, luego `REVOKE CREATE`, y los `REVOKE ALL … FROM PUBLIC` / `GRANT EXECUTE` **dentro de `SET ROLE motorsync_support; …; RESET ROLE;`** (sin el `SET ROLE` solo emiten un WARNING). El `down()` hace `GRANT CREATE …; SET ROLE motorsync_support;` antes de `DROP TRIGGER`/`DROP FUNCTION`, y `RESET ROLE; REVOKE CREATE …` al final (data-model, "Mantenimiento").

  Deja T002 en verde — implementer-backend

**Checkpoint**: T002 en verde. El modelo de roles, RLS y funciones es el del plan antes de escribir código de aplicación.

## Phase 2: Foundational (PR1)

**Purpose**: configuración, generador de temporales, política de refresh compartida, separación de zonas en el guard, interceptor de soporte y errores. Bloquea US1 y US2.

- [x] T007 [P] Pruebas de configuración en `backend/src/config/env.support.spec.ts` (archivo nuevo; `env.spec.ts` de la 002 no se toca):
  - `loadEnv` falla, nombrando `SUPPORT_JWT_SECRET`, si falta, si tiene menos de 32 caracteres o si es igual a `JWT_SECRET`, en cualquier `NODE_ENV`;
  - con `NODE_ENV=production`, falla si vale lo mismo que el ejemplo de `.env.example`;
  - con un valor válido, `AppEnv.supportJwtSecret` lo expone;
  - las validaciones de la 002 (FR-T01, `AUTH_COOKIE_SECURE`) no cambian.

  — tester
- [x] T008 Implementar `supportJwtSecret` en `backend/src/config/env.ts` (`AppEnv` y `loadEnv`), sin valor por defecto — implementer-backend
- [x] T009 [P] Pruebas del generador en `backend/src/support/temporary-password-generator.spec.ts` (FR-019, decisión 7 del humano):
  - 1000 temporales cumplen `^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$`, tienen 19 caracteres y nunca contienen `0`, `O`, `1`, `I`, `L` ni minúsculas;
  - todas son distintas;
  - pasan la política `IsPassword` de la 002 (8 a 128 caracteres);
  - con un `randomInt` inyectado, cada símbolo se elige con `randomInt(0, 31)` sobre el alfabeto `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (sin sesgo de módulo), y con 31 000 muestras cada símbolo aparece entre 700 y 1300 veces.

  — tester
- [x] T010 Implementar `backend/src/support/temporary-password-generator.ts` con `node:crypto.randomInt` (research R9). Lo usarán el script de operaciones (T026) y la temporal por soporte (T053) — implementer-backend
- [x] T011 [P] Pruebas de la política de refresh y de las cookies:
  - `backend/src/auth/refresh-token-policy.spec.ts` (nuevo): el refresh es base64url de 32 bytes; su hash es SHA-256 hex; la clasificación devuelve `fresh` (sin `rotated_at`), `recently_rotated` (rotado hace menos de 10 s) o `reused` (10 s o más), con el reloj inyectado.
  - `backend/src/auth/cookies.support.spec.ts` (nuevo): la cookie `ms_support_refresh` sale con `HttpOnly`, `Secure` según `AUTH_COOKIE_SECURE`, `SameSite=Strict`, `Path=/api/v1/support/auth` y sin `Max-Age`; su borrado con `Max-Age=0` y el mismo `Path`; `ms_refresh` sigue con `Path=/api/v1/auth` (la `cookies.spec.ts` de la 002 no se toca y debe seguir pasando).

  — tester
- [x] T012 Extraer la lógica pura de `backend/src/auth/sessions.service.ts` a `backend/src/auth/refresh-token-policy.ts` (sin cambio de comportamiento: `auth-session.e2e-spec.ts` de la 002 sigue en verde) y parametrizar nombre y `Path` de la cookie en `backend/src/auth/cookies.ts` (research R4) — implementer-backend
- [x] T013 [P] Pruebas del guard por zona en `backend/src/auth/jwt-auth.guard.support.spec.ts` (nuevo; las dos specs del guard de la 001 y la 002 no se tocan) y del decorador en `backend/src/support/support-area.spec.ts`:
  - ruta de taller con token de taller: igual que hoy; con un token firmado con `SUPPORT_JWT_SECRET` (`aud: motorsync-support`): 403 `FORBIDDEN` y sin `request.user` (US2-AC6);
  - ruta `@SupportArea()` con token de soporte válido: `request.supportAgent = { id, sessionId, name, mustChangePassword }` y **sin** `request.user`; con token de taller: 403 `FORBIDDEN` (US2-AC5); vencido: 401 `TOKEN_EXPIRED`; sin `sid`, sin `aud` correcto o con firma de otro secreto que no es de taller: 401 `UNAUTHORIZED`;
  - un token de soporte sin `sid` se rechaza aunque `AUTH_ALLOW_SESSIONLESS_TOKENS = true` (no hay tokens de soporte sin sesión, R3);
  - una ruta `@SupportArea()` + `@Public()` pasa sin token;
  - `support-area.spec.ts`: `@SupportArea()` deja la metadata `supportArea` leíble con `Reflector`, y **todo controlador declarado en `SupportModule`** la tiene a nivel de clase (se recorre `Reflect.getMetadata('controllers', SupportModule)`; esta parte queda en rojo hasta T029 y se completa con cada controlador nuevo).

  — tester
- [x] T014 Implementar `backend/src/support/support-area.decorator.ts`, `backend/src/support/support-agent.ts` (tipo `SupportAgent`, distinto de `AuthUser`), `backend/src/support/support-access-token.service.ts` (HS256 de 15 minutos con `sub`, `sid`, `name`, `pwd_change` y `aud: 'motorsync-support'`, firmado con `supportJwtSecret`) y la verificación por zona en `backend/src/auth/jwt-auth.guard.ts` (research R3). **Mantener compatible** la construcción del guard que usan las specs de la 001 y la 002 — implementer-backend
- [x] T015 [P] Pruebas del interceptor y del validador de soporte:
  - `backend/src/support/support-session-validator.spec.ts`: ejecuta la sentencia de research R4 sobre `support_sessions`/`support_accounts`; 401 `SESSION_EXPIRED` si la inactividad supera 30 minutos y `SESSION_REVOKED` si la sesión está revocada o la cuenta inactiva (consulta de diagnóstico, como en la 002).
  - `backend/src/support/support-transaction.interceptor.spec.ts`: solo actúa en rutas `@SupportArea()` no públicas; abre la transacción y **nunca** ejecuta `set_config('app.tenant_id', …)`; llama al validador antes del handler; con `must_change_password = true` y sin `@AllowPendingPasswordChange()`: 403 `PASSWORD_CHANGE_REQUIRED`; publica `supportStorage` con `manager`, `agent` e `ip`; `ROLLBACK` si el handler o el validador fallan.
  - `backend/src/database/tenant-transaction.interceptor.support.spec.ts` (nuevo): en una ruta `@SupportArea()` el interceptor del taller no abre transacción ni ejecuta `set_config` (como con `@Public()`).

  — tester
- [x] T016 Implementar `backend/src/support/support-context.ts` (`supportStorage`, `AsyncLocalStorage`), `backend/src/support/support-session-validator.ts`, `backend/src/support/support-transaction.interceptor.ts` (global, `APP_INTERCEPTOR` en `backend/src/app.module.ts`) y la exclusión de `@SupportArea()` en `backend/src/database/tenant-transaction.interceptor.ts`. **Mantener compatible** `new TenantTransactionInterceptor(dataSource)` de la spec de la 001 — implementer-backend
- [x] T017 [P] Pruebas de errores en archivos **nuevos**:
  - `backend/src/common/problem-details.filter.support.spec.ts`: `HELP_RATE_LIMITED` (429), `TICKET_NOT_OPEN` (409) y `ACCOUNT_INACTIVE` (409) se propagan con su `code`; los códigos de la 001 y la 002 no cambian.
  - `backend/src/database/pg-errors.support.spec.ts`: `28000` lanzado por una función `support_*` → 401 `SESSION_REVOKED`; `P0002` → 404 `NOT_FOUND`; `23505` en `users_email_key` lanzado por el trigger `users_email_not_support` → la misma traducción genérica de la 002 (`EMAIL_UNAVAILABLE`), sin mencionar soporte.

  — tester
- [x] T018 Implementar los cambios en `backend/src/common/problem-details.filter.ts` y `backend/src/database/pg-errors.ts` — implementer-backend
- [ ] T019 **Regresión de la 001 y la 002 con el guard y los interceptores nuevos**. Con T002 a T018 en verde:
  - `cd backend && npm run lint && npm test && npm run build && npm run db:bootstrap && npm run db:migrate && npm run test:e2e`;
  - confirmar que **todas** las suites de la 001 y la 002 pasan sin cambios (`jwt-auth.guard*.spec.ts`, `tenant-transaction.interceptor*.spec.ts`, `cookies.spec.ts`, `auth-*.e2e-spec.ts`, `users*.e2e-spec.ts`, `test/db/*.e2e-spec.ts` de la 001 y la 002…);
  - correr dos veces seguidas `npm run test:e2e` (el truncado limpia las tablas nuevas);
  - en local, `npm run test:perf` una vez (p95 < 200 ms: las consultas de la 001 no cambian).

  Si algo falla, detener el PR1 y volver a T012, T014 o T016, sin tocar pruebas — leader

**Checkpoint**: la base de soporte está lista y la 001 y la 002 siguen en verde.

## Phase 3: User Story 1, pedir ayuda con "¿Olvidaste tu contraseña?" (P1) (PR1)

**Goal**: cualquiera, sin sesión, pide ayuda con un correo; se crea o actualiza un ticket solo si el correo es de una cuenta de taller, con la misma respuesta y el mismo tiempo en todos los casos.

**Independent Test**: quickstart §3, tabla "¿Olvidaste tu contraseña?"; e2e `backend/test/auth-forgot-password.e2e-spec.ts`.

- [ ] T020 [P] [US1] Pruebas unitarias:
  - `backend/src/auth/forgot-password-body.pipe.spec.ts`: `{ email, tenantId, userId, ticketId }` → solo `{ email }` normalizado, sin error (US1-AC9); correo ausente → 400 `REQUIRED`; formato inválido o más de 254 caracteres → 400 `INVALID_EMAIL` (US1-AC8); body que no es objeto → 400.
  - `backend/src/auth/forgot-password.service.spec.ts` (reloj y base falsos): llama una sola vez a `support_request_help(email, origin_hash)` con `origin_hash = SHA-256 hex de req.ip`; `accepted` → 202 y `rate_limited` → 429 `HELP_RATE_LIMITED`; **la respuesta nunca sale antes de 400 ms** desde el inicio de la petición (`HELP_RESPONSE_FLOOR_MS`), tampoco con 429 ni si la función lanza (500); si la base tarda más de 400 ms, responde en cuanto termina; nunca registra el correo en el logger.

  — tester
- [ ] T021 [US1] Implementar `backend/src/auth/forgot-password-body.pipe.ts` (class-validator con `whitelist: true, forbidNonWhitelisted: false`) y `backend/src/auth/forgot-password.service.ts` (`withAuthTransaction` sin taller, piso de 400 ms, research R7) — implementer-backend
- [ ] T022 [US1] E2e en `backend/test/auth-forgot-password.e2e-spec.ts` (app con `enableTrustProxyForTests` y `X-Forwarded-For` distinto por grupo de peticiones):
  - **US1-AC1**: ` Ana.Perez@Taller.EC ` → 202 sin body; un ticket `open` de la cuenta de Ana y del taller A con el correo normalizado, `request_count = 1`.
  - **US1-AC2 / SC-003** (estadística, como la de la 002): 20 peticiones por caso para correo inexistente, cuenta activa, cuenta desactivada, cuenta con ticket abierto y cuenta de soporte; todas 202 con body idéntico, ninguna antes de 400 ms, y la mediana de cada caso difiere menos del 25 % de la del caso inexistente.
  - **US1-AC3**: `nadie@ejemplo.ec` → 0 tickets y ninguna fila de ninguna tabla contiene ese correo (búsqueda en `support_tickets`, `support_ticket_events`, `help_request_throttle`, `audit_log`).
  - **US1-AC4 / FR-005**: Ana con una sesión abierta, contraseña no temporal y 2 fallos en `login_attempts`; tras la solicitud, su sesión responde 200 en `GET /auth/me`, su login con la contraseña de siempre da 200 (antes de ese login, `failed_count` sigue en 2), `must_change_password` no cambia y `audit_log` del taller A no tiene filas nuevas.
  - **US1-AC5**: con ticket abierto, otra solicitud no crea otro ticket, sube `request_count` a 2 y `last_requested_at`; con el ticket `resolved` o `discarded`, una solicitud crea un ticket `open` nuevo (y el cerrado no cambia).
  - **US1-AC6**: 20 solicitudes desde la misma IP con correos distintos, existentes o no, y la 21.ª da 429 `HELP_RATE_LIMITED` con body idéntico para un correo existente y uno inexistente, sin crear ni actualizar tickets; tiempos de la 21.ª con correo existente frente a inexistente: medianas con diferencia menor del 25 % (20 muestras cada uno, con `setHelpThrottle` para estar ya en el límite); con `setHelpThrottle(origin, 20, 61)` la siguiente vuelve a 202.
  - **US1-AC7**: 30 solicitudes con el correo de Ana desde 30 IP distintas → todas 202, un único ticket `open` con `request_count` aumentado en 30.
  - **US1-AC8**: correo vacío o inválido → 400 en `email`; no cuenta para el límite (20 inválidas y luego 20 válidas desde la misma IP: las 20 válidas dan 202) y no crea tickets.
  - **US1-AC9 / FR-006**: con `tenantId` del taller B, `userId` de otra cuenta y `ticketId` al azar → 202 y el ticket queda en la cuenta y el taller del correo.
  - **US1-AC10**: el correo de una cuenta de soporte → 202 y ningún ticket.
  - **SC-008 / FR-004 (concurrencia)**: 10 solicitudes simultáneas con el correo de Ana sin ticket previo → exactamente un ticket `open` con `request_count = 10`; 25 simultáneas desde la misma IP → exactamente 20 aceptadas y 5 con 429 (todas contadas).
  - **FR-025**: el admin del taller A no tiene ninguna ruta para ver tickets (`GET /support/tickets` con su token → 403 `FORBIDDEN`).

  — tester
- [ ] T023 [US1] Implementar `POST /auth/forgot-password` (`@Public()`, `@Body(ForgotPasswordBodyPipe)` con el parámetro sin clase, 202 sin body) en `backend/src/auth/auth.controller.ts` y registrar el servicio en `backend/src/auth/auth.module.ts`. Deja T020 y T022 en verde — implementer-backend

## Phase 4: User Story 2, entrar al panel de soporte y atender la bandeja (P1) (PR1)

**Goal**: el operador crea y desactiva cuentas de soporte fuera de la aplicación; el agente entra al panel con las reglas de la 002, ve la bandeja y descarta tickets; ninguna credencial ni token sirve en la zona del otro.

**Independent Test**: quickstart §2 y §3, tabla "Panel de soporte"; e2e `backend/test/support-operations.e2e-spec.ts`, `support-auth.e2e-spec.ts` y `support-tickets.e2e-spec.ts`.

- [ ] T024 [P] [US2] Pruebas del procedimiento de operaciones (research R5). El script exporta `runSupportAccount(argv, { pool, stdout, stderr })`, que las pruebas llaman con el pool del migrator y salidas capturadas:
  - `backend/scripts/support-account.spec.ts` (unitaria): análisis de argumentos; `deactivate`, `reactivate` y `reset-password` sin `--confirm` → error sin tocar la base; sin `DATABASE_MIGRATOR_URL` → error; no existe comando `delete`; correo y nombre inválidos (2–120 caracteres) → error.
  - `backend/test/support-operations.e2e-spec.ts`:
    - **US2-AC1**: `create --name "Pedro Soporte" --email " Pedro@MotorSync.EC "` → cuenta `pedro@motorsync.ec` activa, `must_change_password = true`, vencimiento ≈ ahora + 72 h; la temporal sale **una sola vez** en `stdout`, cumple el formato de T009 y sirve para `POST /support/auth/login`; `stderr` no la contiene; un `create` repetido → error.
    - **FR-024 (operaciones)**: `create` con el correo de una cuenta de taller → error sin crear nada.
    - **FR-024 (sentido inverso, decisión 3 del humano)**: `POST /auth/register` con el correo de una cuenta de soporte → 409 `REGISTRATION_FAILED` con el mismo body que un correo de taller repetido, sin crear el taller; `POST /users` de un admin con ese correo → 409 `EMAIL_UNAVAILABLE` idéntico al de un correo de taller en uso. Ningún body menciona soporte.
    - **US2-AC10 / FR-011**: con 2 sesiones de Pedro, `deactivate --confirm` → ambas dan 401 `SESSION_REVOKED` en su siguiente petición (`revoke_reason = 'deactivated'`) y su login da `INVALID_CREDENTIALS`; la cuenta no se borra y los tickets que descartó siguen mostrando su nombre.
    - `reactivate --confirm` → el login vuelve a funcionar y las sesiones anteriores siguen revocadas.
    - `reset-password --confirm` → temporal nueva de 72 h, sesiones revocadas, fila de `login_attempts` de su correo borrada.
    - `list` → nombre, correo, estado y fecha de alta, sin hashes.
    - **US2-AC2 / SC-009**: `POST`, `PUT`, `PATCH` y `DELETE` sobre `/support/accounts`, `/support/agents`, `/support/auth/register` y `/support/accounts/{id}/reactivate`, con token de soporte, de taller y sin token → 404 (o 403 con token de taller en rutas existentes), y `countRows('support_accounts')` no cambia.

  — tester
- [ ] T025 [P] [US2] E2e de acceso al panel en `backend/test/support-auth.e2e-spec.ts` (cuentas con `createSupportAccount`):
  - **US2-AC3**: login correcto → 200 con `agent`, token cuyo payload tiene `sub`, `sid`, `name`, `pwd_change`, `aud = motorsync-support` y **no** `tenant_id` ni `role`, fila nueva en `support_sessions` y `Set-Cookie: ms_support_refresh=…; Path=/api/v1/support/auth; HttpOnly; Secure; SameSite=Strict`, sin `Max-Age`. Correo inexistente, contraseña incorrecta y cuenta `inactive` → 401 `INVALID_CREDENTIALS` con body idéntico, y medianas de 20 intentos de inexistente frente a contraseña incorrecta con diferencia menor del 25 % (estadística). 5 fallos seguidos → 429 `ACCOUNT_LOCKED`, también con la contraseña correcta; con `setLockedUntil` en el pasado vuelve a entrar.
  - **US2-AC4 / FR-010**: el login no pide ningún otro dato; con dos `X-Forwarded-For` distintos (con `enableTrustProxyForTests`) las mismas credenciales dan el mismo resultado.
  - **FR-009 (temporal inicial)**: con `must_change_password = true`, `GET /support/tickets` → 403 `PASSWORD_CHANGE_REQUIRED`; `GET /support/auth/me` → 200; `POST /support/auth/password` con la temporal → 200 y token con `pwd_change: false`; nueva de 7 caracteres → `PASSWORD_TOO_SHORT`; igual a la actual → `SAME_PASSWORD`; actual incorrecta → 400 `CURRENT_PASSWORD_INCORRECT`, y 5 seguidas → 429 `ACCOUNT_LOCKED`; con dos sesiones, cambiar desde una revoca la otra (`password_changed`). Con `setSupportTemporaryPasswordExpiry(id, -1)`: el login con la temporal correcta → 401 `TEMPORARY_PASSWORD_EXPIRED` sin contar fallo, y `POST /support/auth/password` en una sesión abierta → 401 `TEMPORARY_PASSWORD_EXPIRED` y revoca la sesión.
  - **US2-AC9**: con `setSupportSessionLastActivity(sid, 29)` → 200; con 31 → 401 `SESSION_EXPIRED`, también en el refresh (borra la cookie). `POST /support/auth/logout` → 204 con `Max-Age=0`; después, el token y la cookie dan 401 `SESSION_REVOKED`; un segundo logout → 204. Refresh: rotación con `Set-Cookie` nuevo; cookie rotada hace 5 s → 409 `REFRESH_CONFLICT`; hace 11 s → 401 `SESSION_REVOKED` y revoca la sesión (`refresh_reuse`); sin `X-Requested-With` → 400.
  - **US2-AC5 (separación, taller → panel)**: con el token de Ana (admin del taller A), cada una de las rutas protegidas de `/support` del contrato que existan en este PR (`auth/me`, `auth/password`, `tickets`, `tickets/{id}`, `tickets/{id}/discard`) → 403 `FORBIDDEN` sin datos y sin cambios; la cookie `ms_refresh` enviada a `/support/auth/refresh` → 401; las credenciales de Ana en `POST /support/auth/login` → 401 `INVALID_CREDENTIALS`.
  - **US2-AC6 (separación, panel → taller)**: con el token de soporte, `GET /clients/search?q=an`, `GET /vehicles/search?q=PB`, `GET /users`, `GET /users/{id}/history`, `PUT /users/{id}/role`, `POST /users/{id}/deactivate`, `GET /auth/me` y `POST /auth/password` → 403 `FORBIDDEN` sin datos y sin cambios en `users`, `user_sessions` ni `audit_log`; la cookie `ms_support_refresh` enviada a `/auth/refresh` → 401; las credenciales de soporte en `POST /auth/login` → 401 `INVALID_CREDENTIALS`.
  - **US2-AC10 (sesiones)**: con la cuenta desactivada por el migrator, la siguiente petición y el refresh dan 401 `SESSION_REVOKED`.
  - **Concurrencia login ↔ desactivación** (R4): 10 iteraciones de `POST /support/auth/login` en paralelo con `deactivate --confirm` → nunca queda una sesión no revocada de una cuenta `inactive`.

  — tester
- [ ] T026 [US2] Implementar `backend/scripts/support-account.ts` (comandos `create`, `deactivate`, `reactivate`, `reset-password` y `list` de research R5, en una transacción cada uno, con `normalizeEmail`, el generador de T010, el hasher de la 002, `support_workshop_email_exists`, `FOR UPDATE` de la cuenta y `SET ROLE motorsync_auth` para borrar `login_attempts`; la temporal solo por `stdout`) y el script `support:account` en `backend/package.json`. Deja T024 en verde — implementer-backend
- [ ] T027 [US2] Implementar el acceso de soporte: `backend/src/support/support-sessions.service.ts` (crear, rotar con `refresh-token-policy`, podar y revocar sobre `support_sessions`/`support_refresh_tokens`), `backend/src/support/support-auth.service.ts` (login en el orden de la 002 con `PasswordHasher`, hash ficticio y las funciones `auth_login_*` con el hash del correo de soporte; `SELECT … FOR SHARE` de la cuenta y re-comprobación antes de abrir la sesión; refresh, logout, me y cambio de contraseña con `AfterReleaseError` para los fallos), `backend/src/support/support-auth.controller.ts` (`@SupportArea()`; login, refresh y logout `@Public()` con `assertRequestedWith`; me y password con `@AllowPendingPasswordChange()`), `backend/src/support/dto/support-login.dto.ts`, `backend/src/support/support.module.ts` y su registro en `backend/src/app.module.ts`. Deja T025 en verde — implementer-backend
- [ ] T028 [US2] E2e de la bandeja en `backend/test/support-tickets.e2e-spec.ts` (tickets de los talleres A y B con `createTicket` o con `POST /auth/forgot-password`):
  - **US2-AC7 / FR-013**: `GET /support/tickets` devuelve solo los `open` de A y de B, del más antiguo al más reciente; cada elemento tiene **exactamente** las claves `id, number, createdAt, lastRequestedAt, requestCount, account{email, name, role, status}, workshop{name, ruc}` (comparación del conjunto de claves) y fechas ISO 8601 con `Z`.
  - **US2-AC8**: descartar guarda un evento con el agente de la sesión, `occurred_at`, `from_status = open` y `to_status = discarded`; el ticket sale de la bandeja.
  - **US2-AC11 / FR-017**: `PUT`/`PATCH`/`POST` sobre `/support/tickets/{id}/account`, `/support/workshops/{id}`, `/support/users/{id}` y `/support/users/{id}/role` → 404 y `users`/`tenants` sin cambios (`updated_at` igual).
  - **US2-AC12**: motivo `"   "` → 400 `REQUIRED` en `reason` y el ticket sigue `open`; con motivo → 200 `TicketDetail` con `status = discarded` y `discard{reason, discardedByName, discardedAt}`; la cuenta no cambia y `audit_log` del taller no tiene filas nuevas; `reason` de 501 caracteres → 400; `userId` en el body → 400 `UNKNOWN_FIELD`.
  - **US2-AC13**: sobre un ticket `discarded`, otro descarte → 409 `TICKET_NOT_OPEN`; `POST /support/tickets/{id}/reopen` y `PUT /support/tickets/{id}` → 404; nada cambia.
  - **FR-012 / FR-015**: `GET /support/tickets/{id}` de un ticket abierto y de uno cerrado devuelve sus datos y nunca un campo con contraseña; `DELETE /support/tickets/{id}` → 404; id inexistente o no uuid → 404.
  - **Concurrencia (US3-AC12, parte de descarte)**: dos agentes descartan el mismo ticket a la vez → exactamente un 200 y un 409 `TICKET_NOT_OPEN`, un solo evento.
  - **FR-025 / aislamiento**: con el token del admin de A, `GET /support/tickets` → 403 sin datos; ninguna ruta del taller A expone tickets (ni `GET /users/{id}` ni `GET /users/{id}/history` incluyen campos de tickets).

  — tester
- [ ] T029 [US2] Implementar `backend/src/support/support-tickets.service.ts` y `backend/src/support/support-tickets.controller.ts` (`@SupportArea()`; `GET /support/tickets`, `GET /support/tickets/:ticketId`, `POST /support/tickets/:ticketId/discard`; uuid inválido → 404; `not_found` → 404 y `not_open` → 409 `TICKET_NOT_OPEN`; mapper tipado de las filas de `support_list_open_tickets`/`support_get_ticket` al contrato) y `backend/src/support/dto/discard-ticket.dto.ts` (`reason` recortado, "obligatorio; 1–500 caracteres tras recortar", vacío o solo espacios → `REQUIRED`). Deja T028 y la parte de T013 sobre los controladores de `SupportModule` en verde — implementer-backend
- [ ] T030 [P] [US2] Actualizar `backend/scripts/seed-dev.ts`: cuenta de soporte `soporte@motorsync.test` (no temporal en desarrollo, contraseña de desarrollo impresa en consola, idempotente; sigue abortando con `NODE_ENV=production`). Script de desarrollo sin prueba propia (`seed-dev-guard.e2e-spec.ts` de la 002 sigue en verde): se verifica en T043 con quickstart §1 — implementer-backend

## Phase 5: Frontend del PR1 (US1, US2, FR-022)

- [ ] T031 [P] [US1] [US2] Pruebas de API y mock:
  - `frontend/src/app/core/api/auth-api.service.forgot.spec.ts` (nuevo): `forgotPassword(email)` → `POST /api/v1/auth/forgot-password` con body `{ email }` y nada más.
  - `frontend/src/app/core/api/support-api.service.spec.ts`: `login`, `refresh`, `logout`, `me`, `changePassword`, `listOpenTickets`, `getTicket` y `discardTicket` con las rutas y verbos del contrato, `withCredentials` y `X-Requested-With: motorsync` en refresh y logout.
  - `frontend/src/app/core/api/mock-support.store.spec.ts` y `frontend/src/app/core/api/mock-api.interceptor.support.spec.ts` (nuevos), con las reglas del contrato: `forgot-password` siempre 202 (también con correo inexistente o de soporte), 429 `HELP_RATE_LIMITED` a la 21.ª del mismo origen simulado, un único ticket abierto por cuenta de `mock-auth.store.ts` con `requestCount` creciente; login de soporte (`INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` tras 5 fallos, temporal inicial con `PASSWORD_CHANGE_REQUIRED`), refresh, logout idempotente, me y password; bandeja ordenada, detalle, descarte (`REQUIRED`, `TICKET_NOT_OPEN`); separación: token de taller en `/support/**` → 403 `FORBIDDEN` y token de soporte en rutas del taller → 403 `FORBIDDEN`.

  — tester
- [ ] T032 [US1] **FR-022 sobre la 002** (research R12; principio II): cambiar a "Su contraseña temporal venció. Pida al administrador de su taller que la restablezca o use ¿Olvidaste tu contraseña?" los valores `AUTH_MESSAGES.TEMPORARY_PASSWORD_EXPIRED` y `LOGIN_REASON_MESSAGES['temporary-expired']` de `frontend/src/testing/auth-fixtures.ts`, y los comentarios de cabecera que citan el texto en `frontend/src/app/core/api/problem.auth.spec.ts` (línea 12), `frontend/src/app/features/auth/login.page.spec.ts` (línea 23), `frontend/src/app/features/auth/login.page.session.spec.ts` (línea 9) y `frontend/src/app/features/auth/change-password.page.spec.ts` (línea 31, solo comentario). Quedan en rojo **3 pruebas** de la 002: `[US5-AC9] TEMPORARY_PASSWORD_EXPIRED → mensaje de temporal vencida` (problem.auth), `[US5-AC9] 401 TEMPORARY_PASSWORD_EXPIRED → …` (login.page) y el caso `['temporary-expired', '[US5-AC9]']` (login.page.session). Ningún `it()`, aserción ni lógica de esas pruebas cambia. Crear además `frontend/src/testing/support-fixtures.ts` con los textos literales de la spec 003 (FR-003, US1-AC6, US3-AC3, US3-AC5, US3-AC8, FR-022, avisos del panel). **Redactar la nota de justificación para el PR**: "cambio de requisito FR-022 de la spec 003 sobre US5-AC9 de la 002; solo cambia el valor esperado del fixture". El merge exige **aprobación humana explícita** de este cambio — tester
- [ ] T033 [US1] Implementar el texto de FR-022 en `frontend/src/app/core/api/problem.ts` (`TEMPORARY_PASSWORD_EXPIRED`) y en `frontend/src/app/features/auth/login.page.ts` (`'temporary-expired'`), con el enlace "¿Olvidaste tu contraseña?" junto al mensaje. Deja en verde las 3 pruebas de T032 — implementer-frontend
- [ ] T034 [US1] [US2] Implementar los tipos del contrato 003 en `frontend/src/app/core/api/api.models.ts`, `forgotPassword()` en `frontend/src/app/core/api/auth-api.service.ts`, `frontend/src/app/core/api/support-api.service.ts` (parte del PR1), `frontend/src/app/core/api/mock-support.store.ts` y las rutas `/auth/forgot-password` y `/support/**` del PR1 en `frontend/src/app/core/api/mock-api.interceptor.ts`. Deja T031 en verde — implementer-frontend
- [ ] T035 [US1] Pruebas en `frontend/src/app/features/auth/forgot-password.page.spec.ts` y `frontend/src/app/features/auth/login.page.forgot.spec.ts` (nuevos):
  - **US1-AC11 / FR-001**: `/login` muestra el enlace "¿Olvidaste tu contraseña?" debajo del botón de entrar, sin sesión, con objetivo táctil de al menos 44 px; un toque navega a `/forgot-password` y precarga el correo ya escrito.
  - **US1-AC8**: correo vacío o inválido → error en el campo y ninguna petición.
  - **US1-AC1 / FR-003**: tras 202, en lugar del formulario aparece el texto literal de FR-003 (sin prometer canal ni correo).
  - **US1-AC6**: 429 → "Demasiadas solicitudes. Intente de nuevo más tarde".
  - **US1-AC9**: el formulario solo envía `email`.
  - **FR-026**: la página usa el layout mobile-first desde 360 px y sus controles miden al menos 44 px; enlace de vuelta a `/login`; `/forgot-password` lleva `guestGuard`.

  — tester
- [ ] T036 [US1] Implementar `frontend/src/app/features/auth/forgot-password.page.ts` (+ `.html` y `.scss`, mobile-first), la ruta `forgot-password` con `guestGuard` en `frontend/src/app/app.routes.ts` y el enlace en `frontend/src/app/features/auth/login.page.html` — implementer-frontend
- [ ] T037 [P] [US2] Pruebas de sesión del panel:
  - `frontend/src/app/core/support/support-session.store.spec.ts`: se llena desde `SupportSessionResponse` y desde `/support/auth/me`; guarda el token en `localStorage` `motorsync.support.token` (nunca en `motorsync.token`); `clear()` solo borra el suyo.
  - `frontend/src/app/core/support/support.guards.spec.ts`: `supportAuthGuard` sin sesión de soporte → `/support/login` (aunque haya sesión de taller, US2-AC5 en la interfaz); con `mustChangePassword` solo deja pasar `/support/change-password`; `supportGuestGuard` con sesión → `/support`.
  - `frontend/src/app/core/auth/auth-token.interceptor.support.spec.ts` (nuevo): a `/api/v1/support/**` le pone el token de soporte y al resto el del taller; nunca los dos.
  - `frontend/src/app/core/support/support-refresh.interceptor.spec.ts`: igual que `auth-refresh.interceptor` de la 002 (un solo refresh con 3 peticiones fallidas a la vez, `REFRESH_CONFLICT` → un reintento, `SESSION_EXPIRED` → `/support/login?reason=expired`, `SESSION_REVOKED` → `/support/login?reason=revoked`, `PASSWORD_CHANGE_REQUIRED` → `/support/change-password`) contra `/support/auth/refresh`, solo para URLs del panel, sin temporizadores.
  - `frontend/src/app/core/auth/auth-refresh.interceptor.support.spec.ts` (nuevo): el interceptor del taller ignora las URLs `/api/v1/support/**`.

  — tester
- [ ] T038 [US2] Implementar `frontend/src/app/core/support/support-session.store.ts`, `support.guards.ts` y `support-refresh.interceptor.ts`, ajustar `frontend/src/app/core/auth/auth-token.interceptor.ts` y `auth-refresh.interceptor.ts`, y registrar el interceptor nuevo en `frontend/src/app/app.config.ts` (después de `authTokenInterceptor` y antes de `mockApiInterceptor`) — implementer-frontend
- [ ] T039 [US2] Pruebas de pantallas del panel (PR1):
  - `frontend/src/app/features/support/support-login.page.spec.ts`: **US2-AC3** "Correo o contraseña incorrectos" para `INVALID_CREDENTIALS` y el mensaje de bloqueo de la 002 para `ACCOUNT_LOCKED`; con `mustChangePassword` navega a `/support/change-password`; **US2-AC4** solo campos de correo y contraseña.
  - `frontend/src/app/features/support/support-change-password.page.spec.ts`: reglas de la 002 (actual incorrecta, menos de 8, igual a la actual, confirmación) y vuelta a la bandeja.
  - `frontend/src/app/features/support/support-shell.component.spec.ts`: cabecera "Soporte MotorSync" con el nombre del agente y "Cerrar sesión"; **US2-AC9** al pulsarlo llama a `POST /support/auth/logout`, limpia la sesión de soporte y navega a `/support/login`.
  - `frontend/src/app/features/support/tickets-inbox.page.spec.ts`: **US2-AC7** columnas de creación, última solicitud, solicitudes, correo, nombre, rol, estado, taller y RUC, del más antiguo al más reciente, con fechas en `America/Guayaquil`.
  - `frontend/src/app/features/support/ticket-detail.page.spec.ts`: **US2-AC12** "Descartar" con motivo obligatorio (vacío o solo espacios → error en el campo y sin petición); tras descartar vuelve a la bandeja; **US2-AC13** un ticket cerrado se muestra sin acciones y con sus datos de cierre; `TICKET_NOT_OPEN` → mensaje.
  - `frontend/src/app/app.support.spec.ts` (nuevo): en `/support/**` no se muestra la cabecera del taller; con sesión de taller, `/support` redirige a `/support/login`; con sesión de soporte, `/` redirige a `/login` (US2-AC5, US2-AC6 en la interfaz); las rutas del panel se cargan de forma diferida; **FR-026** objetivos táctiles de 44 px.

  — tester
- [ ] T040 [US2] Implementar `frontend/src/app/features/support/support-shell.component.*`, `support-login.page.*`, `support-change-password.page.*`, `tickets-inbox.page.*` y `ticket-detail.page.*` (ver y descartar), las rutas hijas diferidas de `/support` en `frontend/src/app/app.routes.ts` y la ocultación de la cabecera del taller en `frontend/src/app/app.ts` / `app.html` — implementer-frontend

## Cierre PR1

- [ ] T041 Actualizar `CLAUDE.md`:
  - comandos: `npm run support:account -- create|deactivate|reactivate|reset-password|list` (y `access-log`, que llega en el PR3), con `--confirm` y la temporal impresa una sola vez;
  - arranque: volver a correr `npm run db:bootstrap` al actualizar desde una versión anterior a la 003 (rol `motorsync_support`); `SUPPORT_JWT_SECRET` obligatoria en `.env` (copiar de `.env.example`, al menos 32 caracteres y distinta de `JWT_SECRET`; la API no arranca sin ella);
  - el seed crea `soporte@motorsync.test`; el panel en `/support/login`; `token:dev` no emite tokens de soporte;
  - "Lecciones": ampliar la de `SET ROLE` a las funciones `support_*` y a los triggers de FR-024 (dueño `motorsync_support`, data-model 003, "Mantenimiento").

  — leader
- [ ] T042 Revisar el diff del PR1 contra spec.md, plan.md (Constitution Check) y la **constitución 1.3.0**. Foco:
  - principio I (1.3.0): las funciones del panel son `SECURITY DEFINER` de `motorsync_support`, con `search_path` fijo, compuerta de sesión y de contexto, columnas mínimas y sin `BYPASSRLS`; el panel nunca fija taller; `forgot-password` no toma nada del cliente;
  - separación de zonas en ambos sentidos (secreto propio, `aud`, `@SupportArea()` en todo controlador de `src/support/`, interceptor global, cookies con `Path` distinto);
  - la app no puede crear, renombrar, reactivar ni desactivar cuentas de soporte (privilegios);
  - piso de 400 ms en todos los caminos de `forgot-password`; ningún correo inexistente guardado; ninguna contraseña, hash ni temporal en respuestas, logs ni `stdout` salvo la impresión única del script;
  - migraciones con el `SET ROLE motorsync_support` de la lección;
  - las pruebas de la 001 y la 002 no se tocaron, salvo T003 y T032 (FR-022), con su justificación en el PR y la aprobación humana pendiente;
  - ningún `any` sin justificar;
  - pruebas con ID para US1-AC1 a AC11, US2-AC1 a AC13, FR-022, FR-024 (ambos sentidos) y SC-008.

  — reviewer
- [ ] T043 Verificar el PR1:
  - `cd backend && npm run lint && npm test && npm run build && npm run db:bootstrap && npm run db:migrate && npm run test:e2e` (las e2e estadísticas de tiempo de T022 y T025 en CI; en Windows pueden dar falsos positivos, plan riesgo 4);
  - `npm run test:perf` en local una vez (las consultas de la 001 no cambian; CI lo corre igual);
  - `cd frontend && npm run lint && npm test -- --watch=false && npm run build`;
  - quickstart §0 a §2 y §3, tablas "¿Olvidaste tu contraseña?" y "Panel de soporte" (incluido `db:seed:dev` con la cuenta de soporte y las comprobaciones con `psql`);
  - arrancar la API sin `SUPPORT_JWT_SECRET` y con `SUPPORT_JWT_SECRET = JWT_SECRET` y comprobar que no arranca;
  - navegador: `/login` → "¿Olvidaste tu contraseña?" en un teléfono de 360 px y en una tablet (un toque, 44 px); panel `/support/**` en computadora y tablet, con `ng serve --configuration mock` y con backend (quickstart §5, pasos 1, 2 sin la temporal y 5);
  - confirmar que el PR incluye la nota de FR-022 (T032) y pedir la aprobación humana de ese cambio;
  - CI en verde.

  — leader

---

# PR2: contraseña temporal por soporte (US3)

Al terminar, el agente genera la temporal de la cuenta de un ticket abierto con su nota de verificación; la cuenta queda con la regla de temporales de la 002, el ticket Resuelto y un registro en la auditoría del taller afectado, con soporte como actor.

## Phase 6: Base del PR2

- [ ] T044 [P] E2e de BD en `backend/test/db/support-roles-password.e2e-spec.ts` (nuevo):
  - el CHECK `audit_log_actor_role_check` acepta `platform_support` y sigue rechazando otros valores;
  - `support_lock_open_ticket` y `support_resolve_ticket`: `prosecdef = true`, dueño `motorsync_support`, `search_path` fijo, sin `EXECUTE` para `PUBLIC` y con `EXECUTE` para `motorsync_app`;
  - `support_lock_open_ticket` con sesión válida y sin taller devuelve `tenant_id, user_id, number, status` (también para un ticket cerrado) y 0 filas con un id inexistente; con el taller fijado o sin sesión válida lanza `28000`;
  - `support_resolve_ticket`: con el taller del ticket fijado y nota → devuelve `resolved_at`, deja el ticket `resolved` con la nota recortada y `resolved_by` = la cuenta de la sesión, e inserta el evento `temporary_password_generated`; con nota de solo espacios lanza `22023`; **sin taller fijado o con el taller B fijado** para un ticket de A lanza `55000` sin cambios; sobre un ticket ya `resolved` lanza `55000`.

  — tester
- [ ] T045 Crear `backend/src/database/migrations/1761000001300-AllowSupportAuditActor.ts` y `1761000001400-CreateSupportPasswordFunctions.ts` con el DDL de data-model.md **literal** (incluido `support_resolve_ticket … RETURNS timestamptz`), con el `GRANT CREATE` / `SET ROLE motorsync_support` / `RESET ROLE` / `REVOKE CREATE` de la lección también en `down()`, y registrarlas en `backend/src/database/data-source.ts`. Deja T044 en verde — implementer-backend
- [ ] T046 [P] Pruebas unitarias del núcleo compartido y de la auditoría:
  - `backend/src/users/apply-temporary-password.spec.ts` (manager falso): ejecuta, en este orden, la revocación de las sesiones del objetivo con `revoke_reason = 'password_reset'` y `RETURNING id`, el `UPDATE users` (hash, `must_change_password = true`, vencimiento a 72 h, `updated_by`, `updated_by_name`), y `auth_clear_login_failures`; devuelve `sessionsClosed`, el `mustChangePassword` anterior y el vencimiento; nunca toca `role` ni `status` (US3-AC13).
  - `backend/src/audit/audit.service.support.spec.ts` (nuevo): `recordAsSupport(manager, agent, ip, entry)` escribe con el manager recibido, `actor_user_id` = id del agente, `actor_name` = su nombre (nunca su correo), `actor_role = platform_support`, `channel = support_panel`, `reason = NULL`; `record()` de la 001 no cambia.

  — tester
- [ ] T047 Implementar `backend/src/users/apply-temporary-password.ts`, usarlo en `UsersService.resetPassword` de `backend/src/users/users.service.ts` **sin cambio de comportamiento** (las e2e `users*.e2e-spec.ts` de la 002 siguen en verde sin tocarse), ampliar `AUDIT_ACTIONS` con `user.password_reset_by_support` y `AuditActorRole = AuthRole | 'platform_support'` en `backend/src/audit/audit-log.entity.ts`, y agregar `recordAsSupport` en `backend/src/audit/audit.service.ts`. Ajustar el mapper del historial de `UsersService` al `UserAuditEntry` ampliado del contrato — implementer-backend

## Phase 7: User Story 3, generar una contraseña temporal sobre un ticket abierto (P1) (PR2)

**Goal**: el agente genera la temporal de la cuenta de un ticket abierto, con nota, en una sola transacción y con auditoría en el taller afectado.

**Independent Test**: quickstart §3, tabla "Temporal por soporte"; e2e `backend/test/support-password.e2e-spec.ts` y `support-password-concurrency.e2e-spec.ts`.

- [ ] T048 [US3] E2e en `backend/test/support-password.e2e-spec.ts` (Ana, única admin del taller A, con 2 sesiones y bloqueada por intentos; Luis, asesor de A; Marta, del taller B):
  - **US3-AC1**: `POST /support/tickets/{id}/temporary-password` con nota → 200; la contraseña anterior da `INVALID_CREDENTIALS`; `must_change_password = true` y vencimiento ≈ ahora + 72 h; las 2 sesiones dan 401 `SESSION_REVOKED` en su siguiente petición; la fila de `login_attempts` de Ana desaparece; ticket `resolved` con la nota recortada, `resolved_by` y el evento `temporary_password_generated`.
  - **US3-AC2**: la respuesta trae `temporaryPassword` con el formato del contrato, `temporaryPasswordExpiresAt`, `sessionsClosed = 2` y `ticket` con `status = resolved` y `resolution`, y el header `Cache-Control: no-store`. La cadena de la temporal **no aparece** en: `GET /support/tickets/{id}`, `GET /support/tickets`, `GET /users/{id}/history` y `GET /users/{id}` del admin, ninguna fila de `support_tickets`, `support_ticket_events` ni `audit_log`, ni la salida capturada del `Logger` de Nest y de `process.stdout`/`stderr` durante la prueba. Una segunda generación → 409 `TICKET_NOT_OPEN`.
  - **US3-AC3 / FR-023**: sin `verificationNote`, vacía o `"   "` → 400 `REQUIRED` en `verificationNote` y nada cambia (contraseña, sesiones, auditoría, ticket `open`); nota de 1001 caracteres → 400. Con nota, la nota está en el ticket y **no** en ningún campo de `audit_log`.
  - **US3-AC4**: con la temporal tal cual, `POST /auth/login` → 200 con `pwd_change: true`, y `GET /vehicles/search?q=PB` → 403 `PASSWORD_CHANGE_REQUIRED` hasta `POST /auth/password`; la temporal sin guiones o en minúsculas → 401 `INVALID_CREDENTIALS`; con `setTemporaryPasswordExpiry(id, -1)` → 401 `TEMPORARY_PASSWORD_EXPIRED`.
  - **US3-AC5**: Luis sin ticket abierto (nunca tuvo, `resolved` o `discarded`) → con el id de su ticket cerrado, 409 `TICKET_NOT_OPEN`; con un id de ticket inexistente, 404; nada cambia.
  - **US3-AC6 / FR-020 / SC-007**: exactamente un registro en `audit_log` del taller A con `tenant_id = A`, `actor_user_id` = id del agente, `actor_name` = nombre del agente, `actor_role = platform_support`, `action = user.password_reset_by_support`, `entity_type = user`, `entity_id` = Ana, `before.mustChangePassword` con el valor anterior, `after = { mustChangePassword: true, temporaryPasswordExpiresAt, sessionsClosed: 2, supportTicketNumber }`, `occurred_at` UTC, `ip` y `channel = support_panel`; ningún campo contiene la temporal, la contraseña anterior, el hash ni la nota; `GET /users/{id}/history` del admin lo devuelve con `actorRole = platform_support` y sin el correo del agente; ningún registro en el taller B.
  - **US3-AC8**: ticket abierto de una cuenta desactivada → 409 `ACCOUNT_INACTIVE`, nada cambia y el ticket sigue `open`; también si la cuenta se desactiva después de crear el ticket.
  - **US3-AC9**: `userId` o `tenantId` (de A o de B) en el body → 400 `UNKNOWN_FIELD` sin efectos; la temporal solo afecta a la cuenta del ticket (las demás cuentas de A y las de B conservan su hash).
  - **US3-AC10 / FR-025**: tras la operación, las cuentas, sesiones y `audit_log` del taller B no cambian (conteo y `updated_at`).
  - **US3-AC13**: el rol y el estado de Ana no cambian y el taller A conserva su admin activo (sin `LAST_ADMIN`); `users.updated_by_name` = "Soporte MotorSync (<nombre del agente>)".
  - **Separación**: con el token del admin de A → 403 `FORBIDDEN` y nada cambia; con la sesión de soporte con temporal pendiente → 403 `PASSWORD_CHANGE_REQUIRED`.

  — tester
- [ ] T049 [US3] E2e de concurrencia y atomicidad en `backend/test/support-password-concurrency.e2e-spec.ts` (cada caso 10 iteraciones con peticiones paralelas reales; ninguna respuesta 500 ni error `40P01` en ninguna; aserción explícita del orden de locks de research R9 en la cabecera del archivo):
  - **US3-AC7**: con un trigger temporal del migrator que rechaza el `UPDATE` de `support_tickets` (creado en `beforeEach` y borrado en `afterEach`), la generación responde 500 y no cambian la contraseña, las sesiones, `login_attempts`, `audit_log` ni el ticket; lo mismo con un trigger que rechaza el `INSERT` en `support_ticket_events` (fallo después de la auditoría).
  - **US3-AC11 (frente al restablecimiento del administrador)**: a la vez, la temporal de soporte para Luis y `POST /users/{Luis}/password-reset` del admin de A → ambas 200; exactamente dos registros en `audit_log` de A (`user.password_reset_by_support` y `user.password_reset`); Luis sin sesiones abiertas; exactamente **una** de las dos temporales sirve para el login (la de la operación aplicada última, según el orden de `occurred_at`).
  - **US3-AC12 (dos agentes)**: dos agentes generan a la vez sobre el mismo ticket → exactamente un 200 y un 409 `TICKET_NOT_OPEN`, un registro de auditoría y un evento; **generar frente a descartar**: exactamente una de las dos se completa y el ticket queda `resolved` o `discarded` con sus datos coherentes; si ganó el descarte, la contraseña de Luis no cambió.
  - **Frente a `POST /auth/password` del propio Luis** (orden de locks: él toma advisory → su sesión → `users`; soporte, sesión de soporte → ticket → advisory → sesiones → `users`): a la vez, Luis cambia su contraseña y el agente genera su temporal → sin deadlock; al terminar Luis tiene `must_change_password = true` (la temporal de soporte vigente) y ninguna sesión abierta; si el cambio de Luis respondió 200, la sesión que conservó queda revocada; si respondió 401 `SESSION_REVOKED`, su contraseña no cambió; exactamente un registro `user.password_reset_by_support`.
  - **Frente al login de Luis** (lock compartido de la 002): a la vez, `POST /auth/login` de Luis con su contraseña anterior y la generación → si el login dio 200, esa sesión queda revocada al terminar.
  - **Frente a "¿Olvidaste tu contraseña?" de la misma cuenta**: a la vez, la generación y una solicitud de ayuda con el correo de Luis → nunca hay dos tickets `open`; o bien la solicitud se contó en el ticket antes de resolverse (`request_count` + 1) o bien creó un ticket `open` nuevo después (US1-AC5); ninguna solicitud se pierde.

  — tester
- [ ] T050 [US3] Implementar `backend/src/support/support-password.service.ts` con los pasos 0 a 9 de research R9 en la transacción de `SupportTransactionInterceptor`: generar la temporal (T010) y su hash **antes** de cualquier lock; `support_lock_open_ticket` (404 / 409 `TICKET_NOT_OPEN`); `support_get_ticket` todavía sin taller (paso 2b); `set_config('app.tenant_id', <tenant del ticket>, true)`; `TENANT_ADMINS_LOCK_SQL`; estado vigente de la cuenta bajo RLS (409 `ACCOUNT_INACTIVE`); `applyTemporaryPassword` con `updated_by_name = "Soporte MotorSync (<nombre>)"`; `AuditService.recordAsSupport`; `support_resolve_ticket`. **No publica `tenantStorage`**. Agregar `POST /support/tickets/:ticketId/temporary-password` a `backend/src/support/support-tickets.controller.ts` con `Cache-Control: no-store`, y `backend/src/support/dto/generate-temporary-password.dto.ts` (`verificationNote` recortada, "obligatoria; 1–1000 caracteres tras recortar", vacía o solo espacios → `REQUIRED`; `forbidNonWhitelisted`). La temporal nunca pasa por el logger. Deja T048 y T049 en verde — implementer-backend

## Phase 8: Frontend del PR2 (US3)

- [ ] T051 [P] [US3] Pruebas en `frontend/src/app/core/api/support-api.service.password.spec.ts` (nuevo: `generateTemporaryPassword(ticketId, verificationNote)` con ruta, verbo y body del contrato) y `frontend/src/app/core/api/mock-api.interceptor.support-password.spec.ts` (nuevo): temporal con el formato del contrato, una sola por ticket (`TICKET_NOT_OPEN` en la segunda), `ACCOUNT_INACTIVE`, `REQUIRED`, `UNKNOWN_FIELD` con `userId`; la temporal actualiza la cuenta de `mock-auth.store.ts` (temporal de 72 h, sesiones cerradas) y agrega al historial un `user.password_reset_by_support` con `actorRole = platform_support` — tester
- [ ] T052 [US3] Implementar `generateTemporaryPassword` en `frontend/src/app/core/api/support-api.service.ts`, la regla en `frontend/src/app/core/api/mock-support.store.ts` y `mock-api.interceptor.ts`, y el `UserAuditEntry` ampliado en `frontend/src/app/core/api/api.models.ts` — implementer-frontend
- [ ] T053 [US3] Pruebas en `frontend/src/app/features/support/ticket-detail.page.password.spec.ts` (nuevo) y `frontend/src/app/features/support/temporary-password.dialog.spec.ts`:
  - **US3-AC3**: campo de nota con la advertencia "No escriba contraseñas en la nota"; "Generar contraseña temporal" deshabilitado sin nota; con nota de solo espacios o con `REQUIRED` del servidor → "Indique cómo verificó la identidad de la persona" en el campo.
  - **US3-AC2**: el diálogo muestra la temporal una sola vez, en fuente monoespaciada, con "Copiar", el aviso "Escríbala tal cual, con los guiones y en mayúsculas" y el aviso de que no se volverá a mostrar; al cerrarlo la temporal no queda en el estado de la página, en el store ni en `localStorage`, y el ticket se ve Resuelto.
  - **US3-AC5**: `TICKET_NOT_OPEN` → "Solo se puede generar una contraseña temporal sobre un ticket abierto".
  - **US3-AC8**: `ACCOUNT_INACTIVE` → "La cuenta está desactivada; el administrador de su taller debe reactivarla".
  - El formulario solo envía `verificationNote` (US3-AC9).

  — tester
- [ ] T054 [US3] Implementar la nota y la generación en `frontend/src/app/features/support/ticket-detail.page.*` y `frontend/src/app/features/support/temporary-password.dialog.*` — implementer-frontend
- [ ] T055 [US3] Pruebas en `frontend/src/app/features/users/user-detail.page.support.spec.ts` (nuevo; la spec de la 002 no se toca): **US3-AC6** un registro `user.password_reset_by_support` se muestra con el actor "Soporte MotorSync (<nombre>)" (spec, Assumptions), sin correo del agente, y la acción "Restablecimiento de contraseña por soporte (ticket #123)" con su fecha en hora de Ecuador — tester
- [ ] T056 [US3] Implementar el actor de soporte y la acción nueva en `frontend/src/app/features/users/user-detail.page.ts` (+ plantilla) — implementer-frontend

## Cierre PR2

- [ ] T057 Revisar el diff del PR2 contra la spec y la **constitución 1.3.0**. Foco:
  - principio I (1.3.0): el tenant sale solo de la fila del ticket leída en la base; el taller se fija solo entre los pasos 3 y 9; `SupportPasswordService` no publica `tenantStorage`; la única escritura de soporte sobre un taller es la temporal de un ticket abierto;
  - principio IV (1.3.0): `user.password_reset_by_support` en la misma transacción que la contraseña, las sesiones, el bloqueo y el cierre del ticket; actor y rol de soporte; sin contraseñas ni nota;
  - orden de locks de research R9 y ningún camino que tome un ticket después del advisory lock;
  - temporal generada antes de los locks, mostrada una vez con `no-store` y nunca en logs;
  - `applyTemporaryPassword` sin cambio de comportamiento para el administrador (e2e de la 002 intactas);
  - migraciones con el `SET ROLE motorsync_support` de la lección;
  - pruebas con ID para US3-AC1 a AC13, FR-019 a FR-021, FR-023, SC-006 y SC-007.

  — reviewer
- [ ] T058 Verificar el PR2: lo mismo que en T043 (lint, unitarias, e2e, perf en local, builds y CI), más quickstart §3, tabla "Temporal por soporte", y §5, pasos 2 a 4 (con mock y con backend) en computadora y tablet para el panel y en 360 px para el cambio de contraseña del taller con la temporal. Confirmar que las e2e de concurrencia (T049) pasan en CI sin `40P01` — leader

---

# PR3: consulta de talleres y bitácora (US4)

Al terminar, el agente busca talleres y ve sus cuentas (solo los campos permitidos), cada consulta de cuentas queda en la bitácora de soporte y la bitácora se consulta en el panel, de solo lectura y filtrable.

## Phase 9: Base del PR3

- [ ] T059 [P] E2e de BD en `backend/test/db/support-roles-access-log.e2e-spec.ts` (nuevo):
  - `support_access_log`: RLS `ENABLE` sin `FORCE`; la app sin ningún privilegio; `motorsync_support` con solo `SELECT, INSERT`; como migrator, `UPDATE` y `DELETE` lanzan la excepción append-only (FR-018);
  - `support_list_workshops`, `support_list_workshop_accounts` y `support_list_access_log`: `prosecdef = true`, dueño `motorsync_support`, `search_path` fijo, sin `EXECUTE` para `PUBLIC` y con `EXECUTE` para la app; `support_list_access_log` es `STABLE` (`provolatile = 's'`);
  - compuertas: sin sesión válida o con un taller fijado, las tres lanzan `28000`;
  - `support_list_workshop_accounts` con un taller existente inserta exactamente un registro (agente de la sesión, taller, `workshop.accounts_viewed`, IP, `support_panel`) y devuelve exactamente sus 9 columnas, solo cuentas de ese taller; con un taller sin cuentas devuelve una fila con las columnas de cuenta en `NULL`; con un taller inexistente lanza `P0002` y no inserta nada;
  - `support_list_access_log` no inserta filas, devuelve exactamente sus 10 columnas (sin correo del agente) en orden `occurred_at DESC` y respeta `LEAST(p_limit, 50)` y los filtros.

  — tester
- [ ] T060 Crear `backend/src/database/migrations/1761000001500-CreateSupportAccessLog.ts` con el DDL de data-model.md **literal** (`action IN ('workshop.accounts_viewed')`, `channel DEFAULT 'support_panel'`, los dos índices, el trigger append-only y las tres funciones), con el `SET ROLE motorsync_support` de la lección también en `down()`, y registrarla en `backend/src/database/data-source.ts`. Deja T059 en verde — implementer-backend

## Phase 10: User Story 4, consultar talleres y sus cuentas (P2) (PR3)

**Goal**: consulta de solo lectura de talleres y de las cuentas de un taller, con bitácora de las consultas de cuentas y una vista de la bitácora en el panel.

**Independent Test**: quickstart §2 (`access-log`) y §3, tabla "Consulta de talleres"; e2e `backend/test/support-workshops.e2e-spec.ts` y `support-access-log.e2e-spec.ts`.

- [ ] T061 [P] [US4] E2e en `backend/test/support-workshops.e2e-spec.ts`:
  - **US4-AC1**: `GET /support/workshops` → `pageSize = 50`, `total` y cada elemento con **exactamente** `id, name, ruc, createdAt`; con 51 talleres, la página 1 trae 50 y la 2 trae 1; `page = 0` → 400.
  - **US4-AC2**: `q=1790012345001`, `q=1790-0123 45001` (prefijo de RUC) y `q=andrade`, `q=ANDRADE`, `q=andradé` encuentran el taller A; `q=%` y `q=_` no devuelven todos los talleres (comodines escapados); `q` de 121 caracteres → 400.
  - **US4-AC3 / FR-016**: `GET /support/workshops/{A}/accounts` → `workshop` con `id, name, ruc, createdAt` e `items` con todas las cuentas de A, activas e inactivas, cada una con **exactamente** `name, email, role, status, hasOpenTicket` (`true` para la cuenta con ticket abierto).
  - **US4-AC4 / FR-017 / SC-004**: ninguna respuesta del panel (bandeja, ticket, talleres, cuentas) contiene claves ni valores de clientes, vehículos, `audit_log`, `password_hash`, sesiones ni `login_attempts` (recorrido recursivo del JSON con datos de negocio sembrados en A y B); `GET /support/workshops/{A}/clients`, `/vehicles`, `/audit` → 404.
  - **US4-AC5**: `GET /support/accounts`, `GET /support/accounts?email=…` y `GET /support/users` → 404.
  - **US4-AC6**: abrir las cuentas de A deja exactamente un registro en `support_access_log` con el agente, A, `occurred_at` UTC, IP y `support_panel`.
  - **US4-AC7**: un uuid de taller inexistente → 404 y sin registro; un id no uuid → 404 y sin registro.
  - **FR-025 / separación**: con el token del admin de A, `GET /support/workshops` y `GET /support/workshops/{B}/accounts` → 403 `FORBIDDEN` sin datos y sin registro en la bitácora.

  — tester
- [ ] T062 [P] [US4] E2e en `backend/test/support-access-log.e2e-spec.ts` (agentes Pedro y Marta; consultas de cuentas de A y B):
  - **US4-AC8 / FR-027**: `GET /support/access-log` → de la más reciente a la más antigua, `pageSize = 50`, cada registro con **exactamente** `id, occurredAt, agent{id, name}, workshop{id, name, ruc}, ip, channel` y sin el correo del agente; `workshopId = A` → solo A; `agentId = Marta` → solo Marta; ambos combinados; un uuid inexistente → página vacía; `workshopId` no uuid → 400; con 51 registros, la página 2 trae 1.
  - **US4-AC9**: `countRows('support_access_log')` igual antes y después de varias consultas a la bitácora; `POST`, `PUT`, `PATCH` y `DELETE /support/access-log` y `/support/access-log/{id}` → 404 sin cambios; con el token del admin de A → 403 `FORBIDDEN`.
  - **FR-027 (operaciones)**: `runSupportAccount(['access-log', '--email', <Pedro>, '--since', <fecha>])` lista solo las consultas de Pedro desde esa fecha, con taller e IP.

  — tester
- [ ] T063 [US4] Implementar `backend/src/support/support-workshops.service.ts` y `support-workshops.controller.ts` (`@SupportArea()`; `GET /support/workshops` y `GET /support/workshops/:workshopId/accounts`; `normalizeDocument` para decidir el prefijo de RUC y escape de `%`, `_` y `\` en el nombre; uuid inválido → 404; `P0002` → 404; las filas con cuenta `NULL` no van a `items`), `backend/src/support/dto/list-workshops.dto.ts` ("1–120 caracteres"; `page` "entero ≥ 1; tamaño fijo 50"), `backend/src/support/support-access-log.service.ts` y `support-access-log.controller.ts` (`GET /support/access-log`), `backend/src/support/dto/list-access-log.dto.ts` (`workshopId` y `agentId` "opcionales, uuid"; `page` "entero ≥ 1; tamaño fijo 50"), su registro en `backend/src/support/support.module.ts`, y el comando `access-log [--email …] [--since …]` en `backend/scripts/support-account.ts`. Deja T061, T062 y la parte de T013 sobre los controladores de `SupportModule` en verde — implementer-backend
- [ ] T064 [P] [US4] Pruebas en `frontend/src/app/core/api/support-api.service.workshops.spec.ts` (nuevo: `listWorkshops(q, page)`, `listWorkshopAccounts(id)` y `listAccessLog({ workshopId, agentId, page })` con rutas y query del contrato) y `frontend/src/app/core/api/mock-api.interceptor.support-workshops.spec.ts` (nuevo): búsqueda por RUC y por nombre sin tildes, 50 por página, cuentas con `hasOpenTicket`, la consulta de cuentas agrega una entrada a la bitácora simulada y la consulta de la bitácora no, filtros combinables, 404 de taller inexistente y 403 con token de taller — tester
- [ ] T065 [US4] Implementar esos métodos en `frontend/src/app/core/api/support-api.service.ts`, los talleres y la bitácora en `frontend/src/app/core/api/mock-support.store.ts` y las rutas en `mock-api.interceptor.ts` — implementer-frontend
- [ ] T066 [US4] Pruebas en `frontend/src/app/features/support/workshops-list.page.spec.ts`, `workshop-accounts.page.spec.ts` y `access-log.page.spec.ts`:
  - **US4-AC1 / US4-AC2**: lista con nombre comercial, RUC y fecha de alta (hora de Ecuador), búsqueda y paginación de 50.
  - **US4-AC3**: cuentas con nombre, correo, rol, estado y "ticket abierto"; enlace "Ver bitácora de este taller" a `/support/access-log?workshopId=…`.
  - **US4-AC7**: 404 → "no encontrado".
  - **US4-AC8**: bitácora con fecha (hora de Ecuador), agente, taller, RUC e IP o canal, de la más reciente a la más antigua; tocar el taller o el agente de una fila agrega el filtro como chip que se puede quitar; ambos filtros combinables.
  - **US4-AC9**: la bitácora no ofrece ninguna acción de edición ni borrado.
  - **FR-026**: objetivos táctiles de 44 px; usable en tablet.

  — tester
- [ ] T067 [US4] Implementar `frontend/src/app/features/support/workshops-list.page.*`, `workshop-accounts.page.*` y `access-log.page.*`, las rutas `/support/workshops`, `/support/workshops/:id` y `/support/access-log` con `supportAuthGuard` en `frontend/src/app/app.routes.ts` y los enlaces en `support-shell.component.*` — implementer-frontend

## Cierre PR3

- [ ] T068 Revisar el diff del PR3 contra la spec y la **constitución 1.3.0**. Foco:
  - principio I (1.3.0), caso (b): funciones de solo lectura, compuertas, columnas de FR-016 y privilegios por columna; ningún listado de cuentas fuera de un taller o un ticket; búsqueda por nombre con comodines escapados;
  - bitácora append-only escrita en la misma llamada que devuelve las cuentas; la vista de la bitácora no se registra y no expone correos de agentes;
  - ningún dato de negocio ni de auditoría del taller en el panel;
  - migración con el `SET ROLE motorsync_support` de la lección;
  - pruebas con ID para US4-AC1 a AC9, FR-016 a FR-018, FR-027 y SC-004.

  — reviewer
- [ ] T069 Verificar el PR3: lo mismo que en T043 (lint, unitarias, e2e, perf en local, builds y CI), más quickstart §2 (`access-log`), §3, tabla "Consulta de talleres", y §5, paso 6, en computadora y tablet (con mock y con backend). Con la 003 completa, recorrer el quickstart entero una vez — leader

---

## Dependencies & Execution Order

- **PR0 (T001, enmienda 1.3.0)**: se integra a `main` **antes que el PR1**. Los reviewers (T042, T057, T068) revisan contra la 1.3.0.
- **PR1 → PR2 y PR1 → PR3**. PR2 y PR3 dependen del PR1 y son independientes entre sí. No liberar el PR1 a producción sin el PR2 (los tickets no se podrían resolver); sí integrarlo a `main`. Si el PR1 resulta demasiado grande, partirlo en PR1a (backend, T002–T030) y PR1b (frontend contra el mock, T031–T040), como en la 002.
- **Dentro del PR1**:
  - Fase 1: T002 y T003 (pruebas) y T004 (leader) en paralelo → T005 → T006 (deja T002 en verde). T004 antes de correr cualquier suite que cargue `loadEnv` con el campo nuevo (T008).
  - Fase 2: pares T007→T008, T009→T010, T011→T012, T013→T014, T015→T016 y T017→T018. T014 necesita T008 (secreto). T016 necesita T014 (`SupportArea`, `SupportAgent`). **T019 (regresión de la 001 y la 002) después de T018 y antes de cualquier tarea de historia.**
  - US1: T020→T021, T022→T023 (necesitan T016 y T018).
  - US2: T024→T026 (necesita T010); T025→T027 (necesita T012, T014, T016); T028→T029 (necesita T027). T030 en paralelo con T027.
  - Frontend: T031→T034; T032→T033; T035→T036 (necesita T034); T037→T038; T039→T040 (necesita T034 y T038). Avanza contra el mock en paralelo con el backend.
  - Cierre: T041, luego T042 → T043.
- **Dentro del PR2**: T044→T045; T046→T047; luego T048 y T049 → T050 (necesita T045 y T047). Frontend: T051→T052 → T053→T054; T055→T056 en paralelo. Cierre: T057 → T058.
- **Dentro del PR3**: T059→T060; luego T061 y T062 → T063. Frontend: T064→T065 → T066→T067. Cierre: T068 → T069.
- Cada par prueba → implementación es secuencial: el implementer empieza cuando la prueba está en rojo por la razón correcta.

## Parallel Examples

```text
PR1 fase 1, a la vez:  T002 (tester), T003 (tester), T004 (leader)
PR1 fase 2, a la vez:  T007, T009, T011, T013, T015, T017 (tester)
PR1 historias:         T020, T022, T024, T025, T028 (tester) mientras implementer-backend hace T021, T023, T026
PR1 frontend:          T031, T032, T035, T037, T039 (tester, contra el mock) mientras implementer-backend hace T027 y T029
PR2, a la vez:         T044, T046, T048, T049, T051, T055 (tester)
PR3, a la vez:         T059, T061, T062, T064 (tester) y luego T066 mientras implementer-backend hace T063
```

## Implementation Strategy

- **MVP = PR1 + PR2** (US1, US2 y US3, las tres P1): con ambos desplegados, un administrador único que olvidó su contraseña vuelve a entrar (SC-001). El PR1 solo se integra a `main`; no se libera sin el PR2.
- **PR3** agrega la consulta de talleres y la bitácora en el panel (US4, P2). Mientras no exista, el agente atiende tickets con los datos de la bandeja.
- Cada PR deja la 001 y la 002 en verde (T019 y las verificaciones de cierre) y es demostrable con su sección del quickstart.
- Limitaciones conocidas entre PRs:
  - En el PR1 el detalle del ticket solo permite ver y descartar; la generación llega con el PR2.
  - Hasta el PR3, `npm run support:account -- access-log` no existe y la bitácora está vacía (la escribe la consulta de cuentas del PR3).

## Trazabilidad de criterios → tareas de prueba

| Criterios | Tareas |
|---|---|
| US1-AC1 a AC10 | T022 (backend); AC3 y AC10 también en T002; AC8 y AC9 también en T020; AC1, AC6, AC8, AC9 en T031 y T035 (frontend) |
| US1-AC11 | T035; verificación manual en 360 px en T043 |
| US2-AC1, AC2, AC10 | T024 (operaciones); AC2 también en T002; AC10 también en T025 |
| US2-AC3 a AC6, AC9 | T025 (backend); AC5 y AC6 también en T013, T037 y T039; AC3, AC4 y AC9 también en T039 |
| US2-AC7, AC8, AC11 a AC13 | T028 (backend), T031 y T039 (frontend); AC8 y AC13 también en T002 |
| US3-AC1 a AC6, AC8 a AC10, AC13 | T048 (backend); AC2, AC3, AC5, AC8 en T053; AC6 en T046 y T055; AC13 también en T046 |
| US3-AC7, AC11, AC12 | T049; AC12 (descarte) también en T028; base en T044 |
| US4-AC1 a AC7 | T061 (backend), T064 y T066 (frontend); AC6 y AC7 también en T059 |
| US4-AC8, AC9 | T062 (backend), T064 y T066 (frontend); base en T059 |
| FR-001 a FR-006 | T020, T022, T035; FR-005 también en T002 |
| FR-007, FR-011 | T024, T002 |
| FR-008 (separación de zonas en ambos sentidos) | T002 (c), T013, T015, T025, T028, T037, T039, T048, T061, T062 |
| FR-009, FR-010 | T025, T039 |
| FR-012 a FR-015 | T028, T002 (h) |
| FR-016 a FR-018, FR-027 | T061, T062, T059 |
| FR-019 | T009, T048, T053 |
| FR-020 | T046, T048, T055 |
| FR-021 (concurrencia y orden de locks) | T049, T028 |
| FR-022 (cambio sobre la 002, principio II) | T032 → T033; aprobación humana en T043 |
| FR-023 | T048, T053 |
| FR-024 (ambos sentidos) | T002 (j), T017, T022 (AC10), T024 |
| FR-025 (aislamiento A/B) | T002 (c), T022, T028, T048 (AC10), T061 |
| FR-026 (360 px, tablet, 44 px) | T035, T039, T066; revisión manual en T043, T058 y T069 |
| SC-001, SC-002 | Medición operativa (tiempo real de atención), sin prueba automática; el flujo completo se recorre en T058 |
| SC-003 | T022 (estadística) |
| SC-004, SC-005 | T061 (AC4), T025, T028, T048 |
| SC-006, SC-007 | T048, T049 |
| SC-008 | T022, T049, T002 (h) |
| SC-009 | T002 (c), T024 |
| SC-010 | T002 (h), T028, T049 |
| Regresión de la 001 y la 002 | T019, T043, T058, T069; `applyTemporaryPassword` en T047 |
| Entorno (`SUPPORT_JWT_SECRET`, bootstrap, `CLAUDE.md`) | T004, T005, T007, T041, T043 |
