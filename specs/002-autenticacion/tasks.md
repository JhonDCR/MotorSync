---

description: "Tareas de 002-autenticacion, agrupadas por PR y por historia, en pares TDD"
---

# Tasks: Autenticación, talleres y usuarios

**Input**: Design documents from `specs/002-autenticacion/`

**Prerequisites**: [plan.md](./plan.md) (aprobado el 2026-10-23), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/openapi.yaml](./contracts/openapi.yaml), [quickstart.md](./quickstart.md)

**Tests**: obligatorios (constitución, principio II).
- Cada tarea de prueba precede a su tarea de implementación y cita los IDs de los criterios que cubre.
- Cada `it()` empieza por el ID del criterio (`US2-AC9 …`) o del requisito (`FR-T01 …`).
- La prueba se entrega **en rojo**; el implementer la pone en verde **sin tocarla**.
- **Las pruebas existentes de la 001 no se modifican.** Los casos nuevos van en archivos nuevos. La única excepción es T002 (fixtures en `backend/test/setup/`), que se justifica en el PR1.

**Organization**: 3 PRs (plan, "Entrega propuesta"). Dentro de cada PR hay una base técnica y luego fases por historia. Antes del PR1 se integra la enmienda de la constitución 1.2.0 (ver Dependencies).

## Format: `[ID] [P?] [Story] Descripción — ruta(s) — agente`

- **[P]**: se puede hacer en paralelo con otras tareas [P] de la misma fase (archivos distintos, sin dependencias pendientes).
- **[USn]**: historia de la spec a la que pertenece.
- **Agentes**:
  - `tester`: solo `*.spec.ts`, `*.e2e-spec.ts`, `backend/test/**` y `frontend/src/testing/**`.
  - `implementer-backend`: solo `backend/`, sin pruebas.
  - `implementer-frontend`: solo `frontend/`, sin pruebas.
  - `reviewer`: solo lectura.
  - `leader`: `.env.example`, `CLAUDE.md` y la ejecución de las verificaciones.
