# Research: Soporte de la plataforma y recuperación de acceso

**Feature**: `specs/003-soporte-plataforma/spec.md` | **Fecha**: 2026-10-25

Fase 0 del plan. Cada decisión sigue el formato Decisión / Razón / Alternativas. Se parte de lo que la 002 dejó en `backend/` (research 002 R1–R14): rol `motorsync_auth` dueño de funciones `SECURITY DEFINER`, `withAuthTransaction`, `SessionValidator` por request, refresh rotativo en cookie, bloqueo 5/15 en `login_attempts`, advisory lock del taller con el orden de locks de R8, `AuditService.record` en la transacción del request y `application/problem+json`.

**Modelo de amenaza** (el mismo que asume la constitución en el principio I, "para que un olvido no exponga datos"): las barreras de base de datos de esta feature protegen contra **errores del código** (un filtro olvidado, una ruta mal decorada, una consulta en el sitio equivocado), no contra un proceso de la API comprometido. Un proceso comprometido ya puede, desde la 002, llamar a `auth_find_user_for_login` con cualquier correo. Lo que sí se exige es que ningún camino de código de un taller pueda, por error, leer datos de otro taller o del panel, y que el panel no pueda leer más que los campos de FR-013 y FR-016.

## R1. Acceso entre talleres del panel de soporte (principio I)

El panel necesita leer, sin taller fijado, datos de identificación de **todos** los talleres (FR-013, FR-016): nombre comercial, RUC y fecha de alta de `tenants`, y nombre, correo, rol y estado de `users`. `users` tiene RLS `ENABLE` + `FORCE` por `app_current_tenant()`, y `motorsync_app` es `NOBYPASSRLS`.

**Decisión**: el mismo patrón de la 002 (R1), con **un rol dueño nuevo y separado**: `motorsync_support` (`NOLOGIN`, `NOBYPASSRLS`, `NOINHERIT`).

- `tenants` y `users` reciben políticas `FOR SELECT TO motorsync_support USING (true)` y `motorsync_support` solo tiene `GRANT SELECT` sobre las columnas permitidas: `tenants (id, name, ruc, created_at)` y `users (id, tenant_id, name, email, role, status)`. **No** tiene acceso a `password_hash`, `must_change_password`, sesiones, intentos fallidos, clientes, vehículos ni `audit_log`: aunque una función tuviera un error, el catálogo de privilegios impide que devuelva esos datos.
- Toda lectura entre talleres pasa por funciones `SECURITY DEFINER` con dueño `motorsync_support`, `SET search_path = pg_catalog, public, pg_temp`, SQL estático, `REVOKE ALL … FROM PUBLIC` y `GRANT EXECUTE … TO motorsync_app`.
- **Compuerta de sesión**: cada función del panel recibe `p_session_id` y lo valida dentro de la función con `support_session_agent(p_session_id)` (interna, sin `EXECUTE` para la app): la sesión de soporte existe, no está revocada, tuvo actividad en los últimos 30 minutos, su cuenta está activa y no tiene la contraseña temporal pendiente. Si no, `RAISE … ERRCODE '28000'` y la API responde 401 `SESSION_REVOKED`. El agente que queda registrado en tickets y bitácora sale **de la sesión**, nunca de un parámetro.
  - El id de sesión es un uuid v4 (122 bits aleatorios) que solo existe en un token de soporte firmado; `motorsync_app` no puede listar sesiones de soporte vivas desde una ruta de taller (ver R4: la tabla es invisible con un taller fijado). Es el equivalente, para el panel, de la "igualdad de un secreto" que la constitución exige a las funciones de autenticación.
