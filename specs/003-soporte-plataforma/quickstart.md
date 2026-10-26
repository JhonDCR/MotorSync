# Quickstart: validar la feature 003 de punta a punta

Guía de validación manual y automática. Referencias: [contrato](./contracts/openapi.yaml), [data-model](./data-model.md), [research](./research.md). Los comandos base son los de `CLAUDE.md`.

## 0. Prerrequisitos

- La constitución 1.3.0 está en `main` (research R1, "Enmienda").
- Docker, Node 22 y el `.env` copiado de `.env.example`. Después de esta feature, `.env.example` incluye `SUPPORT_JWT_SECRET` (al menos 32 caracteres y distinto de `JWT_SECRET`). No tiene valor por defecto: la API no arranca sin ella. Las pruebas usan el valor de prueba de `vitest.config*.ts`.
- Si la base ya existía antes de esta feature, **vuelve a correr `db:bootstrap`**: crea el rol `motorsync_support`.

## 1. Base de datos

```bash
docker compose up -d
cd backend && npm run build
npm run db:bootstrap      # crea/actualiza también motorsync_support
npm run db:migrate        # CreateSupportAccounts, CreateSupportTickets, CreateSupportFunctions (+ las de PR2 y PR3)
npm run db:seed:dev       # además de los talleres A y B: la cuenta de soporte soporte@motorsync.test (no temporal en desarrollo)
```

Comprobaciones rápidas con `psql` y `DATABASE_URL` (como `motorsync_app`):
- `SELECT * FROM support_tickets;` → *permission denied* (R6).
- `SELECT count(*) FROM support_accounts;` → 1 sin taller fijado; `SELECT set_config('app.tenant_id', '<uuid taller A>', false); SELECT count(*) FROM support_accounts;` → 0 (R2).
- `SELECT * FROM support_list_open_tickets(gen_random_uuid());` → error `28000` (sin sesión de soporte, R1).
- `INSERT INTO support_accounts (…) VALUES (…);` → *permission denied* (FR-007).

## 2. Procedimiento de operaciones

```bash
cd backend
npm run support:account -- create --name "Pedro Soporte" --email " Pedro@MotorSync.EC "
# imprime una sola vez la temporal; la cuenta queda pedro@motorsync.ec, activa, temporal 72 h (US2-AC1)
npm run support:account -- create --name "Choque" --email admin@taller-a.test     # rechazado (FR-024)
npm run support:account -- list
npm run support:account -- deactivate --email pedro@motorsync.ec --confirm          # revoca sus sesiones (US2-AC10)
npm run support:account -- reactivate --email pedro@motorsync.ec --confirm
npm run support:account -- access-log --since 2026-10-25                             # bitácora (PR3)
```

Registrar después un taller con `pedro@motorsync.ec` (`POST /auth/register`) da 409 `REGISTRATION_FAILED`, como cualquier correo en uso (R5).

## 3. API (`npm run start:dev`)

Con `curl`, guardando cookies (`-c`/`-b`) y con `X-Requested-With: motorsync` en refresh y logout.

### "¿Olvidaste tu contraseña?" (PR1)

| Paso | Petición | Esperado |
|---|---|---|
| Correo existente | `POST /api/v1/auth/forgot-password` `{ "email": " Admin@Taller-A.test " }` | 202 sin body; aparece un ticket abierto en la bandeja (US1-AC1) |
| Repetido | la misma petición | 202; sigue un único ticket, `requestCount` 2 (US1-AC5) |
| Inexistente | `{ "email": "nadie@ejemplo.ec" }` | 202, mismo tiempo (piso de 400 ms); ningún ticket (US1-AC3) |
| Campos extra | `{ "email": "…", "tenantId": "<otro>" }` | 202; el ticket es del taller del correo (US1-AC9) |
| Inválido | `{ "email": "no-es-correo" }` | 400 `VALIDATION_ERROR` en `email`; no cuenta para el límite (US1-AC8) |
| Límite | 21 peticiones desde la misma IP | la 21.ª: 429 `HELP_RATE_LIMITED`, igual con correo existente o no (US1-AC6) |
| Sin efectos | login de la cuenta después de pedir ayuda | 200 con la contraseña de siempre; sus sesiones siguen (US1-AC4) |