- Rutas relativas a la raíz del repo.
- **Códigos de error** (contrato):
  - Cuando una tarea dice "400 `REQUIRED`", "400 `INVALID_RUC`", "400 `UNKNOWN_FIELD`", "400 `SAME_PASSWORD`" o "400 `PASSWORD_TOO_SHORT`", la respuesta es `400` con `code = VALIDATION_ERROR` y ese valor en `errors[].code` del campo.
  - `CURRENT_PASSWORD_INCORRECT` va en `code` (400) y además en `errors[]` del campo `currentPassword`.
  - El resto de códigos del esquema `Problem` (por ejemplo `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `LAST_ADMIN`) van en `code`.
- **Tiempo simulado**: las e2e no esperan 15 ni 30 minutos ni 72 horas. Escriben las fechas con el migrator, mediante los helpers de T002: `last_activity_at`, `temp_password_expires_at`, `login_attempts.locked_until` y `refresh_tokens.rotated_at`.

---

# PR1: base, registro e inicio de sesión (US1, US2)

Al terminar, un taller se registra y su gente inicia sesión con correo y contraseña. La sesión se valida en cada request (revocación y rol vigente), y toda la 001 sigue en verde con los tokens de desarrollo.

## Phase 1: Setup (PR1)

**Purpose**: rol `motorsync_auth`, migraciones y funciones `SECURITY DEFINER`, fixtures y variables de entorno.

- [x] T001 Escribir la e2e de BD que demuestra el diseño de `motorsync_auth` (research R1, data-model) en `backend/test/db/auth-roles.e2e-spec.ts`. Usa conexiones como `motorsync_app` (`DATABASE_URL`) y como `motorsync_migrator`. Las cuentas se siembran con los fixtures de T002. Debe comprobar:
  - (a) En `pg_roles`, `motorsync_auth` tiene `rolcanlogin = false`, `rolbypassrls = false` y `rolinherit = false`. `pg_has_role('motorsync_app', 'motorsync_auth', 'MEMBER')` es `false`. `SET ROLE motorsync_auth` como app falla con *permission denied*.
  - (b) Las 7 funciones `auth_*`:
    - tienen `prosecdef = true`, dueño `motorsync_auth` y `proconfig` con `search_path=pg_catalog, public, pg_temp`;
    - `has_function_privilege('motorsync_app', …, 'EXECUTE')` es `true`;
    - no conceden `EXECUTE` a `PUBLIC` (aclexplode de `proacl`).
  - (c) **FORCE RLS sigue aplicando**:
    - `relrowsecurity` y `relforcerowsecurity` son `true` en `users`, `user_sessions` y `refresh_tokens`;
    - `tenants` tiene `relrowsecurity = true` y `relforcerowsecurity = false`;
    - el migrator sin `app.tenant_id` ve 0 filas en `users`, porque FORCE alcanza al dueño.
  - (d) **`motorsync_app` no puede leer `users` sin tenant**:
    - sin `set_config`, `SELECT count(*) FROM users`, `user_sessions` y `refresh_tokens` devuelven 0 aunque haya filas en A y B;
    - con el tenant A no se ven filas de B;
    - un `INSERT` en `users` con `tenant_id` de B bajo A falla por `WITH CHECK`;
    - `DELETE FROM users` da *permission denied*;
    - con el tenant A, `SELECT * FROM tenants` devuelve solo A, y sin tenant 0 filas.
  - (e) `SELECT/INSERT` en `login_attempts` como app dan *permission denied*.
  - (f) **Las funciones ven solo lo que deben**:
    - `auth_find_user_for_login` devuelve exactamente las 8 columnas de data-model y solo la fila de ese correo, de cualquier taller; con un correo inexistente, 0 filas;
    - `auth_find_refresh_token` devuelve exactamente 4 columnas;
    - `auth_clear_login_failures(<cuenta de B>)` con el tenant A fijado no borra la fila de B.
  - (g) `auth_register_workshop`:
    - crea el taller y la cuenta admin y deja `current_setting('app.tenant_id')` igual al taller nuevo;
    - con RUC repetido lanza `23505` en `tenants_ruc_key`;
    - con RUC nuevo y correo repetido lanza `23505` en `users_email_key` y, tras el rollback, no queda el taller (FR-004, US1-AC7);
    - con ambos repetidos, el error es el de `tenants_ruc_key` (US1-AC5).
  - (h) `auth_record_login_failure`: 5 llamadas → `locked_until` no nulo; 10 llamadas concurrentes desde 10 conexiones → `failed_count = 10` y bloqueo (US2-AC9).

  Cubre el principio I, FR-004, FR-022 y US1-AC7 — tester
- [x] T002 [P] Ampliar el arnés e2e (justificar en el PR1: única edición de archivos de prueba existentes).
  - `backend/test/setup/db-fixtures.ts`:
    - agregar `users`, `user_sessions`, `refresh_tokens` y `login_attempts` a `BUSINESS_TABLES`; `truncateBusinessTables` ya tolera tablas inexistentes;
    - `createTenant(name, ruc?)`;
    - `createUser({ tenantId, name, email, role, password, status?, mustChangePassword?, tempPasswordExpiresAt? })`, que inserta como migrator dentro de una transacción con `set_config('app.tenant_id', tenantId, true)`, porque `users` tiene FORCE. Calcula el hash con `node:crypto.scrypt` en el formato `scrypt$32768$8$1$<sal>$<hash>` de research R3, sin importar código de producción;
    - helpers `setSessionLastActivity(sessionId, minutesAgo)`, `setTemporaryPasswordExpiry(userId, hoursFromNow)`, `setLockedUntil(email, minutesFromNow)`, `setRefreshRotatedAt(tokenHash, secondsAgo)`, `readUserSessions(userId)`, `readAuditLog(tenantId, entityId)` y `emailHash(email)` (SHA-256 hex).
  - `backend/test/setup/auth.ts`: `loginAs(app, email, password)`, que devuelve `{ accessToken, refreshCookie, body }`; `refreshCookieFrom(response)`; `withRefreshCookie(cookie)`, que pone los headers `Cookie` y `X-Requested-With: motorsync`; `decodeJwtPayload(token)`.

  — tester
- [x] T003 [P] Añadir a `.env.example`: `AUTH_ALLOW_SESSIONLESS_TOKENS=true`, con el comentario "solo desarrollo y pruebas; la API no arranca con true y NODE_ENV=production (FR-T01)", y `AUTH_COOKIE_SECURE=true` — leader
- [x] T004 Ampliar `backend/db/bootstrap.sql` con el bloque del rol `motorsync_auth` de data-model.md, "Bootstrap", **literal**: `NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT`, `GRANT USAGE ON SCHEMA public TO motorsync_auth`, `GRANT motorsync_auth TO motorsync_migrator WITH INHERIT FALSE, SET TRUE`. Debe seguir siendo idempotente — implementer-backend
- [x] T005 Crear las migraciones con el DDL de data-model.md **literal**:
  - `backend/src/database/migrations/1761000000400-AddTenantRuc.ts`: `ruc text COLLATE "C"` con `CHECK (ruc IS NULL OR ruc ~ '^[0-9]{10}001$')`, `tenants_ruc_key`, RLS `ENABLE` sin `FORCE`, políticas `tenants_self` y `tenants_auth_register`, grants.
  - `1761000000500-CreateUsers.ts`: tabla `users` con `name` de 2 a 120 caracteres, el CHECK de correo normalizado, `role IN ('asesor','admin')`, `status IN ('active','inactive')`, `users_temp_password_coherent`, `users_email_key` global, `users_tenant_admins_idx`, RLS `ENABLE` + `FORCE`, políticas `users_tenant_isolation`, `users_auth_lookup` y `users_auth_register`, `GRANT SELECT, INSERT, UPDATE` sin `DELETE` y grants por columna a `motorsync_auth`. **Sin** el trigger del último administrador, que va en T052.
  - `1761000000600-CreateSessions.ts`: `user_sessions` con `revoke_reason IN ('logout','deactivated','password_changed','password_reset','refresh_reuse','temp_password_expired')` y FK compuestas, y `refresh_tokens` con `token_hash ~ '^[0-9a-f]{64}$'`.
  - `1761000000700-CreateLoginAttempts.ts`.
  - `1761000000800-CreateAuthFunctions.ts`: 7 funciones, `GRANT/REVOKE CREATE ON SCHEMA` alrededor de los `ALTER FUNCTION … OWNER TO motorsync_auth`, `REVOKE ALL … FROM PUBLIC` y `GRANT EXECUTE` a `motorsync_app`. El `down()` hace `SET ROLE motorsync_auth` antes de `DROP FUNCTION` (data-model, "Mantenimiento").

  Registrarlas por referencia de clase en `backend/src/database/data-source.ts`. Deja T001 en verde — implementer-backend

**Checkpoint**: T001 en verde. El modelo de roles y RLS es el del plan antes de escribir código de aplicación.

## Phase 2: Foundational (PR1)

**Purpose**: configuración, identificadores, hasher, guard, interceptor con validación de sesión y errores. Bloquea US1 y US2.

- [x] T006 [P] Pruebas de configuración en `backend/src/config/env.spec.ts` (archivo nuevo):
  - **FR-T01**: `loadEnv` lanza un error que nombra `AUTH_ALLOW_SESSIONLESS_TOKENS` si es `true` y `NODE_ENV=production`; arranca con `true` y `NODE_ENV` igual a `development`, `test` o ausente.
  - `AUTH_ALLOW_SESSIONLESS_TOKENS` vale `false` por defecto.
  - `AUTH_COOKIE_SECURE` vale `true` por defecto.
  - Valores distintos de `true` o `false` dan error.
  - Las validaciones existentes (`JWT_SECRET` ≥ 32 caracteres y demás) no cambian.

  — tester
- [x] T007 Implementar en `backend/src/config/env.ts` los campos `allowSessionlessTokens` y `cookieSecure` en `AppEnv`, la regla FR-T01 y una función `readAuthFlags(source = process.env)` que usan el guard y `cookies.ts`. Fijar `AUTH_ALLOW_SESSIONLESS_TOKENS=true` como valor por defecto **solo en las pruebas**: `test.env` en `backend/vitest.config.ts`, y `process.env.AUTH_ALLOW_SESSIONLESS_TOKENS ??= 'true'` en `backend/vitest.config.e2e.ts` y `backend/vitest.config.perf.ts`, para que las suites de la 001 sigan con tokens sin `sid` (research R9). Deja T006 en verde — implementer-backend
- [x] T008 [P] Pruebas de identificadores en `backend/src/common/identifiers/email.spec.ts`:
  - `normalizeEmail(' Ana.Perez@Taller.EC ')` → `ana.perez@taller.ec`; no toca puntos ni `+`.
  - `isValidEmail` acepta y rechaza vectores fijos, con máximo 254 caracteres.
  - `emailHash('ana@taller.ec')` es igual al SHA-256 hex calculado en la prueba con `createHash`.

  Y en `backend/src/common/validation/is-password.spec.ts`:
  - acepta de 8 a 128 caracteres **Unicode**: `'ñ'.repeat(8)` es válido y 7 emojis no;
  - no recorta espacios;
  - con menos de 8 da `PASSWORD_TOO_SHORT` y con más de 128 `PASSWORD_TOO_LONG`.

  Cubre la base de US1-AC2, US1-AC6, US2-AC2 y FR-005 — tester
- [x] T009 Implementar `backend/src/common/identifiers/email.ts`, `backend/src/common/validation/is-password.ts` y `backend/src/common/validation/is-email-normalized.ts` (transform + validación, como `transforms.ts` de la 001) — implementer-backend
- [x] T010 [P] Pruebas del hasher en `backend/src/auth/password-hasher.spec.ts`:
  - `hash()` produce `scrypt$32768$8$1$<sal>$<hash>` con una sal distinta en cada llamada.
  - `verify()` da `true` con la contraseña correcta y `false` con una incorrecta, con mayúsculas cambiadas o con espacios agregados (US2-AC2).
  - Un hash con formato inválido o alterado devuelve `false` sin lanzar.
  - `verifyAgainstDummy()` siempre da `false` y ejecuta scrypt.
  - Los parámetros se pueden bajar (`N = 2^10`) por inyección para que la prueba sea rápida.

  FR-005, FR-006, FR-008 — tester
- [x] T011 Implementar `backend/src/auth/password-hasher.ts` (research R3): `scrypt` asíncrono, `N = 2^15`, `r = 8`, `p = 1`, `keylen = 64`, `maxmem = 64 MiB`, sal de 16 bytes, `timingSafeEqual`, y un hash ficticio calculado una vez al arrancar — implementer-backend
- [x] T012 [P] Pruebas del guard en un archivo **nuevo**, `backend/src/auth/jwt-auth.guard.sessions.spec.ts`. La spec de la 001 no se toca y debe seguir pasando.
  - Un handler o clase con `@Public()` pasa sin token y sin `request.user`.
  - Los claims `sid` (uuid) y `pwd_change` (booleano) son opcionales y se exponen como `sessionId` y `mustChangePassword`.
  - `sid` no uuid → 401.
  - Un token sin `sid` es 401 `UNAUTHORIZED` con `allowSessionlessTokens = false` y se acepta con `true`.
  - Un token con firma válida y vencido → 401 `TOKEN_EXPIRED`; cualquier otro fallo → 401 `UNAUTHORIZED`.
  - Cubre US2-AC12 y FR-010.

  Y en `backend/src/auth/decorators.spec.ts`: `@Public()`, `@Roles('admin')` y `@AllowPendingPasswordChange()` dejan su metadata leíble con `Reflector` — tester
- [x] T013 Implementar:
  - `backend/src/auth/public.decorator.ts`, `roles.decorator.ts` y `allow-pending-password-change.decorator.ts`;
  - `backend/src/auth/jwt-auth.guard.ts` (`Reflector.getAllAndOverride` sobre handler y clase, `readAuthFlags`, `TOKEN_EXPIRED`);
  - `backend/src/auth/auth-user.ts` (`sessionId?: string`, `mustChangePassword?: boolean`).

  **Mantener compatible** el `Test.createTestingModule({ providers: [JwtAuthGuard] })` de la spec de la 001: inyectar `Reflector` (que Nest provee siempre) y leer las banderas con `readAuthFlags()`, sin un proveedor nuevo obligatorio — implementer-backend
- [x] T014 [P] Pruebas del interceptor en un archivo **nuevo**, `backend/src/database/tenant-transaction.interceptor.sessions.spec.ts`, más `backend/src/auth/session-validator.spec.ts`.
  - Una ruta `@Public()` no abre transacción ni ejecuta `set_config`.
  - Un usuario con `sessionId`:
    - el `SessionValidator` se llama **después** de `set_config` y **antes** del handler;
    - `role` y `name` del contexto se reemplazan por los de la base (FR-014, US4-AC5);
    - si la sesión no está vigente, 401 `SESSION_EXPIRED` (inactividad > 30 min) o `SESSION_REVOKED` (revocada o cuenta inactiva), con `ROLLBACK`.
  - Con `must_change_password = true` y un handler sin `@AllowPendingPasswordChange()`: 403 `PASSWORD_CHANGE_REQUIRED` (FR-026).
  - `@Roles('admin')` con rol vigente `asesor` en la base: 403 `FORBIDDEN`, aunque el token diga `admin` (US4-AC16).
  - Un usuario sin `sessionId` (token de la 001) no llama al validador.

  El validador ejecuta la sentencia de research R6 y distingue los dos códigos con una consulta de diagnóstico — tester
- [x] T015 Implementar `backend/src/auth/session-validator.ts` y ampliar `backend/src/database/tenant-transaction.interceptor.ts` con `@Public`, el validador, `@Roles` y `@AllowPendingPasswordChange`. **Mantener compatible** `new TenantTransactionInterceptor(dataSource)`, que usa la spec de la 001: `Reflector` y `SessionValidator` como parámetros `@Optional()`; sin ellos, el comportamiento es el de la 001 — implementer-backend
- [x] T016 [P] Pruebas de errores en archivos **nuevos**:
  - `backend/src/common/problem-details.filter.auth.spec.ts`: 403 sin `code` → `FORBIDDEN`; 429 sin `code` → `ACCOUNT_LOCKED`.
  - `backend/src/database/pg-errors.auth.spec.ts`: `23505` en `tenants_ruc_key` → 409 `RUC_ALREADY_REGISTERED`; `23505` en `users_email_key` → 409 `EMAIL_UNAVAILABLE`; `23514` en `users_last_admin` → 409 `LAST_ADMIN`.
  - Los códigos de la 001 no cambian.

  — tester
- [x] T017 Implementar los cambios en `backend/src/common/problem-details.filter.ts` (`codeForStatus`) y en `backend/src/database/pg-errors.ts` (traducciones nuevas) — implementer-backend
- [x] T018 **Regresión de la 001 con el guard y el interceptor nuevos**. Con T001 a T017 en verde:
  - correr `cd backend && npm run lint && npm test && npm run build && npm run db:bootstrap && npm run db:migrate && npm run test:e2e`;
  - confirmar que **todas** las suites de la 001 pasan sin cambios: `jwt-auth.guard.spec.ts`, `tenant-transaction.interceptor.spec.ts`, `problem-details.filter.spec.ts`, `pg-errors.spec.ts`, `test/*.e2e-spec.ts`, `test/db/rls.e2e-spec.ts` y `test/db/smoke.e2e-spec.ts`;
  - confirmar que el truncado de `db-fixtures.ts` limpia las tablas nuevas entre suites (correr dos veces seguidas `npm run test:e2e`);
  - en local, `npm run test:perf` una vez (tokens sin `sid`; p95 < 200 ms).

  Si algo falla, detener el PR1 y volver a T013 o T015, sin tocar pruebas — leader

**Checkpoint**: la base de autenticación está lista y la 001 sigue en verde.

## Phase 3: User Story 1, registrar mi taller y mi cuenta de administrador (P1) (PR1)

**Goal**: un visitante registra el taller y su primer administrador y queda con la sesión iniciada.

**Independent Test**: quickstart §2, filas "Registro", "RUC repetido" y "Correo repetido"; e2e `backend/test/auth-register.e2e-spec.ts`.

- [x] T019 [US1] E2e de registro en `backend/test/auth-register.e2e-spec.ts`:
  - **US1-AC1**: 201 con `accessToken`, cuyo JWT tiene `sid` y `pwd_change: false`, `user.role = admin`, `user.mustChangePassword = false` y `workshop.name`. Además `Set-Cookie: ms_refresh=…; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict`, sin `Max-Age`. Con ese token, `GET /api/v1/clients/search?q=an` da 200.
  - **US1-AC2**: el correo ` Ana.Perez@Taller.EC ` se guarda como `ana.perez@taller.ec`.
  - **US1-AC3**: RUC inválido (12 dígitos, sin `001`, tercer dígito 7) → 400 `INVALID_RUC`, sin filas nuevas.
  - **US1-AC4**: RUC repetido, también con espacios o guiones → 409 `RUC_ALREADY_REGISTERED`, sin datos del taller existente en el body.
  - **US1-AC5**: correo repetido con mayúsculas → 409 `REGISTRATION_FAILED` sin `errors[]` sobre `email`; RUC y correo repetidos → `RUC_ALREADY_REGISTERED`.
  - **US1-AC6**: contraseña de 7 caracteres → `PASSWORD_TOO_SHORT`; cada obligatorio faltante → `REQUIRED`; correo inválido → `INVALID_EMAIL`.
  - **US1-AC7**: después de un `REGISTRATION_FAILED` no queda ningún taller con ese RUC (consulta como migrator).
  - **US1-AC8**: 5 registros simultáneos con el mismo RUC → exactamente uno 201 y 4 `RUC_ALREADY_REGISTERED`; lo mismo con el correo y `REGISTRATION_FAILED`.
  - **US1-AC9**: `tenantId` o `role` en el body → 400 `UNKNOWN_FIELD`; `X-Tenant-Id` se ignora.
  - **US1-AC10**: el admin del taller B recién registrado no ve clientes, vehículos ni cuentas del taller A.
  - Ninguna respuesta contiene la contraseña (FR-006).

  — tester
- [x] T020 [US1] Implementar:
  - `backend/src/auth/auth-transaction.ts` (`withAuthTransaction`, research R2, que publica `tenantStorage`);
  - `backend/src/auth/access-token.service.ts` (JWT HS256 de 15 minutos con `sub`, `tenant_id`, `role`, `name`, `sid` y `pwd_change`);
  - `backend/src/auth/sessions.service.ts` (crear la sesión y el refresh token: 32 bytes en base64url, guardado como SHA-256 hex);
  - `backend/src/auth/cookies.ts` (opciones de `ms_refresh` y `setRefreshCookie`);
  - `backend/src/auth/dto/register.dto.ts` (`workshopName` de 2 a 120, `ruc` con `IsEcDocument` en modo RUC, `name` de 2 a 120, `email` normalizado, `password` con `IsPassword`);
  - `backend/src/auth/auth.service.ts` (`register`: llama a `auth_register_workshop` y traduce `users_email_key` a `REGISTRATION_FAILED`);
  - `backend/src/auth/auth.controller.ts` (`POST /auth/register` `@Public()`);
  - `backend/src/auth/auth.module.ts`, registrado en `backend/src/app.module.ts`.

  — implementer-backend

## Phase 4: User Story 2, iniciar sesión con correo y contraseña (P1) (PR1)

**Goal**: un usuario entra con su correo y su contraseña y trabaja con los datos de su taller, con mensajes que no revelan qué correos existen y bloqueo temporal.

**Independent Test**: quickstart §2, filas "Login", "Credenciales malas", "Bloqueo" y "Datos del taller"; e2e `backend/test/auth-login.e2e-spec.ts`.

- [x] T021 [US2] E2e de login en `backend/test/auth-login.e2e-spec.ts`:
  - **US2-AC1**: 200; el token tiene el `tenant_id` y el `role` de la cuenta, y `sid` de una fila nueva en `user_sessions`.
  - **US2-AC2**: correo con espacios y mayúsculas → 200; la contraseña con otra capitalización o con espacios → 401.
  - **US2-AC3**: correo inexistente, contraseña incorrecta y cuenta `inactive` con su contraseña correcta → los tres dan 401 `INVALID_CREDENTIALS` con un body idéntico. Además, con 20 intentos de cada uno, la mediana del caso inexistente y la del caso contraseña incorrecta difieren menos del 25 % (SC-003; prueba marcada como estadística).
  - **US2-AC4**: la cuenta desactivada no crea sesión.
  - **US2-AC5**: 5 fallos y luego la contraseña correcta → 429 `ACCOUNT_LOCKED`.
  - **US2-AC6**: con `setLockedUntil` en el pasado, el login correcto da 200 y la fila de `login_attempts` desaparece.
  - **US2-AC7**: 4 fallos, un acierto y luego un fallo → `failed_count = 1`.
  - **US2-AC8**: un correo inexistente con 5 fallos y un 6.º intento → 429 `ACCOUNT_LOCKED`.
  - **US2-AC9**: 10 intentos fallidos simultáneos → bloqueo; un intento correcto inmediato → 429.
  - **US2-AC10**: `tenantId` o `role` en el body → 400 `UNKNOWN_FIELD`.
  - **US2-AC11**: con la sesión de A, `GET /clients/{id de B}` → 404.
  - **US2-AC12**: `GET /api/v1/vehicles/search?q=PB` sin token → 401.
  - **FR-024**: las rutas de la 001 funcionan con la sesión real. Un asesor con sesión real transfiere un vehículo sin motivo → 400 `REASON_REQUIRED`; un admin con sesión real, sin motivo → 200; el registro de auditoría lleva el `actor_role` leído de la base.
  - **Validación por request (R6)**: si se desactiva la cuenta con el migrator, la siguiente petición con el mismo token da 401 `SESSION_REVOKED`; si se cambia el rol con el migrator, la siguiente petición ve el rol nuevo (base de US4-AC5 y US4-AC6).

  — tester
- [x] T022 [US2] Implementar:
  - `backend/src/auth/login-throttle.service.ts` (`auth_login_locked_until`, `auth_record_login_failure` y `auth_record_login_success`, con `emailHash`);
  - `backend/src/auth/dto/login.dto.ts`;
  - `AuthService.login`, en el orden de research R4: comprobar el bloqueo, buscar la cuenta, verificar siempre con scrypt (hash ficticio si no existe o está inactiva), registrar el fallo o el éxito, fijar el taller y crear la sesión;
  - `POST /auth/login` `@Public()`.

  — implementer-backend
- [x] T023 [P] [US2] Actualizar `backend/scripts/seed-dev.ts` (RUC válido para los talleres A y B, y un admin y un asesor por taller con contraseña de desarrollo impresa en consola; idempotente) y `backend/scripts/issue-dev-token.ts` (aviso si `AUTH_ALLOW_SESSIONLESS_TOKENS` no es `true`). Son scripts de desarrollo sin prueba propia: se verifican en T032 con quickstart §1 — implementer-backend
- [x] T024 [P] [US1] [US2] Pruebas del frontend:
  - `frontend/src/app/core/api/auth-api.service.spec.ts`: `register` y `login` llaman a `POST /api/v1/auth/register` y `/login` con `withCredentials` y propagan el `Problem`.
  - `frontend/src/app/core/api/mock-api.interceptor.auth.spec.ts` (nuevo), para `register` y `login` del mock:
    - 201 o 200 con `SessionResponse`;
    - `RUC_ALREADY_REGISTERED`, `REGISTRATION_FAILED`, `INVALID_CREDENTIALS` y `ACCOUNT_LOCKED` tras 5 fallos;
    - validación de campos.

  — tester
- [x] T025 [US1] [US2] Implementar los tipos del contrato 002 en `frontend/src/app/core/api/api.models.ts`, `frontend/src/app/core/api/auth-api.service.ts` y las rutas `register` y `login` en `frontend/src/app/core/api/mock-api.interceptor.ts` y `mock-api.store.ts` — implementer-frontend
- [x] T026 [US1] Pruebas de `frontend/src/app/features/auth/register.page.spec.ts`:
  - **US1-AC1**: al registrarse guarda `accessToken` en `localStorage` `motorsync.token` y navega a `/`.
  - **US1-AC3**: "RUC inválido" junto al campo, con el validador de `shared/identifiers/ec-document.ts`.
  - **US1-AC4**: "Este RUC ya tiene un taller registrado en MotorSync".
  - **US1-AC5**: "No se pudo completar el registro con estos datos; si ya tiene una cuenta, inicie sesión", sin marcar el campo correo.
  - **US1-AC6**: cada campo obligatorio marcado; contraseña de menos de 8 caracteres.
  - Objetivos táctiles de 44 px (FR-025).

  — tester
- [x] T027 [US1] Implementar `frontend/src/app/features/auth/register.page.ts` (+ `.html` y `.scss`, mobile-first) y la ruta pública `register` en `frontend/src/app/app.routes.ts` — implementer-frontend
- [x] T028 [US2] Pruebas de `frontend/src/app/features/auth/login.page.spec.ts`:
  - **US2-AC1**: guarda el token y navega a `/`; si `user.mustChangePassword`, navega a `/change-password`.
  - **US2-AC3**: "Correo o contraseña incorrectos" para `INVALID_CREDENTIALS`.
  - **US2-AC5**: "Demasiados intentos fallidos. Intente de nuevo en unos minutos".
  - **US5-AC9**: "Su contraseña temporal venció. Pida al administrador de su taller que la restablezca".
  - El formulario no envía `tenantId` ni `role` (US2-AC10).

  — tester
- [x] T029 [US2] Implementar `frontend/src/app/features/auth/login.page.ts` (+ `.html` y `.scss`) y la ruta pública `login` — implementer-frontend

## Cierre PR1

- [ ] T030 Actualizar `CLAUDE.md`:
  - volver a correr `npm run db:bootstrap` tras actualizar (rol `motorsync_auth`);
  - el seed crea usuarios;
  - el login real frente a `token:dev` (`AUTH_ALLOW_SESSIONLESS_TOKENS` y FR-T01);
  - en "Lecciones" o en comandos: las migraciones que cambien funciones `auth_*` deben hacer `SET ROLE motorsync_auth` (data-model, "Mantenimiento").

  — leader
- [ ] T031 Revisar el diff del PR1 contra spec.md, plan.md (Constitution Check) y la **constitución 1.2.0**. Foco:
  - el taller sale solo del JWT o de la base, nunca del cliente;
  - las funciones `SECURITY DEFINER` tienen `search_path` fijo, dueño `motorsync_auth` y columnas mínimas;
  - ninguna contraseña ni hash en respuestas ni logs;
  - las pruebas de la 001 no se tocaron (salvo T002, justificada);
  - ningún `any` sin justificar;
  - pruebas con ID para US1-AC1 a AC10, US2-AC1 a AC12 y FR-T01.

  — reviewer
- [ ] T032 Verificar el PR1:
  - `cd backend && npm run lint && npm test && npm run build && npm run db:bootstrap && npm run db:migrate && npm run test:e2e`;
  - `cd frontend && npm run lint && npm test -- --watch=false && npm run build`;
  - quickstart §1 (incluido `db:seed:dev` con usuarios) y §2, filas "Registro" a "Datos del taller";
  - arrancar la API con `NODE_ENV=production AUTH_ALLOW_SESSIONLESS_TOKENS=true` y comprobar que falla (FR-T01);
  - CI en verde.

  — leader

---

# PR2: sesión, contraseña y frontend (US3, US5)

Al terminar, la sesión se mantiene con actividad, expira a los 30 minutos sin actividad y se cierra a mano. Las contraseñas temporales obligan a cambiarlas y vencen a las 72 h, y el frontend usa la sesión real.

## Phase 5: Base del PR2

- [ ] T033 [P] Pruebas en `backend/src/auth/cookies.spec.ts`:
  - `parseCookies()` con varias cookies, valores con `=`, header ausente o mal formado (no lanza);
  - opciones de `ms_refresh`: `HttpOnly`, `Secure` según `AUTH_COOKIE_SECURE`, `SameSite=Strict`, `Path=/api/v1/auth` y sin `Max-Age`;
  - `clearRefreshCookie` con `Max-Age=0` y el mismo `Path`;
  - `assertRequestedWith(headers)`: sin `X-Requested-With: motorsync` → 400 `VALIDATION_ERROR`.

  — tester
- [ ] T034 Completar `backend/src/auth/cookies.ts` (parser propio, sin `cookie-parser`; research R11) — implementer-backend

## Phase 6: User Story 3, mantener la sesión y cerrarla (P1) (PR2)

**Goal**: la sesión dura mientras hay actividad, expira a los 30 minutos sin actividad y se puede cerrar; una sesión cerrada no sirve para nada.

**Independent Test**: quickstart §2, filas "Refresh" y "Logout", y la técnica de inactividad; e2e `backend/test/auth-session.e2e-spec.ts`.

- [ ] T035 [US3] E2e en `backend/test/auth-session.e2e-spec.ts`:
  - **US3-AC1**:
    - con `setSessionLastActivity(sid, 29)`, una petición da 200 y `last_activity_at` vuelve a ≈ `now()`;
    - repetir el ciclo tres veces, simulando más de 12 h de sesión con actividad, sigue dando 200 (sin duración máxima);
    - `POST /auth/refresh` con la cookie da 200, `Set-Cookie` nuevo y un token cuyo `role` es el vigente.
  - **US3-AC2**: con `setSessionLastActivity(sid, 31)`, una petición da 401 `SESSION_EXPIRED` y el refresh también, borrando la cookie.
  - **US3-AC3**: `POST /auth/logout` da 204 con `Max-Age=0`, y `revoke_reason = 'logout'`.
  - **US3-AC4**:
    - después del logout, el mismo token de acceso da 401 `SESSION_REVOKED` y el refresh con la cookie anterior también;
    - reutilizar una cookie ya rotada (`setRefreshRotatedAt(…, 11)`) da 401 `SESSION_REVOKED` y revoca la sesión entera (`refresh_reuse`);
    - con 5 segundos (ventana de 10 s aprobada) da 409 `REFRESH_CONFLICT` sin revocar.
  - **US3-AC5**: dos logins del mismo usuario; el logout de uno no afecta al otro.
  - **US3-AC6**: un segundo logout, o un logout sin cookie, da 204.
  - **US3-AC7**: el logout de un usuario de A no cambia las sesiones de B; una cookie de B solo puede refrescar la sesión de B.
  - Sin `X-Requested-With` → 400.
  - `GET /auth/me` devuelve `user` y `workshop` del taller propio.
  - Con la cuenta desactivada por el migrator, el refresh da 401 `SESSION_REVOKED` (FR-013).
  - Registrar en el log el p95 de 200 peticiones `GET /auth/me` (quickstart §5, sin umbral).

  — tester
- [ ] T036 [US3] Implementar en `backend/src/auth/sessions.service.ts`:
  - rotación con detección de reutilización y la ventana de 10 s;
  - poda de tokens rotados hace más de 1 día de la misma sesión;
  - revocación.

  En `backend/src/auth/auth.service.ts`: `refresh`, `logout` y `me`. En `backend/src/auth/auth.controller.ts`: `POST /auth/refresh` y `POST /auth/logout` (`@Public()`, con `assertRequestedWith`) y `GET /auth/me` (`@AllowPendingPasswordChange()`) — implementer-backend

## Phase 7: User Story 5, cambiar mi contraseña (P2) (PR2)

**Goal**: todo usuario cambia su contraseña dando la actual; con una temporal está obligado a cambiarla, y vencida no puede entrar.

**Independent Test**: quickstart §2, fila "Temporal"; e2e `backend/test/auth-password.e2e-spec.ts`. Las cuentas temporales se crean con `createUser({ mustChangePassword: true, tempPasswordExpiresAt })` de T002, porque `/users` llega en el PR3.

- [ ] T037 [US5] E2e en `backend/test/auth-password.e2e-spec.ts`:
  - **US5-AC1**: con una temporal vigente, el login da 200 con `pwd_change: true`. Con ese token, `GET /vehicles/search?q=PB`, `GET /clients/search?q=an` y `GET /users` dan 403 `PASSWORD_CHANGE_REQUIRED`; `GET /auth/me` da 200.
  - **US5-AC2**: `POST /auth/password` con la temporal y una nueva válida da 200 con un token `pwd_change: false` que ya accede a `/vehicles/search`; la temporal deja de servir para el login.
  - **US5-AC3**: con dos sesiones, cambiar desde la A deja la B con 401 `SESSION_REVOKED` (`password_changed`), la A sigue y la contraseña anterior da `INVALID_CREDENTIALS`.
  - **US5-AC4**: contraseña actual incorrecta → 400 `CURRENT_PASSWORD_INCORRECT` sin revocar nada; 5 seguidas → 429 `ACCOUNT_LOCKED` en el cambio y en el login de ese correo, y la sesión en curso sigue con 200 en `/auth/me`.
  - **US5-AC5**: nueva de 7 caracteres → `PASSWORD_TOO_SHORT`; igual a la actual → `SAME_PASSWORD`.
  - **US5-AC6**: el dueño registrado en US1 no tiene `pwd_change` y accede a todo.
  - **US5-AC7**: ningún body de respuesta contiene la contraseña actual, la anterior ni la nueva.
  - **US5-AC8**: `userId` en el body → 400 `UNKNOWN_FIELD`.
  - **US5-AC9**:
    - con `setTemporaryPasswordExpiry(userId, -1)`, el login con la temporal correcta da 401 `TEMPORARY_PASSWORD_EXPIRED`, sin fila en `login_attempts`, y con una contraseña incorrecta, `INVALID_CREDENTIALS`;
    - si vence durante la sesión, `POST /auth/password` da 401 `TEMPORARY_PASSWORD_EXPIRED` y revoca la sesión (`temp_password_expired`).

  — tester
- [ ] T038 [US5] Implementar:
  - `backend/src/auth/dto/change-password.dto.ts` (`currentPassword` de 1 a 128 y `newPassword` con `IsPassword`);
  - `AuthService.changePassword`: comprobar el bloqueo, verificar la actual (un fallo cuenta con `auth_record_login_failure`), rechazar `SAME_PASSWORD`, actualizar el hash, `must_change_password = false` y `temp_password_expires_at = NULL`, revocar las otras sesiones (`password_changed`) y emitir un acceso nuevo;
  - la comprobación de vencimiento de la temporal en `AuthService.login`;
  - `POST /auth/password` con `@AllowPendingPasswordChange()`.

  — implementer-backend

## Phase 8: Frontend de sesión (US3, US5) (PR2)

- [ ] T039 [P] [US3] Pruebas en `frontend/src/app/core/auth/session.store.spec.ts` y `frontend/src/app/core/auth/auth.guards.spec.ts`:
  - el store se llena desde `SessionResponse` y desde `/auth/me`, no del JWT;
  - `clear()` borra `motorsync.token`;
  - `authGuard` sin sesión → `/login`;
  - con `mustChangePassword` solo deja pasar `/change-password` (US5-AC1);
  - `adminGuard` con rol `asesor` → `/` (US4-AC16, interfaz).

  — tester
- [ ] T040 [US3] Implementar `frontend/src/app/core/auth/session.store.ts` y `frontend/src/app/core/auth/auth.guards.ts` — implementer-frontend
- [ ] T041 [P] [US3] Pruebas en `frontend/src/app/core/auth/auth-refresh.interceptor.spec.ts`:
  - 401 `TOKEN_EXPIRED` → **un solo** refresh aunque fallen 3 peticiones a la vez, y luego reintento de las 3 con el token nuevo;
  - `REFRESH_CONFLICT` → un reintento;
  - `SESSION_EXPIRED` → `clear()` y `/login?reason=expired`;
  - `SESSION_REVOKED` → `/login?reason=revoked`;
  - 403 `PASSWORD_CHANGE_REQUIRED` → `/change-password`;
  - las llamadas a `/auth/refresh` y `/auth/logout` llevan `withCredentials` y `X-Requested-With: motorsync`;
  - no hay ningún refresh sin una petición del usuario (sin temporizadores; US3-AC2).

  — tester
- [ ] T042 [US3] Implementar `frontend/src/app/core/auth/auth-refresh.interceptor.ts` y registrarlo en `frontend/src/app/app.config.ts`, después de `authTokenInterceptor` y antes de `mockApiInterceptor` — implementer-frontend
- [ ] T043 [US5] Pruebas en `frontend/src/app/features/auth/change-password.page.spec.ts`:
  - **US5-AC1**: con `mustChangePassword` muestra "Debe cambiar su contraseña antes de continuar".
  - **US5-AC2**: al guardar actualiza el token y navega a `/`.
  - **US5-AC4**: "La contraseña actual no es correcta".
  - **US5-AC5**: menos de 8 caracteres, igual a la actual, o confirmación que no coincide (validada en la pantalla) → error en el campo, sin enviar.
  - **US5-AC9**: "Su contraseña temporal venció. Pida al administrador de su taller que la restablezca" y vuelta a `/login`.

  — tester
- [ ] T044 [US5] Implementar `frontend/src/app/features/auth/change-password.page.ts` (+ `.html` y `.scss`) y la ruta `change-password` con `authGuard` — implementer-frontend
- [ ] T045 [US3] Pruebas en `frontend/src/app/app.session.spec.ts` (nuevo) y `frontend/src/app/features/auth/login.page.session.spec.ts` (nuevo):
  - **US3-AC3**: la barra muestra el nombre y el taller, y "Cerrar sesión" a un toque o a dos desde el menú en 360 px (FR-025); al pulsarlo llama a `POST /auth/logout`, limpia la sesión y navega a `/login`.
  - **US3-AC2**: `/login?reason=expired` muestra "Su sesión expiró por inactividad".
  - Las rutas del taller (`''`, `clients`, `vehicles/...`) exigen `authGuard`.
  - `/dev-token` no existe con `isDevMode() = false`.
  - **US3-AC4** (interfaz): después de cerrar sesión, volver con "atrás" a una pantalla del taller redirige a `/login` sin mostrar datos.

  — tester
- [ ] T046 [US3] Implementar la barra en `frontend/src/app/app.ts` y `frontend/src/app/app.html`, el mensaje de `reason` en `login.page.ts` y los guards en `frontend/src/app/app.routes.ts` — implementer-frontend
- [ ] T047 [P] [US3] [US5] Pruebas del mock en `frontend/src/app/core/api/mock-api.interceptor.session.spec.ts` (nuevo): `refresh` (cookie simulada en memoria), `logout` idempotente, `me`, `password` (`CURRENT_PASSWORD_INCORRECT`, `SAME_PASSWORD`) y `PASSWORD_CHANGE_REQUIRED` con una sesión temporal — tester
- [ ] T048 [US3] [US5] Implementar esas rutas en `frontend/src/app/core/api/mock-api.interceptor.ts` y `mock-api.store.ts` — implementer-frontend

## Cierre PR2

- [ ] T049 Revisar el diff del PR2 contra la spec y la constitución 1.2.0. Foco:
  - la cookie con `HttpOnly`, `Secure`, `SameSite=Strict` y `Path`;
  - el refresh token nunca en un body ni en `localStorage`;
  - revocación inmediata en cada caso de FR-013;
  - la ventana de 10 s sin revocar;
  - la temporal solo permite `/auth/me`, `/auth/password` y `/auth/logout`;
  - el frontend sin refresh por temporizador;
  - pruebas con ID para US3-AC1 a AC7 y US5-AC1 a AC9.

  — reviewer
- [ ] T050 Verificar el PR2: lo mismo que en T032, más quickstart §2, filas "Refresh", "Logout" y "Temporal", la técnica de inactividad y §4, pasos 1 a 3, en 360 px y en una tablet. CI en verde — leader

---

# PR3: gestión de usuarios y auditoría (US4)

Al terminar, el administrador gestiona las cuentas de su taller con auditoría, sin quedarse nunca sin administrador activo.

## Phase 9: Base del PR3

- [ ] T051 [P] E2e de BD en `backend/test/db/users-last-admin.e2e-spec.ts` (como `motorsync_app` con el tenant fijado):
  - pasar a `asesor` o a `inactive` al único admin activo y hacer `COMMIT` → error `23514` con `constraint = 'users_last_admin'`, y la fila no cambia;
  - con dos admins, cambiar uno → OK;
  - cambiar a un asesor o a un admin inactivo no dispara la comprobación.

  Respaldo en la base de FR-018 y US4-AC9 — tester
- [ ] T052 Crear `backend/src/database/migrations/1761000000900-AddLastAdminTrigger.ts` con la función `users_require_active_admin()` y el `CONSTRAINT TRIGGER users_keep_active_admin … DEFERRABLE INITIALLY DEFERRED … WHEN (OLD.role = 'admin' AND OLD.status = 'active')` de data-model.md **literal**, y registrarla en `data-source.ts`. Ampliar `AUDIT_ACTIONS` con `user.role_changed`, `user.deactivated`, `user.reactivated` y `user.password_reset`, y `AuditEntityType` con `'user'`, en `backend/src/audit/audit-log.entity.ts` — implementer-backend

## Phase 10: User Story 4, gestionar las cuentas del equipo (P2) (PR3)

**Goal**: el administrador lista, crea (con temporal), cambia de rol, desactiva, reactiva y restablece cuentas de su taller, con auditoría; el asesor no puede.

**Independent Test**: quickstart §2, filas "Equipo" a "Aislamiento"; e2e `backend/test/users.e2e-spec.ts` y `backend/test/users-audit.e2e-spec.ts`.

- [ ] T053 [US4] E2e de gestión en `backend/test/users.e2e-spec.ts` (sesiones reales con `loginAs`):
  - **US4-AC1**: `GET /users` lista las cuentas activas e inactivas del taller, sin `password` ni `passwordHash` en ningún campo.
  - **US4-AC2**: `POST /users` da 201 con `mustChangePassword: true` y `temporaryPasswordExpiresAt` ≈ ahora + 72 h; la persona inicia sesión con la temporal.
  - **US4-AC3**: un correo existente en A o en B, con espacios o mayúsculas, da el mismo 409 `EMAIL_UNAVAILABLE` sin datos de la cuenta.
  - **US4-AC4**: `REQUIRED`, `INVALID_EMAIL`, `PASSWORD_TOO_SHORT` y rol `tecnico` → 400.
  - **US4-AC5**: después de `PUT /users/{id}/role`, la siguiente petición de Luis (sin volver a iniciar sesión) ya puede o ya no puede `GET /users`.
  - **US4-AC6**: Luis con 2 sesiones; tras `deactivate`, ambas dan 401 `SESSION_REVOKED` y su login da `INVALID_CREDENTIALS`.
  - **US4-AC7**: `reactivate` mantiene el rol; el login con la contraseña de siempre da 200; los tokens anteriores siguen con 401.
  - **US4-AC8**: `DELETE /users/{id}` da 404 sin cambios.
  - **US4-AC9**: el único admin no puede quitarse el rol ni desactivarse → 409 `LAST_ADMIN`.
  - **US4-AC10**: dos admins que se desactivan a la vez (peticiones paralelas) → como máximo un 200 y al menos un admin activo.
  - **US4-AC11**: con dos admins, Ana se quita el rol → 200; luego `GET /users` da 403.
  - **US4-AC15**: asignar el mismo rol o desactivar a alguien ya inactivo → 200 sin cambios en `updated_at`.
  - **US4-AC16**: un asesor da 403 `FORBIDDEN` en las 8 operaciones de `/users`, incluida la suya.
  - **US4-AC19**: `tenantId` en el body de `POST /users` → 400 `UNKNOWN_FIELD`.
  - **US4-AC21**:
    - el restablecimiento da 200; la contraseña anterior da `INVALID_CREDENTIALS`;
    - las 2 sesiones dan `SESSION_REVOKED`;
    - con un bloqueo previo (`setLockedUntil`), el login con la temporal da 200 y exige el cambio.
  - **US4-AC22**: restablecer a un inactivo → sigue inactivo y no puede entrar.
  - **US4-AC23**: restablecer la propia cuenta → 409 `SELF_RESET_NOT_ALLOWED`.
  - **FR-020**: después de crear, cambiar el rol o desactivar, la cuenta devuelve `updatedAt` posterior al anterior y `updatedByName` del administrador que actuó.
  - Caso borde "restablecimiento mientras cambia su contraseña": si se restablece primero y luego Luis intenta `POST /auth/password` con la temporal anterior, la respuesta es 401 `SESSION_REVOKED`, porque su sesión ya se cerró; con la temporal nueva, en una sesión nueva, el cambio funciona.

  — tester
- [ ] T054 [P] [US4] E2e de auditoría y aislamiento en `backend/test/users-audit.e2e-spec.ts`:
  - **US4-AC12**: exactamente un registro `user.role_changed` con `tenant_id`, actor, `actor_role = admin`, `entity_type = user`, `before.role`, `after.role`, `occurred_at` UTC, `ip` y `channel`.
  - **US4-AC13**: `user.deactivated` (con `after.sessionsClosed`) y `user.reactivated`, uno de cada uno.
  - **US4-AC14**: un `LAST_ADMIN`, y un fallo forzado en el `UPDATE`, no dejan ni cambio, ni sesiones revocadas, ni registro.
  - **US4-AC15**: una operación sin cambio no crea registro.
  - **US4-AC17**: el admin de A no ve a Marta (B) en la lista, y `GET /users/{id de Marta}` da 404.
  - **US4-AC18**: `role`, `deactivate`, `reactivate` y `password-reset` sobre Marta desde A dan 404, sin cambios, sin sesiones de Marta revocadas y sin registros en A ni en B.
  - **US4-AC20**: `GET /users/{id}/history` solo devuelve registros de A, del más reciente al más antiguo.
  - **US4-AC24**: el registro `user.password_reset` tiene `before.mustChangePassword`, `after.mustChangePassword = true`, `after.temporaryPasswordExpiresAt` y `after.sessionsClosed`; ni el JSON del registro ni ninguna respuesta contienen la contraseña temporal ni la anterior (búsqueda de la cadena).

  — tester
- [ ] T055 [US4] Implementar el módulo de usuarios:
  - `backend/src/users/user.entity.ts`, con `password_hash` excluido de las lecturas (`select: false`).
  - `backend/src/users/dto/create-user.dto.ts` (`name` de 2 a 120, `email` normalizado, `role` en `asesor` o `admin`, `temporaryPassword` con `IsPassword`), `change-role.dto.ts` y `reset-password.dto.ts`.
  - `backend/src/users/users.service.ts`:
    - advisory lock `hashtextextended('users-admins:' || tenant, 0)` y conteo de administradores (research R8);
    - comparación sin cambio (US4-AC15);
    - revocación de sesiones (`deactivated`, `password_reset`) con `RETURNING id` para `sessionsClosed`;
    - `auth_clear_login_failures`;
    - `AuditService.record` en la misma transacción;
    - historial desde `audit_log`.
  - `backend/src/users/users.controller.ts`: las 8 operaciones del contrato con `@Roles('admin')` y uuid inválido → 404.
  - `backend/src/users/users.module.ts`, registrado en `app.module.ts`.

  Deja T053 y T054 en verde — implementer-backend
- [ ] T056 [P] [US4] Pruebas en `frontend/src/app/core/api/users-api.service.spec.ts` (rutas y verbos del contrato) y en `frontend/src/app/core/api/mock-api.interceptor.users.spec.ts` (nuevo): `LAST_ADMIN`, `EMAIL_UNAVAILABLE`, `SELF_RESET_NOT_ALLOWED`, `FORBIDDEN` para asesor y `NOT_FOUND` — tester
- [ ] T057 [US4] Implementar `frontend/src/app/core/api/users-api.service.ts` y las rutas `/users` del mock en `mock-api.interceptor.ts` y `mock-api.store.ts` — implementer-frontend
- [ ] T058 [US4] Pruebas en `frontend/src/app/features/users/users-list.page.spec.ts` y `user-form.page.spec.ts`:
  - **US4-AC1**: lista con nombre, correo, rol y estado.
  - **US4-AC2**: al crear, aviso de que la contraseña es temporal, vence en 72 h y hay que entregarla a la persona.
  - **US4-AC3**: "No se pudo crear la cuenta con este correo. Si la persona ya tiene una cuenta en su taller, búsquela en la lista; si no, use otro correo".
  - **US4-AC4**: campos marcados.
  - **US4-AC16**: la opción "Usuarios" no aparece para el asesor.

  — tester
- [ ] T059 [US4] Implementar `frontend/src/app/features/users/users-list.page.ts` y `user-form.page.ts` (+ plantillas y estilos) y las rutas `users` y `users/new` con `adminGuard` — implementer-frontend
- [ ] T060 [US4] Pruebas en `frontend/src/app/features/users/user-detail.page.spec.ts` y `reset-password.dialog.spec.ts`:
  - **US4-AC5**: cambiar el rol con confirmación.
  - **US4-AC6** y **US4-AC7**: desactivar y reactivar con confirmación.
  - **US4-AC9**: "El taller debe tener al menos un administrador activo".
  - **US4-AC12** y **US4-AC13**: el historial muestra las acciones en español, del más reciente al más antiguo.
  - **US4-AC21**: el diálogo pide la temporal (8 a 128 caracteres) y avisa de que se cerrarán sus sesiones.
  - **US4-AC23**: en la propia cuenta, "Restablecer" no aparece y se ofrece "Para su propia cuenta use Cambiar mi contraseña".

  — tester
- [ ] T061 [US4] Implementar `frontend/src/app/features/users/user-detail.page.ts` y `reset-password.dialog.ts` (+ plantillas y estilos) y la ruta `users/:id` con `adminGuard` — implementer-frontend

## Cierre PR3

- [ ] T062 Revisar el diff del PR3 contra la spec y la **constitución 1.2.0** (principio IV con desactivación, reactivación y restablecimiento). Foco:
  - auditoría en la misma transacción que el cambio y la revocación;
  - append-only;
  - nunca contraseñas ni hashes en `audit_log`;
  - el rol del actor tomado de la base;
  - el advisory lock en toda mutación de rol o estado;
  - ningún endpoint ni botón de borrado;
  - pruebas con ID para US4-AC1 a AC24.

  — reviewer
- [ ] T063 Verificar el PR3: lo mismo que en T032, más quickstart §2 completo y §4 completo (pantallas de usuarios en 360 px y en una tablet). CI en verde — leader

---

## Dependencies & Execution Order

- **Enmienda de la constitución 1.2.0** (PR propio del leader, `docs: amend constitution 1.2.0`, aprobada el 2026-10-23): se integra a `main` **antes que el PR1**. Los reviewers (T031, T049, T062) revisan contra la 1.2.0.
- **PR1 → PR2 → PR3**, en ese orden: cada PR se integra a `main` antes de empezar el siguiente, o en ramas apiladas si el leader lo prefiere.
- **Dentro del PR1**:
  - T001 y T002 (pruebas) y T003 → T004 → T005. T005 deja T001 en verde.
  - Fase 2: pares independientes T006→T007, T008→T009, T010→T011, T012→T013, T014→T015 y T016→T017. T015 depende de T013 (`AuthUser`, decoradores). **T018 (regresión de la 001) va después de T017 y antes de cualquier tarea de historia.**
  - US1: T019→T020 (necesita T009, T011, T015 y T017).
  - US2: T021→T022 (necesita T020: `withAuthTransaction`, sesiones y token).
  - T023 en paralelo con T022.
  - Frontend: T024→T025, luego T026→T027 y T028→T029. Avanza contra el mock en paralelo con el backend.
- **Dentro del PR2**:
  - T033→T034 antes de T036.
  - US3: T035→T036. US5: T037→T038 (necesita T036 por la revocación de "las otras" sesiones).
  - Frontend: T039→T040 y T041→T042 antes de T043 a T046. T047→T048 en paralelo.
- **Dentro del PR3**: T051→T052; luego T053 y T054 → T055; frontend T056→T057 → T058→T059 → T060→T061.
- Cada par prueba → implementación es secuencial: el implementer empieza cuando la prueba está en rojo por la razón correcta.

## Parallel Examples

```text
PR1 fase 1, a la vez:  T001 (tester), T002 (tester), T003 (leader)
PR1 fase 2, a la vez:  T006, T008, T010, T012, T014, T016 (tester)
PR1 historias:         T024, T026, T028 (tester, frontend contra mock) mientras implementer-backend hace T020 y T022
PR2, a la vez:         T033, T039, T041, T047 (tester)
PR3, a la vez:         T051, T054, T056 (tester) y luego T058 mientras implementer-backend hace T055
```

## Implementation Strategy

- **MVP = PR1** (US1 y US2, P1): un taller real se registra y su gente entra. Mientras no exista `/users` (PR3), solo el administrador fundador tiene cuenta; en desarrollo, también los usuarios del seed.
- **PR2** completa US3 (P1) y US5, y conecta el frontend real.
- **PR3** agrega la gestión del equipo (US4, P2).
- Cada PR deja la 001 en verde (T018 y la verificación de cierre) y es demostrable con su sección del quickstart.
- Limitaciones conocidas entre PRs:
  - En el PR1 todavía no hay refresh: el token de acceso dura 15 minutos y luego hay que volver a iniciar sesión. El PR2 lo resuelve.
  - En el PR1 la ruta `/change-password` aún no existe. Solo la necesitan las cuentas temporales, que antes del PR3 solo existen en los fixtures.

## Trazabilidad de criterios → tareas de prueba

| Criterios | Tareas |
|---|---|
| US1-AC1 a AC10 | T019 (backend), T024 y T026 (frontend); AC7 y AC5 también en T001 |
| US2-AC1 a AC12 | T021 (backend), T024 y T028 (frontend); AC9 también en T001; AC12 también en T012 |
| US3-AC1 a AC7 | T035 (backend), T041 y T045 (frontend); base en T014 |
| US4-AC1 a AC11, AC15, AC16, AC19, AC21 a AC23 | T053 (backend), T056, T058 y T060 (frontend); AC9 también en T051; AC5 y AC16 también en T014 y T039 |
| US4-AC12 a AC14, AC17, AC18, AC20, AC24 | T054 |
| US5-AC1 a AC9 | T037 (backend), T043 y T047 (frontend); AC1 también en T014 y T039; AC9 también en T028 |
| FR-T01 (aprobación del plan) | T006; verificación manual en T032 |
| FR-005, FR-006, FR-008 | T008, T010, T019, T021, T037, T054 |
| FR-022, FR-023 (aislamiento, mensajes) | T001 más los casos multi-tenant de T019, T021, T035, T053 y T054 |
| FR-020 (metadatos de la cuenta) | T053 |
| FR-024 (la 001 con la sesión real) | T021, T018 |
| FR-025 (uso en recepción) | T026, T045, T058 y la revisión manual de T050 y T063 |
| Regresión de la 001 | T018, T032, T050, T063 |