- **Compuerta de contexto**: las funciones de lectura del panel exigen además `app_current_tenant() IS NULL`. Una ruta de un taller (que siempre tiene el taller fijado) no puede usarlas aunque conociera un id de sesión.
- Las funciones devuelven solo las columnas de FR-013 y FR-016 y nunca listan cuentas sin un taller o un ticket (US4-AC5): no existe ninguna función "buscar cuentas por correo".
- Funciones (DDL en [data-model.md](./data-model.md#funciones-security-definer-de-motorsync_support)):
  - `support_request_help(email, origin_hash)`: la única pública (US1, R7).
  - `support_list_open_tickets(session)`, `support_get_ticket(session, ticket)`, `support_discard_ticket(session, ticket, reason, ip)` (US2).
  - `support_lock_open_ticket(session, ticket)`, `support_resolve_ticket(session, ticket, note, ip)` (US3, R9).
  - `support_list_workshops(session, query, limit, offset)`, `support_list_workshop_accounts(session, tenant, ip)` (US4; la segunda escribe la bitácora, R10) y `support_list_access_log(session, tenant, agent, limit, offset)` (US4-AC8, lectura de la bitácora, R10).
  - `support_workshop_email_exists(email)`: solo para el procedimiento de operaciones (`EXECUTE` para `motorsync_migrator`, no para la app; R5).

**Razón**:
- Sin `BYPASSRLS` en ningún rol, como exige el principio I.
- Un rol distinto de `motorsync_auth` deja separadas en el catálogo (`pg_policies`, `information_schema.column_privileges`) la excepción de la autenticación y la del panel, y las pruebas pueden verificar cada una. Si se ampliara `motorsync_auth`, cualquier función de login heredaría la capacidad de leer `tenants.created_at` o de escribir tickets.
- Las políticas dirigidas solo se aplican al código de las funciones (dentro de una función `SECURITY DEFINER`, `current_user` es el dueño), igual que en la 002.

**Alternativas consideradas**:
- `motorsync_support` con `BYPASSRLS`: descartada; viola el principio I y abriría todas las tablas de negocio.
- Política `TO motorsync_app` del tipo `USING (current_setting('app.support_session') IS NOT NULL)`: descartada por la misma razón que en la 002 (R1): cualquier código de la app puede fijar esa variable, y la política no puede limitar columnas (`password_hash` quedaría visible).
- Tabla de directorio duplicada (`platform_directory(tenant, user, email, …)`) sin RLS: descartada; duplica datos y necesita sincronizarse con cada cambio de cuenta de la 002.
- Reutilizar `motorsync_auth` como dueño: descartada (ver Razón).

### Enmienda de la constitución necesaria (1.3.0, MINOR)

La justificación **no cabe** en el texto literal de la 1.2.0. El principio I dice: "Una lectura que cruce talleres solo se admite en funciones de base de datos acotadas a la autenticación: buscan por igualdad de un secreto o de un identificador único, devuelven las columnas mínimas y no usan un rol con `BYPASSRLS`. **Cualquier otro acceso entre talleres requiere una enmienda.**" El listado de talleres y de sus cuentas no es autenticación, y la búsqueda por parte del nombre comercial (US4-AC2) no es una búsqueda por igualdad. Además, el principio I fija el tenant "a partir del token autenticado o, en las rutas de autenticación (…), de la credencial verificada en el servidor", y la generación de la temporal por soporte (R9) lo fija desde un ticket. Y el principio IV lista "restablecimiento de contraseñas **por un administrador**". Por eso se propone una enmienda MINOR (amplía dos principios sin eliminar ni redefinir ninguno).

**Texto propuesto** (cambios respecto de la 1.2.0 en negrita):

Principio I, tercera viñeta:

> - El backend fija el tenant por transacción (`SET LOCAL app.tenant_id`) a partir del token autenticado o, en las rutas de autenticación (inicio de sesión, renovación de sesión, registro), de la credencial verificada en el servidor**, o, en la generación de una contraseña temporal por soporte de la plataforma, del ticket abierto leído en la base de datos**. Nunca lo toma del body, de la query ni de un header enviado por el cliente.

Principio I, cuarta viñeta:

> - Una lectura que cruce talleres solo se admite en funciones de base de datos acotadas**, que devuelven las columnas mínimas y no usan un rol con `BYPASSRLS`, en dos casos: (a)** a la autenticación**, que** buscan por igualdad de un secreto o de un identificador único**; (b) al panel de soporte de la plataforma, que exigen una sesión de soporte vigente, son de solo lectura, se limitan a los datos de identificación de talleres y de sus cuentas que fija la spec (nunca datos de negocio, contraseñas ni sesiones) y registran en una bitácora de solo agregar cada consulta de las cuentas de un taller.** Cualquier otro acceso entre talleres requiere una enmienda.

Principio I, viñeta nueva (después de la cuarta):

> - **Las cuentas de soporte de la plataforma no pertenecen a ningún taller. Sus sesiones y tokens no sirven en las rutas de un taller, y los de un taller no sirven en las del panel. La única escritura de soporte sobre datos de un taller es la contraseña temporal de la cuenta de un ticket abierto, en la misma transacción que su auditoría.**

Principio IV, primera viñeta (fragmento):

> … desactivación y reactivación de cuentas de usuario, restablecimiento de contraseñas por un administrador **o por soporte de la plataforma**, transferencia de un vehículo …

Principio IV, segunda viñeta:

> - Cada registro guarda `tenant_id`, actor y su rol **(un usuario del taller o un agente de soporte de la plataforma)**, acción, entidad, id, valores antes y después (JSON), fecha y hora (UTC), IP o canal, y el motivo cuando la acción lo exige.

Pie: `**Version**: 1.3.0 | **Ratified**: 2026-10-21 | **Last Amended**: <fecha del merge>`.

**Estado**: **aprobada por el humano el 2026-10-25** con este texto.

**Procedimiento**: igual que la 1.2.0. El leader la aplica en un PR propio (`docs: amend constitution 1.3.0`), aprobado por ambos integrantes, que se integra en `main` **antes** del PR1 de esta feature. Este plan no edita la constitución; mientras la enmienda no esté en `main`, el Constitution Check queda "PASA condicionado a la 1.3.0". Hay que revisar también que `CLAUDE.md` y `.claude/agents/reviewer.md` sigan siendo coherentes (no citan el texto literal del principio I, así que no se prevén cambios).

## R2. Identidad de soporte: dónde viven las cuentas

**Decisión**: tablas de **plataforma**, sin `tenant_id`, separadas de `users`:

- `support_accounts (id, name, email, password_hash, status, must_change_password, temp_password_expires_at, created_at, updated_at)`: mismo formato de hash (`scrypt$…`) y mismas reglas de correo y temporal (CHECK de coherencia) que `users`.
- `support_sessions (id, support_account_id, created_at, last_activity_at, revoked_at, revoke_reason, ip)` y `support_refresh_tokens (id, session_id, token_hash, created_at, rotated_at)`: la misma forma que `user_sessions` y `refresh_tokens`, sin taller.
- **RLS "solo plataforma"**: las tres tablas tienen RLS `ENABLE` (sin `FORCE`, como `tenants`, para que el migrator, dueño, las use en el procedimiento de operaciones, `seed-dev` y los fixtures) con la política `TO motorsync_app USING (app_current_tenant() IS NULL)`. En una ruta de un taller, que siempre fija `app.tenant_id` como primera sentencia, las tablas de soporte se ven vacías y no se pueden escribir. En las rutas del panel, que nunca fijan taller salvo en el paso acotado de R9, se usan con normalidad.
- Privilegios de `motorsync_app`:
  - `support_accounts`: `SELECT` y `UPDATE (password_hash, must_change_password, temp_password_expires_at, updated_at)`. **Sin `INSERT`** y sin `UPDATE` de `name`, `email` ni `status`: la app no puede crear, renombrar, reactivar ni desactivar cuentas de soporte (FR-007, US2-AC2, SC-009) aunque tuviera una ruta por error.
  - `support_sessions`: `SELECT, INSERT, UPDATE`. `support_refresh_tokens`: `SELECT, INSERT, UPDATE, DELETE` (poda de tokens rotados, como en la 002).
- Un único rol de soporte (supuesto de la spec): no hay columna de rol.

**Razón**: FR-008 exige que una cuenta de soporte no pertenezca a ningún taller. Meterla en `users` con un `tenant_id` ficticio ("taller plataforma") mezclaría las dos identidades bajo la misma RLS, haría que las funciones `auth_*` de la 002 la encontraran (login de taller con credenciales de soporte, US2-AC6) y obligaría a filtrarla en `GET /users`, en la regla del último administrador y en los fixtures. Tablas propias hacen que la separación sea estructural.

**Alternativas**:
- `users` con un taller "MotorSync": descartada (ver Razón).
- Tablas de soporte con `FORCE` y una política para el migrator: posible, pero agrega una política por tabla solo para operaciones y fixtures; se sigue el precedente de `tenants` (Complexity Tracking).
- Sin RLS en las tablas de soporte: descartada; un error en una ruta de un taller podría leer `support_accounts.password_hash`.

## R3. Tokens y sesiones de soporte: separación en ambos sentidos (US2-AC5, US2-AC6, FR-008)

**Decisión**:
- **Secreto propio**: los tokens de acceso de soporte se firman con `SUPPORT_JWT_SECRET` (HS256, 15 minutos), distinto de `JWT_SECRET`. `loadEnv` exige que exista, que tenga al menos 32 caracteres y que sea distinto de `JWT_SECRET` (falla al arrancar si no). **Confirmado por el humano el 2026-10-25.**
  - **Sin valor por defecto en el código**, en ningún entorno: la API no arranca sin la variable. Las pruebas no necesitan un defecto en el código: `backend/vitest.config.ts` y `vitest.config.e2e.ts` fijan un valor de prueba propio (distinto del `JWT_SECRET` de prueba), igual que hoy fijan `AUTH_ALLOW_SESSIONLESS_TOKENS=true`. Así CI lo recibe sin tocar `ci.yml`, salvo que algún job arranque la API fuera de Vitest (entonces se agrega como variable del job o GitHub Secret).
  - `.env.example` incluye `SUPPORT_JWT_SECRET=` con un valor de ejemplo marcado "cambiar" (tarea del leader). `loadEnv` rechaza además que valga lo mismo que en `.env.example`, solo con `NODE_ENV=production`.
- Claims: `sub` (id de la cuenta de soporte), `sid`, `name`, `pwd_change` y `aud: "motorsync-support"`. **Sin `tenant_id` ni `role`**. No existen tokens de soporte sin sesión: `AUTH_ALLOW_SESSIONLESS_TOKENS` no aplica al panel, y `npm run token:dev` no emite tokens de soporte.
- **Zona de soporte**: todas las rutas del panel cuelgan de `/support` y sus controladores llevan el decorador de clase `@SupportArea()` (`SetMetadata('supportArea', true)`).
- `JwtAuthGuard` (global) decide por la metadata:
  - ruta de taller: verifica con `JWT_SECRET` como hoy. Si falla la firma pero el token verifica con `SUPPORT_JWT_SECRET`, responde 403 `FORBIDDEN` (US2-AC6, "la rechaza"); cualquier otro fallo, 401 como hoy.
  - ruta `@SupportArea()`: verifica con `SUPPORT_JWT_SECRET` y `audience: 'motorsync-support'`, y exige `sid`. Si falla pero el token verifica como token de taller, 403 `FORBIDDEN` ("como si no tuviera permisos", US2-AC5); si está vencido, 401 `TOKEN_EXPIRED`; si no, 401 `UNAUTHORIZED`.
  - `request.user` (taller) y `request.supportAgent` (soporte) son tipos distintos (`AuthUser` y `SupportAgent`): el código de un taller no puede recibir un agente por error de tipos.
- `TenantTransactionInterceptor` (global) **no actúa** en rutas `@SupportArea()` (igual que con `@Public()`): nunca fija un taller en el panel.
- `SupportTransactionInterceptor` (también global, `APP_INTERCEPTOR`) solo actúa en rutas `@SupportArea()` no públicas: abre la transacción **sin taller**, valida la sesión de soporte con `SupportSessionValidator` (la sentencia de R6 de la 002 sobre `support_sessions`/`support_accounts`), aplica `@AllowPendingPasswordChange()` (reutilizado) y publica `supportStorage` (`AsyncLocalStorage` con `manager`, `agent`, `ip`). Al ser global, una ruta del panel no puede "olvidar" su interceptor; una prueba unitaria comprueba además que todo controlador de `src/support/` lleva `@SupportArea()`.
- **Refresh**: cookie distinta `ms_support_refresh`, `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/support/auth`. El navegador nunca envía `ms_refresh` (Path `/api/v1/auth`) al panel ni `ms_support_refresh` a las rutas de taller. Mismo header CSRF `X-Requested-With: motorsync`.
- **Login con credenciales cruzadas**: `POST /support/auth/login` solo busca en `support_accounts`; `POST /auth/login` solo en `users` (`auth_find_user_for_login`). Unas credenciales de taller en el panel, o de soporte en el login del taller, dan 401 `INVALID_CREDENTIALS` genérico (US2-AC5, US2-AC6, última frase).

**Razón**: con secreto propio, la separación no depende de que cada guard compruebe bien un claim: un token de un tipo ni siquiera verifica en la otra zona. Es lo que la spec pide "por la interfaz o por cualquier otra vía". El costo es un secreto más en `.env`, CI y despliegue.

**Alternativas**:
- Mismo `JWT_SECRET` con `aud` o un claim `typ`: válida y más simple, pero la separación pasa a depender de una comparación en el guard; un error en él abriría el panel a tokens de taller. Descartada por el humano el 2026-10-25.
- Tokens de acceso opacos para soporte (sin JWT): la sesión ya se valida en cada request, pero duplicaría la emisión y el guard en lugar de reutilizarlos.

## R4. Reutilización de la 002 para el acceso de soporte (FR-009, FR-010)

**Decisión**: reutilizar las piezas, no copiar la lógica.

| Pieza de la 002 | Uso en soporte |
|---|---|
| `PasswordHasher` (scrypt, hash ficticio, R3 de la 002) | Igual: verificación con el hash de `support_accounts` o con el ficticio si el correo no existe o la cuenta está desactivada (mismo tiempo). |
| Bloqueo 5/15 (`login_attempts` + `auth_login_locked_until`, `auth_record_login_failure`, `auth_record_login_success`) | **Las mismas funciones y la misma tabla**, con el hash del correo de soporte. Los correos de soporte y de taller nunca coinciden (FR-024, R5), así que no hay contadores compartidos. |
| `withAuthTransaction` | Igual para las rutas públicas del panel; sin `asTenant` (no hay taller). |
| Sesión (R5, R6, R7 de la 002): 15 min de acceso, refresh rotativo, reutilización con ventana de 10 s, inactividad de 30 min por `last_activity_at`, temporal de 72 h con `@AllowPendingPasswordChange()` | Mismas reglas sobre `support_sessions`/`support_refresh_tokens`. La lógica pura (generar y hashear el refresh, clasificar `fresh`/`recently_rotated`/`reused`, la ventana de 10 s) se extrae de `sessions.service.ts` a `src/auth/refresh-token-policy.ts` y la usan ambos servicios; las sentencias SQL son propias de cada conjunto de tablas. |
| `cookies.ts` | Se parametriza el nombre y el `Path` de la cookie (`ms_refresh` / `ms_support_refresh`). |
| `POST /auth/password` | `POST /support/auth/password` con las mismas reglas (FR-005, FR-006, FR-026 de la 002) y el bloqueo por la contraseña actual. Los fallos se registran después de liberar la conexión (`AfterReleaseError`, ajuste T049 de la 002). |
| Mensajes genéricos | `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `TEMPORARY_PASSWORD_EXPIRED`, `SESSION_EXPIRED`, `SESSION_REVOKED`, `TOKEN_EXPIRED`, `PASSWORD_CHANGE_REQUIRED`, `REFRESH_CONFLICT`. |

- El login de soporte no toma advisory locks de taller (no hay taller). La carrera "login frente a restablecer" de la 002 (R8) se resuelve igual que allí pero con un `SELECT … FOR SHARE` sobre la fila de `support_accounts` y la re-comprobación de `password_hash` y `status` antes de abrir la sesión; el procedimiento de operaciones bloquea la misma fila con `FOR UPDATE`.
- La validación por request (R6 de la 002) sobre soporte:

```sql
UPDATE support_sessions s SET last_activity_at = now()
  FROM support_accounts a
 WHERE s.id = $sid AND s.support_account_id = $sub AND a.id = s.support_account_id
   AND s.revoked_at IS NULL AND a.status = 'active'
   AND s.last_activity_at > now() - interval '30 minutes'
RETURNING a.name, a.email, a.must_change_password, a.temp_password_expires_at,
          a.temp_password_expires_at <= now() AS temp_password_expired
```

**Razón**: FR-009 pide "las reglas de la feature 002"; reutilizar el código es la forma de que no diverjan. Extraer la política pura del refresh es un refactor pequeño cubierto por las pruebas existentes de la 002.

**Alternativas**: generalizar `SessionsService` con nombres de tabla por parámetro (SQL dinámico con identificadores: más difícil de revisar); copiar el servicio entero (dos implementaciones que divergirán).

## R5. Procedimiento de operaciones para cuentas de soporte (FR-007, FR-011, FR-024, US2-AC1, US2-AC10)

**Decisión**: script `backend/scripts/support-account.ts` (`npm run support:account -- <comando>`), que se conecta con `DATABASE_MIGRATOR_URL`: la credencial de operación de la plataforma, que la API nunca usa.

| Comando | Efecto (una transacción) |
|---|---|
| `create --name "Pedro Soporte" --email pedro@motorsync.ec` | Normaliza el correo (`normalizeEmail` de la 002). Rechaza si ya existe en `support_accounts` o si `support_workshop_email_exists(email)` devuelve verdadero (FR-024). Genera una temporal (R9), la guarda con scrypt, `must_change_password = true` y vencimiento a 72 h, e **imprime la temporal una sola vez** en la salida estándar. |
| `deactivate --email …` | `SELECT … FOR UPDATE` de la cuenta, `status = 'inactive'` y revoca todas sus sesiones (`revoke_reason = 'deactivated'`) en la misma transacción (FR-011, US2-AC10). No borra nada. |
| `reactivate --email …` | `status = 'active'`. No revive sesiones. |
| `reset-password --email …` | Recuperación de la propia cuenta de soporte (fuera de alcance de la app): temporal nueva de 72 h, revoca sesiones y borra su fila de `login_attempts` (con `SET ROLE motorsync_auth`, único dueño de esa tabla), e imprime la temporal una vez. |
| `list` | Nombre, correo, estado y fecha de alta. Nunca hashes. |

Controles:
- Requiere `--confirm` en `deactivate`, `reactivate` y `reset-password`.
- Rechaza correr si `DATABASE_MIGRATOR_URL` no está definida, y nunca registra la temporal en logs (solo `stdout` del operador).
- Las cuentas no se borran: no hay comando `delete` y `motorsync_app` no tiene `DELETE` sobre `support_accounts`.
- **FR-024 en ambos sentidos, en la base** (confirmado por el humano el 2026-10-25):
  - trigger `support_accounts_email_not_workshop` (`BEFORE INSERT OR UPDATE OF email` en `support_accounts`): rechaza un correo usado por una cuenta de taller;
  - trigger `users_email_not_support` (`BEFORE INSERT OR UPDATE OF email` en `users`): rechaza un correo de una cuenta de soporte con `ERRCODE 23505` y `CONSTRAINT users_email_key`. Así el registro (002, US1-AC5) y la creación de cuentas (002, US4-AC3) responden con su error genérico de siempre (`REGISTRATION_FAILED`, `EMAIL_UNAVAILABLE`) sin revelar nada, y "¿Olvidaste tu contraseña?" nunca es ambiguo.
  - Ambas funciones de trigger son `SECURITY DEFINER` de `motorsync_support`, porque el migrator no ve `users` (RLS `FORCE`) y la app no ve `support_accounts` con taller fijado.

**Razón**: la spec exige una vía fuera de la aplicación y que nadie pueda crear cuentas desde la app. Usar la credencial del migrator (que ya es la de operación: migraciones y seed) evita un rol nuevo con login. La regla de FR-024 en triggers la mantiene verdadera aunque un taller se registre después con ese correo.

**Alternativas**: endpoint oculto con un secreto de operaciones (es "la aplicación" y viola FR-007); SQL manual documentado (sin la verificación de FR-024 ni el hash); validar FR-024 solo en el script (un registro posterior lo rompería).

## R6. Ticket de soporte: modelo y estados (FR-012, FR-014, FR-015, US2-AC8, US2-AC13)

**Decisión**:
- Tabla `support_tickets` con `tenant_id` y `user_id` (FK compuesta a `users (tenant_id, id)`: el ticket no puede apuntar a una cuenta de otro taller que la de su `tenant_id`), `number` (`bigint GENERATED ALWAYS AS IDENTITY`, la referencia legible "#123" que va a la auditoría del taller), `email` normalizado, `status` (`open`, `resolved`, `discarded`), `created_at`, `last_requested_at`, `request_count`, y los campos de cierre: `verification_note`, `resolved_by`, `resolved_at`, `discard_reason`, `discarded_by`, `discarded_at`, con CHECK de coherencia por estado.
- **Un ticket abierto por cuenta**: índice único parcial `support_tickets (user_id) WHERE status = 'open'`. La solicitud de ayuda hace `INSERT … ON CONFLICT (user_id) WHERE status = 'open' DO UPDATE SET last_requested_at = now(), request_count = request_count + 1` (SC-008, US1-AC5, US1-AC7: con solicitudes simultáneas, PostgreSQL serializa en el índice y todas cuentan).
- **Inmutabilidad de los cerrados**: trigger `BEFORE UPDATE` que rechaza cualquier cambio si `OLD.status <> 'open'`, y otro que rechaza `DELETE` siempre (FR-015, SC-010). Las únicas transiciones (`open → resolved`, `open → discarded`) las hacen `support_resolve_ticket` y `support_discard_ticket`.
- Historial: `support_ticket_events (id, ticket_id, support_account_id, action, from_status, to_status, occurred_at, ip)`, append-only con trigger (US2-AC8). Acciones: `discarded`, `temporary_password_generated`.
- `motorsync_app` **no tiene ningún privilegio** sobre `support_tickets` ni `support_ticket_events` (contienen correos y cuentas de todos los talleres): solo llega a ellas a través de las funciones de R1. RLS `ENABLE` (sin `FORCE`, como en R2) con políticas solo `TO motorsync_support`.
- La nota de verificación (FR-023) y el motivo de descarte: 1–1000 y 1–500 caracteres tras recortar espacios; un valor vacío o de solo espacios se rechaza en el DTO (400 `VALIDATION_ERROR` con `errors[]` en el campo) **antes** de abrir la transacción (US3-AC3, US2-AC12), y la función lo vuelve a comprobar.

**Razón**: el índice parcial único es la forma más simple de garantizar "como máximo un ticket abierto" ante concurrencia sin locks explícitos. Los triggers de inmutabilidad trasladan a la base las reglas de "sin reapertura" y "sin borrado".

**Alternativas**: `SELECT … FOR UPDATE` + `INSERT` (deja una ventana entre dos solicitudes simultáneas sin fila previa); `SERIALIZABLE` (reintentos); guardar el historial en JSON dentro del ticket (no es append-only).

## R7. "¿Olvidaste tu contraseña?": endpoint público, respuesta y tiempo indistinguibles (FR-001 a FR-006, US1)

**Decisión**:
- `POST /api/v1/auth/forgot-password` (`@Public()`), body `{ "email": "…" }`. Respuestas:
  - **202** sin body para toda solicitud válida dentro del límite: correo inexistente, cuenta activa, desactivada, con ticket abierto o de soporte (US1-AC2, US1-AC10). El frontend muestra el texto de FR-003.
  - **429** `HELP_RATE_LIMITED` fuera del límite (US1-AC6), igual exista o no el correo.
  - **400** `VALIDATION_ERROR` con `errors[]` en `email` si falta o tiene formato inválido (US1-AC8). No cuenta para el límite ni toca la base.
- Toda la decisión ocurre en **una sola llamada** a `support_request_help(p_email, p_origin_hash)` dentro de `withAuthTransaction`, que siempre ejecuta los mismos pasos:
  1. upsert atómico en `help_request_throttle` (R8); si el origen superó 20 en la ventana, devuelve `'rate_limited'` sin seguir;
  2. busca la cuenta de taller por igualdad del correo normalizado (`users.email`, índice único global de la 002);
  3. si existe, upsert del ticket abierto (R6); si no, nada (US1-AC3: el correo inexistente no se guarda en ninguna tabla);
  4. devuelve `'accepted'`.
- **Tiempo indistinguible**: la diferencia entre "existe" e "inexistente" es un `INSERT` o `UPDATE` de una fila (milisegundos). Para que no se pueda medir, el controlador responde **siempre después de un piso fijo** de `HELP_RESPONSE_FLOOR_MS = 400` ms medidos desde el inicio de la petición (si la base tardó más, se responde en cuanto termina), en los caminos 202 y 429. El piso se aplica también si la función falla (500), para no abrir un canal por errores. Valor confirmado por el humano el 2026-10-25.
- **Sin efectos sobre la cuenta** (FR-005, US1-AC4): la función no toca `users`, `user_sessions`, `login_attempts` ni `audit_log`. Los privilegios de `motorsync_support` sobre `users` son solo `SELECT` de columnas: aunque hubiera un error, no podría modificar la cuenta.
- **Identidad desde el servidor** (FR-006, US1-AC9): la spec pide **ignorar** (no rechazar) los identificadores extra. Por eso este endpoint, a diferencia de los de la 002, no usa el `forbidNonWhitelisted` global: el parámetro del body se declara sin clase (el `ValidationPipe` global no valida `Object`) y un pipe propio `ForgotPasswordBodyPipe` lo valida con `whitelist: true, forbidNonWhitelisted: false`, quedándose solo con `email`. `tenantId`, `userId` o `ticketId` se descartan y la respuesta es la de siempre (202). Confirmado por el humano el 2026-10-25.
- **Correos de soporte** (US1-AC10): la búsqueda es solo en `users`; un correo de soporte se trata como inexistente.

**Razón**: un solo camino de código con un piso de tiempo es más robusto que intentar igualar a mano el trabajo de cada rama, y la prueba estadística de la 002 (R12) sirve igual: mediana de 20 solicitudes por caso con tolerancia del 25 %.

**Alternativas**:
- Igualar el trabajo con una escritura ficticia cuando el correo no existe: sigue habiendo diferencias de plan de ejecución y de locks.
- Responder en segundo plano (cola) y devolver 202 de inmediato: agrega infraestructura (YAGNI) y la spec no lo necesita.
- Mantener `forbidNonWhitelisted` (400 ante campos extra): no cumple "los ignora" de US1-AC9.

## R8. Límite de 20 solicitudes por origen por hora sin guardar correos (FR-004, US1-AC6, US1-AC7)

**Decisión**:
- **Origen** = `req.ip` de Express (como el resto de la API, R11 de la 002). Se guarda solo `origin_hash = SHA-256 hex de la IP`, no la IP en claro ni ningún correo.
- Tabla técnica global `help_request_throttle (origin_hash PK, window_started_at, request_count, updated_at)`, sin `tenant_id` y sin privilegios para `motorsync_app` (como `login_attempts`).
- Ventana fija de 1 hora desde la primera solicitud del origen. Upsert atómico en `support_request_help`:
  - si la ventana venció, reinicia en 1;
  - si no, suma 1 (con tope en 21, para que el contador no crezca sin límite);
  - si el valor resultante es mayor que 20, la solicitud se rechaza y **no** crea ni modifica tickets.
  El lock de fila del `ON CONFLICT DO UPDATE` serializa las solicitudes simultáneas del mismo origen: todas cuentan (FR-004).
- Las solicitudes inválidas (400) no llegan a la función: no cuentan (US1-AC8).
- No hay límite por correo (clarify 2026-10-25): lo sustituye el ticket abierto único (R6).
- Poda oportunista de ventanas vencidas hace más de 1 día dentro de la misma función, como máximo 100 filas y con `FOR UPDATE SKIP LOCKED` (la lección del ajuste T031 de la 002).

**Riesgo operativo**: sin `trust proxy` configurado en producción, `req.ip` es la IP del proxy y **todas** las solicitudes compartirían un único contador de 20 por hora. La configuración de `trust proxy` es requisito del despliegue de esta feature (plan, riesgos).

**Alternativas**: ventana deslizante con marcas de tiempo por solicitud (más filas, sin beneficio para un límite anti-abuso); `@nestjs/throttler` en memoria (no se comparte entre instancias y es otra dependencia); limitar por correo (descartado en clarify).

## R9. Contraseña temporal por soporte: transacción, tenant y orden de locks (FR-019 a FR-021, US3)

**Decisión**:
- `POST /api/v1/support/tickets/{ticketId}/temporary-password` con body `{ "verificationNote": "…" }`. El body no admite ningún otro campo (aquí sí rige `forbidNonWhitelisted`: US3-AC9 permite "ignorar o rechazar"; se rechaza con 400 un `userId` o `tenantId`, sin efectos).
- **La temporal la genera el servidor** (FR-019, formato decidido por el humano el 2026-10-25): 16 caracteres elegidos con `crypto.randomInt` sobre el alfabeto `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 símbolos: mayúsculas y dígitos, **sin 0/O ni 1/I/L**, y sin minúsculas para que no haya `l` ni dudas de mayúsculas al dictar), en 4 bloques de 4 separados por guiones: `ABCD-EFGH-JKMN-PQRS`. Unos 79 bits de entropía.
  - **Los guiones forman parte de la contraseña**: se guarda el hash de la cadena completa de 19 caracteres y el usuario la escribe tal cual. El login de la 002 no cambia (compara sin recortar ni normalizar, FR-005 de la 002), así que una temporal escrita sin guiones o en minúsculas se rechaza como cualquier contraseña incorrecta.
  - **FR-005 de la 002** mide la longitud en caracteres Unicode, de 8 a 128: 19 caracteres cumplen. La política no exige clases de caracteres, así que no hay más reglas que comprobar.
  - Formato fijo `^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$`; una prueba unitaria del generador lo verifica, junto con la ausencia de los caracteres excluidos y la distribución uniforme (`randomInt`, sin sesgo de módulo).
  - El diálogo del panel la muestra en fuente monoespaciada, con un botón "Copiar" y el aviso "Escríbala tal cual, con los guiones y en mayúsculas". Se muestra **una sola vez** en la respuesta 200, con `Cache-Control: no-store`, y nunca se escribe en la base (solo su hash), en logs, en el ticket ni en la auditoría (US3-AC2). La misma función genera las temporales del procedimiento de operaciones (R5).
- **Reutilización de la 002**: el núcleo de `UsersService.resetPassword` (revocar sesiones → `UPDATE users` → `auth_clear_login_failures` → valores de auditoría) se extrae a `src/users/apply-temporary-password.ts`, una función que recibe el manager, la cuenta, el hash y el "actualizado por" (`id`, `name`). La usan el restablecimiento del administrador (sin cambio de comportamiento: lo cubren las e2e de la 002) y el de soporte. El rol y el estado no se tocan (US3-AC13).
- **Una sola transacción** (la del request del panel, `SupportTransactionInterceptor`), en este orden:

| Paso | Sentencia | Lock que toma |
|---|---|---|
| 0 | (interceptor) `SupportSessionValidator` | fila propia de `support_sessions` |
| 0b | Generar la temporal y su hash scrypt **antes** de tomar ningún otro lock (unos 100 ms; si el ticket resulta no estar abierto, se descarta) | — |
| 1 | `SELECT * FROM support_lock_open_ticket($sid, $ticket)` | fila del ticket (`FOR UPDATE`) |
| 2 | Si no existe: 404 `NOT_FOUND`. Si no está `open`: 409 `TICKET_NOT_OPEN` (US3-AC5, US2-AC13, US3-AC12) | — |
| 3 | `set_config('app.tenant_id', <tenant_id devuelto por el paso 1>, true)` | — |
| 4 | `TENANT_ADMINS_LOCK_SQL` (el advisory lock del taller de R8 de la 002) | advisory lock del taller |
| 5 | `SELECT status … FROM users WHERE id = <user_id del paso 1>` bajo RLS. Si está `inactive`: 409 `ACCOUNT_INACTIVE` (US3-AC8), con el estado **vigente** (después del lock) | — |
| 6 | `applyTemporaryPassword`: revoca sesiones (`revoke_reason = 'password_reset'`) → `UPDATE users` (`updated_by` = id del agente, `updated_by_name` = "<nombre> (Soporte MotorSync)") → `auth_clear_login_failures` | sesiones del objetivo → fila de `users` |
| 7 | `AuditService.recordAsSupport(...)` en `audit_log` del taller fijado (R11) | — |
| 8 | `support_resolve_ticket($sid, $ticket, $note, $ip)`: exige que el ticket siga `open` y que su `tenant_id` sea `app_current_tenant()`; guarda la nota, `resolved_by`, `resolved_at`, pasa a `resolved` e inserta el evento | (fila del ticket, ya tomada) |
| 9 | Commit. Responde 200 con la temporal | libera todo |

- **Orden de locks** (extensión de R8 de la 002): **sesión de soporte propia → ticket → advisory lock del taller → sesiones del objetivo → fila de `users`**. Ningún camino de un taller toma un ticket ni una sesión de soporte, y ningún camino de soporte toma un ticket después del advisory lock, así que no hay ciclos:
  - frente al restablecimiento del administrador (US3-AC11): ambos toman el advisory lock del mismo taller antes de las sesiones y de `users`; se aplican uno tras otro, cada uno con su auditoría (dos registros), y la cuenta queda con la temporal del último, sin sesiones;
  - frente a otro agente sobre el mismo ticket (US3-AC12): el segundo espera en el paso 1 y, al obtener la fila, la ve `resolved` o `discarded`: 409 `TICKET_NOT_OPEN`, sin tocar la cuenta;
  - frente a un descarte simultáneo: `support_discard_ticket` toma la misma fila con `FOR UPDATE`; solo una de las dos operaciones encuentra el ticket abierto;
  - frente a "¿Olvidaste tu contraseña?" sobre la misma cuenta: el upsert espera la fila del ticket y, si quedó `resolved`, crea un ticket nuevo (US1-AC5), sin tomar el advisory lock;
  - frente al login de la cuenta (lock compartido de R8 de la 002): igual que con el restablecimiento del administrador.
- **Cómo se fija el tenant sin que soporte "entre" al taller**: el tenant sale de la fila del ticket leída por la base (nunca del body), como en las rutas de autenticación sale de la credencial (enmienda 1.3.0, R1). El taller queda fijado solo entre los pasos 3 y 9 del único handler que lo necesita, en un servicio (`SupportPasswordService`) que **solo** llama a `applyTemporaryPassword`, `AuditService.recordAsSupport` y `support_resolve_ticket`; no publica `tenantStorage`, así que ningún servicio de taller (`getManager()`, `getTenantContext()`) puede ejecutarse con ese contexto (lanzan "No tenant context"). El agente no recibe ningún token, sesión ni dato del taller: la respuesta solo lleva la temporal, su vencimiento y el ticket.
- **Atomicidad** (US3-AC7): cualquier error entre los pasos 1 y 8 hace rollback de todo (contraseña, sesiones, bloqueo, auditoría y ticket). Una prueba e2e fuerza un fallo después de la auditoría (por ejemplo, con un trigger temporal del migrator que rechaza el `UPDATE` del ticket) y comprueba que nada cambió.

**Razón**: el orden "ticket antes del advisory lock" es obligado (el tenant sale del ticket) y es seguro porque ningún camino toma esos locks al revés. Fijar el tenant y escribir bajo las políticas normales de la 002 (en lugar de dar a `motorsync_support` privilegios de `UPDATE` sobre `users`, `user_sessions` y `audit_log` de todos los talleres) mantiene la escritura acotada a un solo taller y a un solo camino de código, y reutiliza la lógica de la 002 en lugar de reescribirla en SQL.

**Alternativas**:
- Todo dentro de una función `support_reset_password(...)` con políticas `UPDATE … TO motorsync_support` en `users`, `user_sessions` e `INSERT` en `audit_log`: duplica en plpgsql la lógica de la 002 y da a un rol escritura entre talleres en tres tablas.
- Tomar el advisory lock con un id de taller enviado por el cliente: viola el principio I.
- Generar la temporal en el cliente o pedirla al agente (como el administrador en la 002): FR-019 exige que la genere el sistema.

## R10. Bitácora de soporte (FR-018, US4-AC6, US4-AC7)

**Decisión**:
- Tabla `support_access_log (id, support_account_id, tenant_id, action, occurred_at, ip, channel)`, con `action = 'workshop.accounts_viewed'` (única acción de esta feature).
- Append-only: trigger `BEFORE UPDATE OR DELETE` que lanza excepción (como `audit_log` de la 001), `motorsync_app` sin ningún privilegio, y solo `INSERT, SELECT` para `motorsync_support`.
- Se escribe **dentro** de `support_list_workshop_accounts`, en la misma sentencia que devuelve las cuentas: no se puede consultar las cuentas de un taller sin dejar el registro, y si el taller no existe la función lanza `P0002` (404 `NOT_FOUND`) sin escribir nada (US4-AC7).
- El agente sale de la sesión (R1) y la IP la pasa la API (`req.ip`); `channel = 'support_panel'`.
- **Consulta por operaciones**: el operador la consulta con SQL (como migrator) o con `npm run support:account -- access-log [--email …] [--since …]` (se mantiene).
- **Vista en el panel** (decisión del humano, 2026-10-25; US4-AC8, US4-AC9, FR-027):
  - `GET /support/access-log?workshopId=&agentId=&page=`: solo lectura, de la más reciente a la más antigua, 50 por página. Cada registro: fecha, `agent { id, name }`, `workshop { id, name, ruc }`, IP y canal. **Nunca** el correo del agente ni cuentas del taller.
  - Pasa por la función acotada `support_list_access_log(p_session_id, p_tenant_id, p_agent_id, p_limit, p_offset)` con las mismas compuertas de R1 (sesión viva, sin taller fijado). Solo hace `SELECT`: `motorsync_support` tiene `INSERT, SELECT` sobre la tabla, pero la función es `STABLE` y no contiene ninguna escritura.
  - **Filtros simples, sin endpoints extra**: por taller (`workshopId`) y por agente (`agentId`), combinables. En la interfaz se aplican desde la propia bitácora (tocar el taller o el agente de una fila) y desde la página de cuentas de un taller ("Ver bitácora de este taller"). No se agrega un listado de agentes: evitaría tener que exponer las cuentas de soporte en el panel.
  - Un filtro con un uuid que no existe devuelve una página vacía, no 404 (es un filtro, no un recurso).
  - **La consulta de la bitácora no se registra en la bitácora**: FR-018 registra las consultas de **cuentas de un taller**, que es el dato sensible entre talleres. La bitácora solo muestra nombres de agentes y datos de identificación de talleres que el panel ya muestra en la lista de talleres (FR-016). Registrarla generaría un registro por cada vista de la propia bitácora (ruido recursivo) sin proteger ningún dato nuevo. La spec lo fija en US4-AC9 y FR-027.
- Retención indefinida (clarify 2026-10-25): no hay poda.

**Alternativas**: registrar la bitácora desde Node después de la consulta (un error entre ambos dejaría consultas sin registro); usar `audit_log` (es por taller y lo ve el administrador del taller; la spec separa ambas cosas).

## R11. Auditoría en el taller con un actor que no es usuario del taller (FR-020, principio IV)

Columnas actuales de `audit_log` (001): `tenant_id`, `actor_user_id uuid NOT NULL` (sin FK), `actor_name text NOT NULL`, `actor_role text NOT NULL CHECK (actor_role IN ('asesor', 'admin'))`, `action`, `entity_type`, `entity_id`, `before`, `after`, `reason` (CHECK 10–500), `occurred_at`, `ip`, `channel`, y `CONSTRAINT audit_log_asesor_reason`.

**Decisión** (requiere **una migración** pequeña):
- Migración `AllowSupportAuditActor`: reemplaza el CHECK `audit_log_actor_role_check` por `actor_role IN ('asesor', 'admin', 'platform_support')`. No toca filas: el trigger append-only de la 001 solo bloquea `UPDATE` y `DELETE`, no DDL, y el `down` vuelve al CHECK anterior (fallará si ya hay filas de soporte, lo cual es correcto).
- Registro de la temporal por soporte:

| Columna | Valor |
|---|---|
| `tenant_id` | el del ticket (fijado en el paso 3 de R9; `DEFAULT app_current_tenant()`) |
| `actor_user_id` | id de la cuenta de soporte (no existe en `users`; no hay FK, como en la 001) |
| `actor_name` | nombre del agente (nunca su correo) |
| `actor_role` | `platform_support` |
| `action` | `user.password_reset_by_support` |
| `entity_type`, `entity_id` | `user`, id de la cuenta afectada |
| `before` | `{ "mustChangePassword": false }` |
| `after` | `{ "mustChangePassword": true, "temporaryPasswordExpiresAt": "…Z", "sessionsClosed": 2, "supportTicketNumber": 123 }` |
| `reason` | `NULL` (la nota de verificación queda solo en el ticket, FR-023) |
| `ip`, `channel` | IP del agente, `support_panel` |

- `AuditService` gana `recordAsSupport(manager, agent, ip, entry)`: recibe el manager explícito (no hay `tenantStorage` en el panel, R9) y fija actor, rol y canal. `record()` de la 001 y la 002 no cambia.
- El administrador del taller lo ve en `GET /users/{id}/history` (002) sin cambios de consulta. Cambios de contrato sobre la 002 (en [contracts/openapi.yaml](./contracts/openapi.yaml), sección "Cambios a la 002"): `UserAuditEntry.action` suma `user.password_reset_by_support` y `actorRole` suma `platform_support`. El frontend muestra "<nombre> (Soporte MotorSync)" y la acción "Restablecimiento de contraseña por soporte (ticket #123)".
- Una prueba recorre el JSON del registro y de todas las respuestas buscando la temporal generada y la nota de verificación (US3-AC6, SC-007).

**Alternativas**: columnas nuevas `actor_kind` / `support_ticket_id` en `audit_log` (más DDL en una tabla de la 001 para lo que cabe en `actor_role` y `after`); `reason` con la referencia del ticket (el CHECK exige 10–500 y `reason` significa "motivo"); registrar con `actor_role = 'admin'` (falsea al actor).

## R12. FR-022: mensaje de temporal vencida (cambio sobre la 002)

**Decisión**: el backend no cambia (sigue respondiendo el código `TEMPORARY_PASSWORD_EXPIRED`; los textos los pone el frontend, R12 de la 002). En el frontend cambia el texto en dos sitios de producción y en el fixture de pruebas:

| Archivo | Tipo | Cambio |
|---|---|---|
| `frontend/src/app/core/api/problem.ts` (línea `TEMPORARY_PASSWORD_EXPIRED`) | producción | texto de FR-022 |
| `frontend/src/app/features/auth/login.page.ts` (`'temporary-expired'`) | producción | texto de FR-022 y enlace "¿Olvidaste tu contraseña?" junto al mensaje |
| `frontend/src/testing/auth-fixtures.ts` (`AUTH_MESSAGES.TEMPORARY_PASSWORD_EXPIRED` y `LOGIN_REASON_MESSAGES['temporary-expired']`) | **fixture de pruebas** | texto de FR-022 |

Pruebas existentes cuyo resultado cambia (todas comparan contra el fixture, así que su código no cambia; solo cambia el valor esperado y los comentarios de cabecera que citan el texto literal):
- `frontend/src/app/core/api/problem.auth.spec.ts`: `[US5-AC9] TEMPORARY_PASSWORD_EXPIRED → mensaje de temporal vencida` (y el comentario de la línea 12).
- `frontend/src/app/features/auth/login.page.spec.ts`: `[US5-AC9] 401 TEMPORARY_PASSWORD_EXPIRED → mensaje de contraseña temporal vencida` (y el comentario de la línea 23).
- `frontend/src/app/features/auth/login.page.session.spec.ts`: el caso parametrizado `['temporary-expired', '[US5-AC9]']` (y el comentario de la línea 9).
- `frontend/src/app/features/auth/change-password.page.spec.ts`: solo el comentario de la línea 31 (la prueba comprueba la navegación a `?reason=temporary-expired`, no el texto).

Ninguna prueba del backend cambia (`auth-login.e2e-spec.ts` y `auth-password.e2e-spec.ts` comprueban el código, no el texto).

**Procedimiento** (principio II): la modificación del fixture es una tarea del `tester` que va en rojo primero (el fixture con el texto nuevo hace fallar las 3 pruebas), seguida de la tarea del `implementer-frontend` que cambia `problem.ts` y `login.page.ts`. El PR la justifica explícitamente ("cambio de requisito FR-022 de la spec 003 sobre US5-AC9 de la 002") y la aprueba un humano, como exige la spec (Assumptions).

## R13. Frontend

**Decisión**:
- **"¿Olvidaste tu contraseña?"** (US1-AC11, FR-001, FR-026):
  - enlace visible en `/login` debajo del botón de entrar, a un toque, con objetivo táctil de 44 px; lleva a `/forgot-password` (con `guestGuard`, como `/login`) y precarga el correo si ya estaba escrito;
  - `features/auth/forgot-password.page`: un campo de correo (normalizado como en la 002), validación local (US1-AC8), y tras 202 el texto de FR-003 en lugar del formulario; con 429, "Demasiadas solicitudes. Intente de nuevo más tarde"; enlace de vuelta a `/login`. Mobile-first desde 360 px.
- **Panel de soporte separado** (US2):
  - rutas hijas de `/support`, cargadas de forma diferida bajo un `SupportShellComponent` con su propia cabecera ("Soporte MotorSync", nombre del agente y "Cerrar sesión"). La cabecera del taller (`app.html`) no se muestra en `/support/**`.
  - Rutas: `/support/login` (`supportGuestGuard`), `/support/change-password`, `/support` (bandeja), `/support/tickets/:id` (detalle, descartar, generar temporal), `/support/workshops` (lista y búsqueda), `/support/workshops/:id` (cuentas, con enlace "Ver bitácora de este taller") y `/support/access-log` (bitácora de solo lectura con filtros por taller y por agente, que se aplican tocando el taller o el agente de una fila y se ven como chips que se pueden quitar; FR-027). Todas salvo login con `supportAuthGuard`; con temporal pendiente, solo `/support/change-password`.
  - `core/support/support-session.store.ts`: signals del agente, separados de `SessionStore` del taller, con su token en `localStorage` bajo otra clave (`motorsync.support.token`). Ningún guard de taller acepta la sesión de soporte ni al revés.
  - `auth-token.interceptor.ts` (M): a `/api/v1/support/**` le pone el token de soporte y al resto el del taller; nunca los dos.
  - `support-refresh.interceptor.ts` (N): el mismo comportamiento que `auth-refresh.interceptor` (single-flight, `REFRESH_CONFLICT`, redirecciones) contra `/support/auth/refresh`, solo para URLs del panel; el de taller ignora las URLs del panel.
  - Bandeja: tabla con los campos de US2-AC7, del más antiguo al más reciente, fechas en hora de Ecuador (`America/Guayaquil`). Detalle del ticket: campo de nota con la advertencia "No escriba contraseñas en la nota", botón "Generar contraseña temporal" (deshabilitado sin nota) y diálogo que muestra la temporal una vez con "Copiar" y el aviso de que no se volverá a mostrar; "Descartar" con motivo obligatorio.
  - Pensado para computadoras y tablets (FR-026); objetivos táctiles de 44 px igualmente.
- **Auditoría del taller** (002, M): `user-detail.page` muestra el actor `platform_support` como "(Soporte MotorSync)" y la acción nueva con su número de ticket.
- **Mock** (`ng serve --configuration mock`): `core/api/mock-support.store.ts` (N) con cuentas de soporte, sesiones, tickets, talleres y bitácora, y las rutas `/auth/forgot-password` y `/support/**` en `mock-api.interceptor.ts` con las mismas reglas del contrato (límite por origen simulado, un ticket abierto por cuenta, una temporal por ticket, separación de tokens). `forgot-password` consulta las cuentas de `mock-auth.store.ts` y la temporal de soporte las actualiza, para recorrer el flujo entero sin backend.

**Alternativas**: una segunda aplicación Angular para el panel (dos builds y dos despliegues para pocas pantallas; YAGNI); mostrar el panel dentro de la cabecera del taller (mezcla las dos identidades en la misma barra).

## R14. Entrega en 3 PRs (cortes verticales) más la enmienda

0. **PR de la enmienda 1.3.0** (leader, `docs: amend constitution 1.3.0`): entra a `main` antes que cualquier código.
1. **PR1, pedir ayuda y bandeja de soporte (US1, US2)**: bootstrap de `motorsync_support`; migraciones de cuentas, sesiones, tickets, eventos, límite y funciones de US1/US2; triggers de FR-024; `SUPPORT_JWT_SECRET`; `@SupportArea`, guard y `SupportTransactionInterceptor`; login, refresh, logout, me y cambio de contraseña de soporte; `forgot-password`; bandeja y descarte; script de operaciones; seed. Frontend: enlace y página de "¿Olvidaste tu contraseña?", FR-022, login y bandeja del panel, mock.
2. **PR2, contraseña temporal por soporte (US3)**: migración `AllowSupportAuditActor`; funciones de bloqueo y resolución del ticket; extracción de `applyTemporaryPassword`; endpoint de generación; `recordAsSupport`; e2e de concurrencia y atomicidad. Frontend: detalle del ticket con nota y diálogo de la temporal; historial de la 002 con el actor de soporte.
3. **PR3, consulta de talleres y bitácora (US4)**: `support_access_log`, funciones de talleres, cuentas y lectura de la bitácora, endpoints y pantallas (talleres, cuentas y bitácora).

PR2 y PR3 dependen de PR1 y son independientes entre sí. Si PR1 resulta demasiado grande para una revisión, se parte en PR1a (backend) y PR1b (frontend contra el mock), como en la 002.