### Panel de soporte (PR1)

| Paso | Petición | Esperado |
|---|---|---|
| Login | `POST /support/auth/login` con la temporal impresa | 200, `agent.mustChangePassword: true`; cookie `ms_support_refresh; Path=/api/v1/support/auth` |
| Temporal | `GET /support/tickets` | 403 `PASSWORD_CHANGE_REQUIRED`; `POST /support/auth/password` → 200 |
| Bandeja | `GET /support/tickets` | 200 con los campos de US2-AC7, del más antiguo al más reciente |
| Separación | `GET /support/tickets` con el token de un admin de taller | 403 `FORBIDDEN` (US2-AC5) |
| Separación | `GET /api/v1/users` o `/vehicles/search?q=PB` con el token de soporte | 403 `FORBIDDEN` (US2-AC6) |
| Credenciales cruzadas | `POST /auth/login` con las de soporte, `POST /support/auth/login` con las de un taller | ambos 401 `INVALID_CREDENTIALS` |
| Descartar | `POST /support/tickets/{id}/discard` `{ "reason": "   " }` y luego con motivo | 400 en `reason`; luego 200 `status: discarded` (US2-AC12) |
| Sin reapertura | volver a descartar | 409 `TICKET_NOT_OPEN` (US2-AC13) |
| Inactividad | como migrator: `UPDATE support_sessions SET last_activity_at = now() - interval '31 minutes' WHERE id = '<sid>'` | la siguiente petición: 401 `SESSION_EXPIRED` (US2-AC9) |

### Temporal por soporte (PR2)

| Paso | Petición | Esperado |
|---|---|---|
| Sin nota | `POST /support/tickets/{id}/temporary-password` `{ "verificationNote": " " }` | 400 en `verificationNote`; nada cambia (US3-AC3) |
| Con otro id | `{ "verificationNote": "…", "userId": "<otro>" }` | 400 `UNKNOWN_FIELD`; nada cambia (US3-AC9) |
| Generar | `{ "verificationNote": "Llamada al número registrado; confirmó RUC y nombre" }` | 200 con `temporaryPassword` del tipo `ABCD-EFGH-JKMN-PQRS` (19 caracteres con guiones, sin 0/O ni 1/I/L), `Cache-Control: no-store`; el ticket queda `resolved` (US3-AC1, US3-AC2) |
| Formato | login con la temporal sin guiones o en minúsculas | 401 `INVALID_CREDENTIALS` (los guiones forman parte de la contraseña); con la temporal tal cual → 200 |
| Efectos | la sesión anterior de la cuenta → `GET /auth/me` | 401 `SESSION_REVOKED`; login con la temporal → solo `/auth/password` (US3-AC4) |
| Auditoría | admin del taller: `GET /users/{id}/history` | un `user.password_reset_by_support` con `actorRole: platform_support`, `supportTicketNumber`, sin la temporal ni la nota (US3-AC6) |
| Segunda vez | repetir la generación | 409 `TICKET_NOT_OPEN` (US3-AC5) |
| Desactivada | ticket de una cuenta desactivada | 409 `ACCOUNT_INACTIVE` (US3-AC8) |
| Vencida | como migrator: `UPDATE users SET temp_password_expires_at = now() - interval '1 minute' WHERE id = '<id>'`; login | 401 `TEMPORARY_PASSWORD_EXPIRED`; el frontend muestra el texto de FR-022 |

### Consulta de talleres (PR3)

