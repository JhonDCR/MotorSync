# Research: Autenticación, talleres y usuarios

**Feature**: `specs/002-autenticacion/spec.md` | **Fecha**: 2026-10-22

Fase 0 del plan. Cada decisión sigue el formato Decisión / Razón / Alternativas. Se parte de lo que la feature 001 ya dejó en `backend/` (research 001 R1–R3): guard global HS256, transacción por request con `set_config('app.tenant_id', …, true)`, `AuditService.record` en la misma transacción, validadores de `src/common/identifiers` y errores `application/problem+json`.

## R1. Búsqueda de la cuenta antes de conocer el taller (principio I)

El login busca la cuenta por correo sin saber el taller, el registro crea un taller, y el refresh busca una sesión por su token. Las tres operaciones cruzan talleres por definición.

**Decisión**: funciones `SECURITY DEFINER` acotadas, como propuso el leader, pero **con un dueño propio**: el rol `motorsync_auth` (`NOLOGIN`, `NOBYPASSRLS`, `NOINHERIT`), no `motorsync_migrator`.

- `users`, `user_sessions` y `refresh_tokens` tienen `tenant_id`, RLS `ENABLE` + `FORCE` y la política normal por `app_current_tenant()`.
- Además, cada tabla tiene **políticas dirigidas solo al rol `motorsync_auth`** (`CREATE POLICY … TO motorsync_auth`). Son de `SELECT`, más `INSERT` en `tenants` y `users` para el registro. Dentro de una función `SECURITY DEFINER`, `current_user` es el dueño, así que esas políticas solo se aplican al código de las funciones.
- `motorsync_auth` solo tiene `GRANT` sobre las columnas que usan las funciones. `motorsync_app` no es miembro de `motorsync_auth`; solo tiene `EXECUTE` sobre las funciones (`REVOKE ALL … FROM PUBLIC`).
- Las funciones tienen `SET search_path = pg_catalog, public, pg_temp`, nombres calificados con `public.` y SQL fijo (sin SQL dinámico).
- Las funciones solo **resuelven la identidad** a partir de un secreto (correo + contraseña verificada en Node, o hash del refresh token) y devuelven lo mínimo, incluido el `tenant_id`. **Todo lo demás** (crear la sesión, rotar tokens, actualizar contadores de la cuenta) lo hace la app **después** de fijar `app.tenant_id` con ese `tenant_id`, bajo las políticas normales.
- Funciones (DDL en [data-model.md](./data-model.md#funciones-security-definer)):
  - `auth_register_workshop(...)`: crea el taller y el primer administrador de forma atómica y fija `app.tenant_id` del taller nuevo en la transacción.
  - `auth_find_user_for_login(email)`.
  - `auth_find_refresh_token(token_hash)`.
  - `auth_login_locked_until(email_hash)`.
  - `auth_record_login_failure(email_hash)`.
  - `auth_record_login_success(email_hash)`.
  - `auth_clear_login_failures(user_id)`: solo actúa si la cuenta pertenece al taller fijado.

**Razón**: la propuesta con dueño `motorsync_migrator` no funciona tal cual. `FORCE ROW LEVEL SECURITY` aplica también al dueño de la tabla, y el migrator es `NOBYPASSRLS` (research 001 R2), así que una función suya vería 0 filas de `users`. Darle `BYPASSRLS` al migrator ampliaría el riesgo a todas las tablas, también a las de negocio de la 001. Un rol dedicado, sin login y con políticas explícitas `TO motorsync_auth`, deja la excepción visible en el catálogo (`pg_policies`), limitada a 3 tablas y a las columnas mínimas, y las pruebas pueden verificarla.

**Alternativas consideradas**:
- Dueño `motorsync_migrator` con `BYPASSRLS`: descartada; abre todas las tablas.
- Rol dueño con `BYPASSRLS`: descartada; es más amplio que las políticas dirigidas y no deja rastro por tabla.
- Política con `OR current_setting('app.auth_lookup') = 'on'`: descartada; la app podría fijar esa variable desde cualquier código.
- Tabla global `user_directory(email, tenant_id)` sin RLS: descartada; duplica datos y necesita sincronización.
- Pedir el taller en el login: descartada por la spec (FR-007).

**Consecuencias operativas**:
- `db/bootstrap.sql` (lo ejecuta el superusuario) crea `motorsync_auth` y concede `GRANT motorsync_auth TO motorsync_migrator WITH INHERIT FALSE, SET TRUE`, para que el migrator pueda hacer `ALTER FUNCTION … OWNER TO motorsync_auth`.
- La migración concede `CREATE ON SCHEMA public` a `motorsync_auth` solo mientras cambia los dueños y lo revoca al terminar.
- El paso `db:bootstrap` de CI y de local ya existe: no cambia el flujo.

## R2. Rutas públicas y fijación del taller

**Decisión**:
- Decorador `@Public()` (`SetMetadata('isPublic', true)`). `JwtAuthGuard` lo respeta vía `Reflector` (`getAllAndOverride` sobre handler y clase).
- `TenantTransactionInterceptor`, ante una ruta pública, **no abre transacción ni fija taller**: llama a `next.handle()` sin más.
- Las rutas públicas son 4: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh` y `POST /auth/logout`.
- Sus servicios usan un helper `withAuthTransaction(fn)` (en `src/auth/auth-transaction.ts`) que:
  1. abre una transacción sin taller;
  2. llama a la función `SECURITY DEFINER`;
  3. fija `set_config('app.tenant_id', <tenant devuelto>, true)`;
  4. publica el contexto en `tenantStorage` con el usuario autenticado y la IP, para que `getManager()` y `AuditService` funcionen igual que en la 001.

**Razón**: el principio I exige que el tenant salga del token autenticado y nunca del cliente. En las rutas públicas la credencial verificada en el servidor (contraseña o refresh token) cumple el papel del token, y el `tenant_id` sale siempre de la base, nunca del body. `forbidNonWhitelisted` sigue rechazando `tenantId` o `role` en los DTOs (US1-AC9, US2-AC10, US4-AC19).

**Alternativas**: un segundo interceptor para rutas públicas (más piezas para lo mismo); excluir las rutas por path (frágil ante cambios de prefijo).

## R3. Almacenamiento de contraseñas

**Decisión**:
- `node:crypto.scrypt` en su versión asíncrona (pool de libuv), con sal aleatoria de 16 bytes por contraseña.
- Parámetros: `N = 2^15`, `r = 8`, `p = 1`, `keylen = 64`, `maxmem = 64 MiB`. Con N y r así, scrypt necesita 128·N·r = 32 MiB, que es el límite por defecto, por eso se sube.
- Formato autodescriptivo en `users.password_hash`: `scrypt$32768$8$1$<sal base64url>$<hash base64url>`. Permite subir los parámetros más adelante sin migrar los datos.
- Comparación con `crypto.timingSafeEqual`.
- **Hash ficticio**: un hash fijo calculado al arrancar. Cuando el correo no existe o la cuenta está desactivada, se verifica la contraseña contra él igual. Así el trabajo y el tiempo son los mismos (FR-008, US2-AC3, SC-003).
- Longitud de 8 a 128 caracteres (FR-005), medida en caracteres Unicode (`[...value].length`). Sin recorte ni normalización.
- Módulo: `src/auth/password-hasher.ts`, con funciones puras e inyectable. Las pruebas unitarias bajan `N` por parámetro.

**Razón**: no agrega dependencias (YAGNI, principio V). scrypt es una KDF resistente a memoria recomendada por OWASP, y con estos parámetros tarda unos 50–100 ms por verificación en una máquina de desarrollo.

**Alternativas**:
- `bcrypt` o `argon2`: dependencias nativas nuevas; argon2id es preferible en teoría, pero no compensa una dependencia nativa en Windows y CI.
- PBKDF2: más débil frente a GPU.

## R4. Bloqueo por intentos fallidos (FR-009)

**Decisión**:
- Tabla global `login_attempts(email_hash text PRIMARY KEY, failed_count, locked_until, updated_at)`.
  - `email_hash` = SHA-256 hex del correo normalizado. No se guardan en claro los correos inexistentes.
  - Sin `tenant_id` (ver Complexity Tracking). `motorsync_app` no tiene ningún privilegio sobre ella; solo la tocan las funciones `SECURITY DEFINER`.
- Flujo del login:
  1. `auth_login_locked_until(hash)`: si hay bloqueo vigente, responde 429 `ACCOUNT_LOCKED` sin calcular scrypt. La respuesta es la misma exista o no el correo (US2-AC8).
  2. Verificación de la contraseña (siempre con scrypt; hash ficticio si hace falta).
  3. Si falla, o la cuenta está desactivada: `auth_record_login_failure(hash)`. Es un upsert atómico:
     - si el bloqueo anterior ya venció, reinicia el contador;
     - si no, suma 1;
     - al llegar a 5, fija `locked_until = now() + 15 min`.

     El bloqueo de fila de `INSERT … ON CONFLICT DO UPDATE` serializa los intentos simultáneos, así que **todos cuentan** (US2-AC9).
  4. Si acierta: `auth_record_login_success(hash)` hace `SELECT … FOR UPDATE` y, si en ese momento hay un bloqueo vigente (otro intento lo creó en paralelo), devuelve `false` y el login responde 429. Si no, borra la fila (contador a cero, US2-AC6, US2-AC7).
- Los fallos de la contraseña actual en `POST /auth/password` usan el mismo par de funciones con el correo de la sesión (US5-AC4). Por la clarificación, no se cierra la sesión en curso.
- Restablecer la contraseña llama a `auth_clear_login_failures(user_id)` (US4-AC21).
- Las filas vencidas se borran de forma oportunista en `auth_record_login_failure` (`DELETE … WHERE locked_until < now() - interval '1 day'`, como máximo 100 por llamada). No hay tarea programada.

**Razón**: la spec exige bloqueo por correo exista o no, robusto ante concurrencia y sin Redis. Una sola fila por correo con upsert atómico es lo más simple que lo garantiza en PostgreSQL.

**Alternativas**:
- Contador en `users`: no cubre correos inexistentes y revela existencia por diferencia de comportamiento.
- Redis o un rate limiter en memoria: es otra pieza de infraestructura y no se comparte entre instancias.
- `@nestjs/throttler`: limita por IP, no por correo.

## R5. Sesión: token de acceso corto, sesión en la base y refresh rotativo

**Decisión**:
- **Sesión** = fila en `user_sessions(id, tenant_id, user_id, created_at, last_activity_at, revoked_at, revoke_reason)`. Es la "familia" de refresh tokens.
- **Token de acceso**:
  - JWT HS256 de **15 minutos**.
  - Claims existentes `sub`, `tenant_id`, `role` y `name`, más `sid` (id de sesión) y `pwd_change` (booleano, FR-026).
  - Va en el body de la respuesta. El frontend lo guarda en `localStorage` (`motorsync.token`), como hoy.
- **Refresh token**:
  - 32 bytes aleatorios en base64url, opaco.
  - Se guarda como SHA-256 en `refresh_tokens(id, tenant_id, session_id, token_hash UNIQUE, created_at, rotated_at)`. SHA-256 sin sal basta porque el token tiene 256 bits de entropía.
  - Viaja solo en la cookie `ms_refresh` (`HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`), sin `Max-Age`.
- **Rotación** en `POST /auth/refresh`:
  1. Se busca el token con `auth_find_refresh_token(hash)` y se fija el taller.
  2. Si la sesión está revocada o lleva más de 30 minutos sin actividad: 401 `SESSION_EXPIRED` y se borra la cookie.
  3. Si el token ya fue rotado (**reutilización**):
     - si la rotación fue hace menos de 10 segundos, se trata como **carrera benigna** entre dos pestañas: 409 `REFRESH_CONFLICT`, sin revocar. El frontend reintenta una vez con la cookie nueva que el navegador ya guardó;
     - si fue hace más, se revoca la sesión entera (`revoke_reason = 'refresh_reuse'`) y se responde 401 `SESSION_REVOKED`.
  4. Si todo está bien, se marca `rotated_at`, se inserta el token nuevo, se actualiza `last_activity_at` y se emite un acceso nuevo con el **rol y el estado actuales de la base**.
- **Inactividad (FR-012)**: se mide en `user_sessions.last_activity_at`, que se actualiza en **cada** request autenticado (R6) y en cada refresh. No hay duración máxima: la cookie no vence y la sesión vive mientras `last_activity_at` tenga menos de 30 minutos.
- El frontend **nunca** refresca en segundo plano por temporizador. Solo refresca cuando una acción del usuario recibe 401 `TOKEN_EXPIRED`, para que la inactividad real cierre la sesión.

**Razón**: cumple lo pedido por el leader (acceso corto + refresh opaco en cookie con rotación y detección de reutilización) y mide la inactividad de forma exacta. Si solo se renovara en el refresh, un usuario que actúa a los 0, 14 y 43 minutos quedaría fuera con solo 29 minutos de inactividad, lo que viola US3-AC1. Por eso la inactividad vive en la sesión y no en el token.

**Alternativas**:
- Medir la inactividad solo con el vencimiento del refresh: inexacto, como se acaba de ver.
- Cookie de sesión clásica sin JWT: cambia el guard de la 001 y todas sus pruebas.
- Refresh en `localStorage`: expuesto a XSS.

## R6. Revocación inmediata y cambio de rol (FR-013, FR-014, FR-019)

Hoy el guard no consulta la base. Si se aceptara la ventana del token de acceso (hasta 15 minutos), una cuenta desactivada o una sesión cerrada podrían seguir actuando, lo que viola FR-013 ("de inmediato"), US4-AC6 y US3-AC4 ("en su siguiente acción").

**Decisión**: validar la sesión **en cada request autenticado**, dentro de la transacción que ya abre `TenantTransactionInterceptor` y después de `set_config`. Lo hace un `SessionValidator` (`src/auth/session-validator.ts`) que llama el interceptor. Es una sola sentencia bajo RLS:

```sql
UPDATE user_sessions s SET last_activity_at = now()
  FROM users u
 WHERE s.id = $sid AND s.user_id = $sub AND u.id = s.user_id
   AND s.revoked_at IS NULL AND u.status = 'active'
   AND s.last_activity_at > now() - interval '30 minutes'
RETURNING u.role, u.name, u.must_change_password, u.temp_password_expires_at
```

- Si no devuelve fila, una consulta de diagnóstico distingue el caso:
  - 401 `SESSION_EXPIRED` si la sesión se cerró por inactividad (mensaje "Su sesión expiró por inactividad");
  - 401 `SESSION_REVOKED` en los demás casos.
- Si devuelve fila, el interceptor **reemplaza `role` y `name` del contexto** por los de la base. Así un cambio de rol vale desde la siguiente acción sin volver a iniciar sesión (US4-AC5), y `reason-policy` de la 001 usa el rol vigente.
- Si la sentencia actualiza `last_activity_at` y luego el request falla, el rollback deshace la actividad. Es aceptable.

**Razón**:
- Agrega una sentencia por request por clave primaria, en una conexión y una transacción que ya existen.
- Da revocación y cambio de rol exactos, sin listas negras en memoria ni Redis.
- La prueba de rendimiento de la 001 (`test:perf`) usa tokens sin `sid` (R9) y no se ve afectada. La prueba e2e de sesión medirá el sobrecosto.

**Alternativas**:
- Validar solo en el refresh y aceptar la ventana de 15 minutos: viola FR-013 y US4-AC6.
- `session_version` en el token comparada en cada request: también consulta la base en cada request y no resuelve la inactividad.
- Token de acceso de 1 minuto: muchos refresh y sigue habiendo ventana.

## R7. Contraseña temporal (FR-026, US5-AC1, US5-AC9)

**Decisión**:
- `users.must_change_password boolean` y `users.temp_password_expires_at timestamptz`, igual a `now() + 72 h` al crear o restablecer.
- CHECK de coherencia: si `must_change_password` es verdadero, la fecha existe, y viceversa.
- Login:
  - con contraseña correcta, temporal y vencida: 401 `TEMPORARY_PASSWORD_EXPIRED`, sin contar fallo y sin crear sesión;
  - con contraseña correcta y temporal vigente: crea la sesión con el claim `pwd_change: true`.
- Restricción: el `SessionValidator` devuelve `must_change_password` de la base. Si es verdadero y el handler no tiene `@AllowPendingPasswordChange()`, el interceptor responde 403 `PASSWORD_CHANGE_REQUIRED`. Solo llevan el decorador `GET /auth/me` y `POST /auth/password`; `logout` ya es pública.
- El claim `pwd_change` solo sirve al frontend para redirigir. La autoridad es la base.
- Si la temporal vence durante la sesión, `POST /auth/password` responde 401 `TEMPORARY_PASSWORD_EXPIRED` y revoca la sesión actual (caso borde de la spec).

**Razón**: la base es la fuente de verdad (igual que en R6) y el decorador deja explícitas y auditables en revisión las únicas dos rutas permitidas.

**Alternativas**: solo el claim (un token emitido antes de un restablecimiento no reflejaría el cambio); un guard aparte (correría antes de la validación de sesión en la base).

## R8. Autorización de administrador y último administrador

**Decisión**:
- `@Roles('admin')` en `UsersController`. El interceptor lo aplica **después** de refrescar el rol desde la base (R6). Si no corresponde: 403 `FORBIDDEN` ("No tiene permisos para gestionar usuarios", US4-AC16).
- Un guard de roles no sirve aquí: los guards de Nest corren antes de los interceptores y verían el rol del token, no el vigente.
- Último administrador (FR-018, US4-AC9, US4-AC10): toda mutación de rol o estado toma primero `pg_advisory_xact_lock(hashtextextended('users-admins:' || tenant_id, 0))`. Luego cuenta los administradores activos del taller bajo RLS y rechaza con 409 `LAST_ADMIN` si el cambio deja 0. El lock serializa las operaciones del mismo taller (dos administradores que se desactivan a la vez) sin bloquear a otros talleres.
- Defensa en la base: un trigger `CONSTRAINT … DEFERRABLE INITIALLY DEFERRED` en `users` comprueba al confirmar que el taller afectado conserva al menos un administrador activo. Así un olvido en el código no deja un taller sin administrador.
- Operaciones sin cambio real (US4-AC15): el servicio compara con el valor actual y responde 200 con la cuenta, sin `UPDATE` ni auditoría.
- Restablecer la propia cuenta (US4-AC23): 409 `SELF_RESET_NOT_ALLOWED`.

**Alternativas**: `SELECT … FOR UPDATE` sobre los administradores activos (funciona en READ COMMITTED, pero es más difícil de razonar); aislamiento `SERIALIZABLE` (reintentos en toda la API).

## R9. Compatibilidad con la feature 001 y los tokens de desarrollo

**Decisión**:
- El guard sigue aceptando los claims de la 001. `sid` y `pwd_change` son **opcionales** en el token.
- Un token **sin `sid`** (de `issueTestToken` o `npm run token:dev`) solo se acepta si `AUTH_ALLOW_SESSIONLESS_TOKENS=true`. En ese caso no hay validación de sesión y el rol es el del claim, exactamente como hoy.
  - `loadEnv` lo lee con valor por defecto `false`.
  - `.env.example` y el job de CI lo ponen en `true`.
  - En producción queda en `false` (supuesto de la spec: el acceso de desarrollo deja de aceptarse fuera de desarrollo).
  - `token:dev` avisa si la variable no está activa.
- Con eso las suites de la 001 siguen igual, sin crear filas en `users`.
- `tenants` gana la columna `ruc` **nullable** (con `UNIQUE` y `CHECK` de forma). Los fixtures (`createTenant(name)`), `seed-dev` y `seed-volume.sql` insertan talleres sin RUC y siguen funcionando. `auth_register_workshop` exige el RUC.
- `truncateBusinessTables` agrega `users`, `user_sessions`, `refresh_tokens` y `login_attempts` a su lista (ya tolera tablas inexistentes).
- `audit_log.actor_user_id` no tiene FK (001), así que la auditoría con actores de tokens de prueba sigue siendo válida.

**Alternativas**: obligar a todas las pruebas de la 001 a iniciar sesión de verdad (reescribe cerca de 10 suites y viola "ninguna suite de la 001 debe romperse").

## R10. Auditoría de cuentas (principio IV)

**Decisión**:
- Acciones nuevas en `AUDIT_ACTIONS`: `user.role_changed`, `user.deactivated`, `user.reactivated` y `user.password_reset`. `entity_type = 'user'`.
- Valores de `before` y `after`:
  - cambio de rol: `{ role }`;
  - activación: `{ status }`;
  - restablecimiento: `before: { mustChangePassword }`, `after: { mustChangePassword: true, temporaryPasswordExpiresAt, sessionsClosed }`.
- **Nunca** se guarda un hash ni una contraseña (FR-006, US4-AC24). Una prueba unitaria del servicio y una e2e recorren el JSON del registro buscando la contraseña usada.
- Sin motivo (`reason` es `NULL`). El actor es siempre administrador, así que el CHECK `audit_log_asesor_reason` de la 001 no interfiere.
- Todo pasa por `AuditService.record` en la transacción del request, junto con el `UPDATE` de la cuenta y la revocación de sesiones (US4-AC14).
- Consulta: `GET /users/{id}/history` (solo administrador) devuelve los registros de esa cuenta, del más reciente al más antiguo, bajo RLS (US4-AC12, US4-AC13, US4-AC20).
- No se auditan el login, los fallos, los bloqueos ni el cambio de la propia contraseña (clarificación del 2026-10-22).

**Constitución**: la versión 1.1.0 lista "cambios de rol de usuarios", pero **no** la desactivación, la reactivación ni el restablecimiento de contraseña. **Se recomienda la enmienda MINOR 1.2.0**, como en la 001 (IV-a): agregar al principio IV "desactivación y reactivación de cuentas de usuario y restablecimiento de contraseña por un administrador". Alternativa: justificarlo como ampliación compatible, porque el principio fija un mínimo y no prohíbe auditar más. Decide el humano (ver plan, IV-a). Este plan no edita la constitución.

## R11. Cookies, CORS y CSRF

**Decisión**:
- Mismo origen: el frontend llama a `/api/v1` a través del proxy de `ng serve` (`proxy.conf.json`), y en producción detrás del mismo dominio. **No se habilita CORS** (`enableCors` no se llama) y el refresh no necesita `credentials: 'include'`. Las llamadas a `/api/v1/auth/*` usan `withCredentials: true` por claridad; es inocuo en mismo origen.
- Cookie `ms_refresh`: `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`. Al cerrar sesión o al fallar el refresh se borra con el mismo `Path`.
  - Navegadores modernos aceptan `Secure` en `http://localhost`.
  - Para entornos de prueba manual sin HTTPS fuera de localhost existe `AUTH_COOKIE_SECURE=false`, con `true` por defecto.
  - supertest lee `Set-Cookie` sin importar `Secure`.
- Lectura de la cookie: una función propia de unas 15 líneas (`src/auth/cookies.ts`) que parsea el header `Cookie`. No se agrega `cookie-parser` (YAGNI). Para escribirla se usa `res.cookie()` de Express, que ya está.
- CSRF:
  - `SameSite=Strict` impide que otro sitio envíe la cookie.
  - El refresh devuelve el token de acceso en el body, que un sitio ajeno no puede leer sin CORS.
  - `POST /auth/refresh` y `POST /auth/logout` exigen además el header `X-Requested-With: motorsync`, que un formulario de otro sitio no puede poner.
- La IP (`req.ip`) se toma como en la 001: hoy no hay `trust proxy` configurado, así que detrás del proxy de desarrollo será la del proxy. Configurar `trust proxy` para producción queda para el despliegue y no cambia el contrato.

## R12. Respuestas que no revelan datos (FR-008, FR-023)

**Decisión**: códigos de error del contrato:
- `INVALID_CREDENTIALS` (401). Lo comparten el correo inexistente, la contraseña incorrecta y la cuenta desactivada.
- `ACCOUNT_LOCKED` (429, sin `Retry-After` específico de la cuenta).
- `TEMPORARY_PASSWORD_EXPIRED` (401). Solo con la contraseña correcta.
- `RUC_ALREADY_REGISTERED` (409). Explícito y sin datos del taller.
- `REGISTRATION_FAILED` (409). Genérico, para un correo ya usado en el registro.
- `EMAIL_UNAVAILABLE` (409). Genérico, para un correo ya usado al crear una cuenta.
- `LAST_ADMIN` (409), `SELF_RESET_NOT_ALLOWED` (409), `FORBIDDEN` (403), `PASSWORD_CHANGE_REQUIRED` (403).
- `TOKEN_EXPIRED`, `SESSION_EXPIRED`, `SESSION_REVOKED` (401), `REFRESH_CONFLICT` (409).
- `CURRENT_PASSWORD_INCORRECT` (400, con `errors[]` en `currentPassword`).
- Más los existentes: `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`.

Detalles:
- Las violaciones de unicidad se traducen en `pg-errors.ts`: `tenants_ruc_key` → `RUC_ALREADY_REGISTERED`, `users_email_key` → `REGISTRATION_FAILED` o `EMAIL_UNAVAILABLE` según el endpoint. La función de registro inserta primero el taller, así que con RUC y correo duplicados gana el mensaje del RUC (US1-AC5).
- `ProblemDetailsFilter.codeForStatus` hoy convierte 403 y 429 en `VALIDATION_ERROR`. Se agrega 403 → `FORBIDDEN` y 429 → `ACCOUNT_LOCKED`. Ninguna respuesta de la 001 usa 403 ni 429, así que es compatible.
- El guard distingue `TOKEN_EXPIRED` (firma válida y vencido) de `UNAUTHORIZED` (cualquier otro fallo), para que el frontend sepa cuándo refrescar.
- Los mensajes en español de la spec los muestra el frontend a partir del `code`. La API no incluye textos que revelen datos.
- Tiempos: el hash ficticio (R3) iguala el trabajo. La prueba e2e compara la mediana de 20 intentos con correo inexistente contra 20 con contraseña incorrecta, con una tolerancia del 25 %. Se marca como prueba estadística.

## R13. Frontend

**Decisión**:
- `core/auth/session.store.ts`: signals con el usuario, el rol, el taller y `mustChangePassword`, leídos de las respuestas de login, refresh y `/auth/me`, no del JWT.
- `current-session.ts` (001) se mantiene para el mock y como respaldo.
- `auth-token.interceptor.ts` (001) sigue agregando `Authorization`. Un `auth-refresh.interceptor.ts` nuevo:
  - ante 401 `TOKEN_EXPIRED` hace **un** refresh compartido (single-flight con `shareReplay`) y reintenta;
  - ante `REFRESH_CONFLICT` reintenta el refresh una vez;
  - ante `SESSION_EXPIRED` o `SESSION_REVOKED` limpia la sesión y navega a `/login?reason=expired|revoked`;
  - ante 403 `PASSWORD_CHANGE_REQUIRED` navega a `/change-password`.
- Rutas públicas: `/login` y `/register`. El resto queda detrás de `authGuard` (`canMatch`): sin sesión, a `/login`; con `mustChangePassword`, solo `/change-password`. `/users` queda detrás de `adminGuard`.
- "Cerrar sesión" va en la barra superior, visible en toda pantalla del taller: 1 toque, o 2 desde un menú en pantallas de 360 px (FR-025).
- `/dev-token` sigue solo con `isDevMode()`.
- Pantallas nuevas: `features/auth/login.page`, `register.page` y `change-password.page`; `features/users/users-list.page`, `user-form.page` (crear), `user-detail.page` (rol, desactivar o reactivar, restablecer, historial) y `reset-password.dialog`.
- La validación del RUC reutiliza `shared/identifiers/ec-document.ts`.
- El mock (`mock-api.interceptor` y `mock-api.store`) agrega las rutas de `/auth` y `/users` con las mismas reglas del contrato (como R8 de la 001). En el mock la cookie se simula en memoria.

## R14. Entrega en 3 PRs (cortes verticales)

1. **PR1, base, registro e inicio de sesión (US1, US2)**:
   - `db/bootstrap.sql` (rol `motorsync_auth`).
   - Migraciones de `tenants.ruc`, `users`, `login_attempts`, `user_sessions`, `refresh_tokens` y funciones.
   - `@Public()`, `password-hasher`, `AuthModule` con `register` y `login`.
   - Bloqueo, emisión del token de acceso con `sid`, `SessionValidator` en el interceptor y `AUTH_ALLOW_SESSIONLESS_TOKENS`.
   - E2e de aislamiento. Backend solamente, con el frontend contra el mock si hay paralelismo.
2. **PR2, sesión y frontend (US3, US5)**:
   - `refresh` (rotación, reutilización, inactividad), `logout`, `GET /auth/me`, `POST /auth/password`.
   - Restricción de la contraseña temporal (incluido el vencimiento en el login).
   - Frontend: login, registro, cambio de contraseña, interceptor de refresh, guards, cerrar sesión y mock.
3. **PR3, gestión de usuarios (US4)**:
   - `/users` (listar, ver, crear con temporal, rol, desactivar, reactivar, restablecer, historial).
   - Último administrador (advisory lock + trigger diferido).
   - Auditoría y pantallas de usuarios.