| Paso | Petición | Esperado |
|---|---|---|
| Listado | `GET /support/workshops` | 200, `pageSize: 50`, solo `id`, `name`, `ruc`, `createdAt` (US4-AC1) |
| Búsqueda | `?q=1790-0123 45001`, `?q=ANDRADE`, `?q=andradé` | incluye el taller (US4-AC2) |
| Cuentas | `GET /support/workshops/{id}/accounts` | 200 con `name`, `email`, `role`, `status`, `hasOpenTicket`; una fila nueva en `support_access_log` (US4-AC3, US4-AC6) |
| Inexistente | `GET /support/workshops/{uuid al azar}/accounts` | 404; sin fila en la bitácora (US4-AC7) |
| Bitácora | `GET /support/access-log` | 200, la consulta anterior primero, `pageSize: 50`, con agente (sin correo), taller, IP y canal (US4-AC8) |
| Filtros | `?workshopId=<A>`, `?agentId=<Marta>`, ambos | solo los registros que cumplen los filtros (US4-AC8) |
| Sin registro propio | contar filas de `support_access_log` antes y después de `GET /support/access-log` | igual (US4-AC9) |
| Solo lectura | `POST` o `DELETE /support/access-log` | 404, sin efectos (US4-AC9) |
| Separación | `GET /support/access-log` con el token de un admin de taller | 403 `FORBIDDEN` |

## 4. Pruebas automáticas

```bash
cd backend
npm run lint && npm test            # unitarias: guard por zona, SupportSessionValidator, generador de temporales, pipes, servicios
npm run test:e2e                    # e2e nuevas (support-*.e2e-spec.ts, auth-forgot-password.e2e-spec.ts, db/support-roles.e2e-spec.ts) + TODAS las de la 001 y la 002
cd ../frontend
npm run lint && npm test -- --watch=false
```

Criterios de la verificación:
- Todas las suites de la 001 y la 002 pasan; las únicas pruebas existentes cuyo valor esperado cambia son las de FR-022 (research R12), con la justificación en el PR.
- Cada `USx-ACy` de la spec 003 tiene al menos una prueba con su ID en el nombre.
- `db/support-roles.e2e-spec.ts` demuestra:
  - que `motorsync_app` no tiene privilegios sobre `support_tickets`, `support_ticket_events`, `support_access_log` ni `help_request_throttle`, ni `INSERT` sobre `support_accounts`;
  - que con un taller fijado las tablas de identidad de soporte se ven vacías;
  - que `motorsync_support` no puede leer `users.password_hash`, `clients`, `vehicles` ni `audit_log`;
  - que las funciones del panel fallan sin una sesión de soporte viva y con un taller fijado, y devuelven solo las columnas del data-model.
- Las pruebas de tiempos (US1-AC2, US1-AC6, SC-003) pasan en CI.
- Las e2e de concurrencia (US3-AC11, US3-AC12, SC-008) pasan sin 40P01.

## 5. Frontend

```bash
cd frontend
npx ng serve --configuration mock   # sin backend: /forgot-password y /support/** contra el mock
npm start                            # con backend (proxy /api → localhost:3000)
```

Recorrido:
1. En un teléfono de 360 px: `/login` → "¿Olvidaste tu contraseña?" (un toque, 44 px) → correo → mensaje de FR-003 (US1-AC11, FR-026).
2. En una computadora o tablet: `/support/login` → cambio de la temporal → bandeja → abrir el ticket → nota → "Generar contraseña temporal" → diálogo con la temporal y "Copiar" → la bandeja ya no lo muestra.
3. Con la temporal, `/login` del taller → `/change-password`.
4. Como admin del taller: `/users/{id}` → el historial muestra "Soporte MotorSync (<nombre>)" y "Restablecimiento de contraseña por soporte (ticket #N)".
5. Con sesión de taller abierta, ir a `/support` → redirige a `/support/login`; con sesión de soporte, ir a `/` → redirige a `/login`.
6. `/support/workshops` → buscar → abrir un taller → cuentas → "Ver bitácora de este taller" → `/support/access-log` filtrado; tocar un agente para filtrar también por él y quitar los filtros.
