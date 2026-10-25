# Implementation Plan: Soporte de la plataforma y recuperación de acceso

**Branch**: `feat/003-soporte-plataforma` | **Date**: 2026-10-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-soporte-plataforma/spec.md` (aprobada por el humano, commit 5605ad3)

**Aprobación**: decisiones del humano del 2026-10-25 incorporadas (ver "Decisiones del humano" al final). La **enmienda MINOR 1.3.0 está aprobada** con el texto de research R1. El leader abre su PR propio (`docs: amend constitution 1.3.0`), que es **prerrequisito del PR1**: debe estar en `main` antes de integrar cualquier código de esta feature.

## Summary

"¿Olvidaste tu contraseña?" en el inicio de sesión crea (o actualiza) un ticket de soporte sin revelar si el correo existe. Un panel de soporte, separado de los talleres, deja a las personas del equipo de MotorSync atender la bandeja, descartar tickets, consultar talleres y sus cuentas (solo campos de identificación) y generar una contraseña temporal para la cuenta de un ticket abierto, con la regla de temporales de la 002 y auditoría en el taller afectado. Las cuentas de soporte se crean y desactivan solo con un procedimiento de operaciones.

Enfoque técnico:
- **Acceso entre talleres sin `BYPASSRLS`**: un rol nuevo `motorsync_support` (`NOLOGIN`, `NOBYPASSRLS`) es dueño de funciones `SECURITY DEFINER` acotadas. Solo tiene `SELECT` sobre las columnas de identificación de `tenants` y `users`, y cada función del panel exige una sesión de soporte viva y que no haya taller fijado (R1).
- **Identidad de soporte fuera de los talleres**: tablas de plataforma `support_accounts`, `support_sessions` y `support_refresh_tokens`, visibles para la app solo cuando no hay taller fijado. La app no puede crear ni reactivar cuentas: no tiene esos privilegios (R2).
- **Separación de tokens en ambos sentidos**: JWT de soporte firmado con un secreto propio (`SUPPORT_JWT_SECRET`) y con `aud`, rutas bajo `/support` con `@SupportArea()`, cookie de refresh propia con otro `Path`, e interceptor de transacción propio que nunca fija taller (R3).
- **Reutilización de la 002**: hasher, bloqueo 5/15 (mismas funciones `auth_login_*`), política de refresh e inactividad de 30 minutos, `@AllowPendingPasswordChange()` y el núcleo del restablecimiento (R4, R9).
- **Tickets**: un abierto por cuenta con un índice único parcial y upsert atómico; estados inmutables una vez cerrados (triggers); historial append-only (R6).
- **"¿Olvidaste tu contraseña?"**: una única función con un piso fijo de tiempo de respuesta, límite de 20 por origen por hora guardando solo el hash de la IP, sin guardar correos inexistentes (R7, R8).
- **Temporal por soporte**: en una transacción, con el orden de locks **sesión de soporte → ticket → advisory lock del taller → sesiones → users**. El taller se fija desde el ticket leído en la base, y la auditoría se escribe en el taller afectado con actor `platform_support` (R9, R11).
- **Bitácora de soporte** append-only, escrita en la misma función que devuelve las cuentas de un taller, y consultable en el panel con una vista de solo lectura, paginada y filtrable por taller y por agente, que no se registra a sí misma (R10, FR-027).
- **Frontend**: enlace y página "¿Olvidaste tu contraseña?", y panel `/support/**` con su propio shell, store de sesión, guards e interceptores; mock para todo (R13).

## Technical Context

**Language/Version**: TypeScript 6 (`strict: true`) sobre Node 22 (CI) o 24 (local). Backend ESM. Igual que la 002.

**Primary Dependencies**: las de la 002. **Sin dependencias nuevas** en backend ni frontend (`node:crypto` para `randomInt`, `createHash` y scrypt; `@nestjs/jwt` para el segundo secreto).

**Storage**: PostgreSQL 16.
- Rol nuevo `motorsync_support` en `db/bootstrap.sql`.
- Tablas nuevas: `support_accounts`, `support_sessions`, `support_refresh_tokens`, `support_tickets`, `support_ticket_events`, `help_request_throttle` y `support_access_log`.
- 12 funciones `support_*` y 2 funciones de trigger para FR-024.
- `audit_log`: CHECK de `actor_role` ampliado.
- DDL en [data-model.md](./data-model.md).

**Testing**:
- Vitest. Unitarias: guard por zona, `SupportSessionValidator`, generador de temporales, `ForgotPasswordBodyPipe`, servicios y DTOs.
- E2e contra PostgreSQL real, con el tiempo manipulado por el migrator (`last_activity_at`, `window_started_at`, `temp_password_expires_at`).
- Prueba de roles y RLS a nivel de base (`db/support-roles.e2e-spec.ts`).
- Pruebas estadísticas de tiempo como la de la 002.
- Frontend: Vitest + jsdom.

**Target Platform**: API en Linux (contenedor). "¿Olvidaste tu contraseña?" en teléfonos desde 360 px y tablets; panel en computadoras y tablets (FR-026).

**Project Type**: aplicación web (monorepo `backend/` + `frontend/`).

**Performance Goals**:
- `POST /auth/forgot-password`: piso de 400 ms por diseño (R7); el trabajo real es de unos pocos milisegundos.
- Panel: una sentencia de validación de sesión por request más la función; la bandeja y la lista de talleres son consultas sobre decenas o cientos de filas.
- El p95 de búsqueda de la 001 (US1-AC10, `test:perf`) no cambia: no se tocan sus consultas ni índices.

**Constraints**:
- El tenant nunca sale del cliente: en el panel no se fija, salvo en la generación de la temporal, donde sale del ticket leído en la base (R9).
- Las contraseñas (incluida la temporal generada, después de mostrarla una vez) nunca aparecen en respuestas posteriores, logs, tickets ni auditoría.
- `SUPPORT_JWT_SECRET` obligatorio, de al menos 32 caracteres y distinto de `JWT_SECRET` (`loadEnv` falla al arrancar).
- En producción, `trust proxy` configurado: el límite por origen depende de la IP real (R8, riesgo 3).
- Ninguna suite de la 001 ni de la 002 se modifica, salvo el fixture de mensajes de FR-022 (R12) y los fixtures de truncado.
- Objetivos táctiles de al menos 44 px.

**Scale/Scope**:
- 4 historias.
- 13 operaciones nuevas en 13 rutas, más un cambio de esquema en `GET /users/{id}/history` de la 002.
- 7 tablas nuevas, 12 funciones más 2 de trigger, y 6 migraciones.
- 1 script de operaciones.
- 9 pantallas: "¿Olvidaste tu contraseña?", login y cambio de contraseña del panel, bandeja, detalle del ticket con el diálogo de la temporal, talleres, cuentas del taller, bitácora de soporte, y ajuste del historial de la 002.

No quedan `NEEDS CLARIFICATION`: la spec cerró clarify (sesión 2026-10-25) y las decisiones técnicas están en [research.md](./research.md) R1–R14. Las decisiones abiertas del plan las resolvió el humano el 2026-10-25 (ver "Decisiones del humano").

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluado antes de la fase 0 y **reevaluado después del diseño** (data-model, contrato).

**Resultado: PASA con la enmienda 1.3.0, aprobada por el humano el 2026-10-25** (I-a e IV-a); el PR de la constitución debe estar en `main` antes del PR1. Sin la enmienda, el principio I **no se cumple**: el listado de talleres y cuentas es un acceso entre talleres fuera de la autenticación, y la 1.2.0 dice literalmente "Cualquier otro acceso entre talleres requiere una enmienda". Las excepciones restantes están justificadas en Complexity Tracking.

### I. Aislamiento multi-tenant (NON-NEGOTIABLE)

| Regla (1.2.0) | Cómo se cumple | Estado |
|---|---|---|
| `tenant_id uuid NOT NULL`, indexado y con FK a `tenants` en toda tabla de negocio | No hay tablas de negocio de taller nuevas. `support_tickets` y `support_access_log` tienen `tenant_id NOT NULL REFERENCES tenants(id)` e índice; `support_tickets` usa además la FK compuesta `(tenant_id, user_id) → users (tenant_id, id)`. `support_accounts`, `support_sessions`, `support_refresh_tokens`, `support_ticket_events` y `help_request_throttle` son de plataforma, sin taller (Complexity Tracking). | Cumple (con excepciones justificadas) |
| RLS `ENABLE` + `FORCE` con política sobre `app.tenant_id` | Las tablas de taller (`users`, `user_sessions`, `audit_log`…) conservan su RLS `FORCE`; solo ganan políticas `FOR SELECT TO motorsync_support` en `users` y `tenants`, que solo alcanzan al código de las funciones (R1). Las tablas de soporte tienen RLS `ENABLE` sin `FORCE` (precedente: `tenants`) con políticas `app_current_tenant() IS NULL` para la app o solo `TO motorsync_support` (R2, R6). | Cumple (excepción "sin `FORCE`" justificada) |
| El tenant se fija por transacción a partir del token o, en las rutas de autenticación, de la credencial verificada; nunca del cliente | `POST /auth/forgot-password`: no fija taller (la función resuelve todo, R7). Panel: nunca fija taller, salvo en la generación de la temporal, donde el tenant sale de la fila del ticket que devuelve `support_lock_open_ticket`, nunca del body (R9). Los DTOs rechazan `tenantId` y `userId` (US3-AC9); `forgot-password` los ignora (US1-AC9). | **Requiere enmienda 1.3.0** (I-a): "del ticket abierto leído en la base" no es token ni credencial |
| Lecturas entre talleres solo en funciones acotadas a la autenticación (igualdad de secreto o identificador, columnas mínimas, sin `BYPASSRLS`); cualquier otro acceso requiere enmienda | `support_request_help` es de autenticación (recuperación) y busca por igualdad del correo: cabe en la 1.2.0. Las funciones del panel (`support_list_open_tickets`, `support_get_ticket`, `support_list_workshops`, `support_list_workshop_accounts`, `support_list_access_log`) **no** son de autenticación, y `support_list_workshops` busca por parte del nombre. Están acotadas (sesión de soporte viva como capacidad, sin taller fijado, columnas de FR-013 y FR-016, privilegios por columna, bitácora) y no usan `BYPASSRLS`. | **Requiere enmienda 1.3.0** (I-a) |
| Rol de app sin `BYPASSRLS`; migraciones con rol separado | `motorsync_app` y `motorsync_migrator` sin cambios de atributos. `motorsync_support` es `NOLOGIN`, `NOBYPASSRLS` y `NOINHERIT`; la app no es miembro: solo tiene `EXECUTE` sobre las funciones públicas del panel. | Cumple |
| Prueba de que A no lee ni modifica datos de B, por módulo | `db/support-roles.e2e-spec.ts` (privilegios, RLS de plataforma, columnas, compuertas). E2e: US2-AC5, US2-AC6, US2-AC11, US3-AC9, US3-AC10, US4-AC4, US4-AC5 y FR-025 (un admin del taller A no ve tickets ni nada del B). | Cumple |

**I-a (resuelta por la enmienda 1.3.0, aprobada el 2026-10-25)**: texto propuesto completo en [research.md](./research.md#enmienda-de-la-constitución-necesaria-130-minor). En resumen: (1) el tenant también puede salir "del ticket abierto leído en la base" en la generación de la temporal por soporte; (2) se agrega un segundo caso de funciones acotadas, las del panel de soporte (sesión de soporte vigente, solo lectura, solo datos de identificación que fija la spec, bitácora de las consultas de cuentas); (3) viñeta nueva: las cuentas y tokens de soporte no pertenecen a ningún taller y no sirven en la zona del otro, y la única escritura de soporte sobre un taller es la temporal de un ticket abierto. **El leader la aplica en un PR propio (`docs: amend constitution 1.3.0`), aprobado por ambos integrantes, que entra en `main` ANTES del PR1, como pasó con la 1.2.0.** Este plan no edita la constitución. La vista de la bitácora (US4-AC8, FR-027) también cae en el caso (b): lee datos de identificación de talleres (nombre y RUC) y nombres de agentes, solo lectura.

### II. Test-First (NON-NEGOTIABLE)

| Regla | Cómo se cumple | Estado |
|---|---|---|
| Prueba roja antes del código | `tasks.md` (siguiente paso) ordena pares `tester` → `implementer-*`; los hooks impiden que los implementers toquen pruebas. | Cumple |
| Cada criterio tiene al menos una prueba que cita su ID | Convención de la 001 y la 002 (`it('US3-AC12 …')`); se verifica en `/speckit-analyze`. | Cumple |
| Una prueba roja se arregla en producción | **Única modificación prevista de pruebas existentes**: el fixture `frontend/src/testing/auth-fixtures.ts` y los comentarios de 4 specs, por el cambio de requisito FR-022 (research R12). La hace el `tester` (rojo primero), con justificación en el PR y aprobación humana, como exige la spec. Además, agregar las tablas nuevas a `BUSINESS_TABLES` de `test/setup/db-fixtures.ts` (como en la 002). | Cumple (con la justificación de R12) |
| Backend: Vitest unitarias y e2e contra PostgreSQL real | Sí, sin mocks de base; el tiempo se simula con el migrator. La atomicidad (US3-AC7) se prueba con un trigger temporal del migrator que fuerza el fallo. | Cumple |

### III. Especificación y contratos primero

| Regla | Cómo se cumple | Estado |
|---|---|---|
| `spec.md`, `plan.md` y `tasks.md` aprobados por un humano | Spec aprobada (5605ad3); este plan, pendiente; `tasks.md` después. | Cumple (pendiente de aprobación del plan) |
| OpenAPI en `contracts/` antes de implementar | [contracts/openapi.yaml](./contracts/openapi.yaml) (OpenAPI 3.1): `forgot-password`, `/support/**`, cookie `ms_support_refresh`, códigos nuevos y la sección "Cambios a la 002" (`UserAuditEntry`). | Cumple |
| Frontend y backend en paralelo contra el contrato | Mock `mock-support.store.ts` con las reglas del contrato (R13). | Cumple |
| Un cambio de contrato pasa primero por la spec | El cambio de `UserAuditEntry` de la 002 sale de FR-020 y US3-AC6 de esta spec; FR-022 cambia un texto de la 002 por decisión de esta spec. | Cumple |
| Spec de negocio; stack solo en el plan | `spec.md` no menciona tecnologías. | Cumple |

### IV. Auditoría inmutable

| Regla (1.2.0) | Cómo se cumple | Estado |
|---|---|---|
| Eventos listados: "restablecimiento de contraseñas por un administrador" | La temporal por soporte es un evento nuevo, `user.password_reset_by_support`, con un actor que no es usuario del taller. | **Requiere enmienda 1.3.0** (IV-a) |
| Campos: `tenant_id`, actor y rol, acción, entidad, id, antes y después, UTC, IP o canal | `tenant_id` del ticket; `actor_user_id` = id de la cuenta de soporte; `actor_name` = nombre del agente; `actor_role = platform_support` (migración que amplía el CHECK); `before` y `after` con `supportTicketNumber`; `ip` y `channel = support_panel` (R11). | Cumple (con la migración del CHECK) |
| Append-only | Sin cambios en `audit_log` (`GRANT SELECT, INSERT` y trigger de la 001). Bitácora y eventos del ticket también son append-only (trigger + sin privilegios de la app). | Cumple |
| Misma transacción | `recordAsSupport` usa el manager de la transacción del request, junto con la contraseña, las sesiones, el bloqueo y el cierre del ticket (US3-AC7). | Cumple |

**IV-a (resuelta por la enmienda 1.3.0, aprobada el 2026-10-25)**: como en la 002, se podría argumentar que el principio IV fija un mínimo y no prohíbe auditar más. Pero la spec pide justificarlo, y el campo "actor y su rol" se escribió pensando en usuarios del taller. Queda incluido en la misma enmienda 1.3.0: "restablecimiento de contraseñas por un administrador **o por soporte de la plataforma**" y "actor y su rol **(un usuario del taller o un agente de soporte de la plataforma)**".

### V. Simplicidad y tipado estricto

| Regla | Cómo se cumple | Estado |
|---|---|---|
| `strict: true`, sin `any` | Igual que la 002. Los resultados de las funciones `support_*` se tipan en un mapper por consulta. `SupportAgent` y `AuthUser` son tipos distintos. | Cumple |
| DTOs validados en el borde | DTOs con class-validator. `ForgotPasswordBodyPipe` es la única excepción a `forbidNonWhitelisted` (US1-AC9) y valida igual con class-validator. | Cumple |
| YAGNI | Sin dependencias nuevas, colas, Redis ni segundo factor. Un solo rol de soporte, sin permisos internos. La vista de la bitácora reutiliza la tabla y las compuertas de R1, sin endpoints auxiliares para los filtros. Se reutiliza el código de la 002 en lugar de copiarlo. El secreto JWT propio es la única pieza "extra" (confirmada por el humano). | Cumple |
| Fechas `timestamptz` UTC | Todas. No hay dinero. | Cumple |

### Restricciones técnicas

| Restricción | Cómo se cumple | Estado |
|---|---|---|
| Stack Angular + NestJS + PostgreSQL 16 | Sí (`GRANT … WITH INHERIT FALSE, SET TRUE`, como en la 002). | Cumple |
| Búsqueda < 200 ms p95 | Sin cambios en las consultas de la 001. | Cumple |
| Móvil: 44 px | "¿Olvidaste tu contraseña?" mobile-first desde 360 px. El panel apunta a computadoras y tablets, también con 44 px. | Cumple |
| Secretos fuera del repo | `SUPPORT_JWT_SECRET` en `.env` (local) y en GitHub Secrets o en la configuración de las pruebas (CI). La temporal del procedimiento de operaciones solo sale por `stdout` del operador. | Cumple |

### Flujo y arnés

Ciclo spec → clarify → **plan (aquí)** → tasks → issues. Este plan solo escribe en `specs/`. Quedan como tareas para los roles correspondientes:
- leader: enmienda 1.3.0, `.env.example`, `ci.yml` (si hace falta exportar `SUPPORT_JWT_SECRET`) y la línea de `motorsync_support` en "Lecciones" de `CLAUDE.md`;
- implementers: `db/bootstrap.sql`, `vitest.config*.ts`;
- tester: `test/setup/db-fixtures.ts` y `frontend/src/testing/auth-fixtures.ts`.

## Project Structure

### Documentation (this feature)

```text
specs/003-soporte-plataforma/
├── spec.md
├── plan.md              # este archivo
├── research.md          # fase 0: decisiones R1–R14 y texto de la enmienda 1.3.0
├── data-model.md        # fase 1: DDL, RLS, funciones SECURITY DEFINER de motorsync_support, GRANTs
├── quickstart.md        # fase 1: validación de punta a punta
├── contracts/
│   └── openapi.yaml     # fase 1: OpenAPI 3.1
├── checklists/
│   └── requirements.md
└── tasks.md             # fase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

Solo se listan archivos nuevos (N) o modificados (M). Entre paréntesis, el PR.

```text
backend/
├── db/bootstrap.sql                                       # M (PR1): rol motorsync_support (R1)
├── package.json                                           # M (PR1): script support:account
├── scripts/
│   ├── support-account.ts (+ .spec.ts)                    # N (PR1): procedimiento de operaciones (R5); access-log en PR3
│   └── seed-dev.ts                                        # M (PR1): cuenta soporte@motorsync.test
├── src/
│   ├── app.module.ts                                      # M (PR1): SupportModule, SupportTransactionInterceptor, SupportSessionValidator
│   ├── config/env.ts (+ spec)                             # M (PR1): SUPPORT_JWT_SECRET (≥32, distinto de JWT_SECRET)
│   ├── common/problem-details.filter.ts                   # M (PR1): códigos HELP_RATE_LIMITED, TICKET_NOT_OPEN, ACCOUNT_INACTIVE
│   ├── database/
│   │   ├── migrations/1761000001000-CreateSupportAccounts.ts          # N (PR1)
│   │   ├── migrations/1761000001100-CreateSupportTickets.ts           # N (PR1)
│   │   ├── migrations/1761000001200-CreateSupportFunctions.ts         # N (PR1)
│   │   ├── migrations/1761000001300-AllowSupportAuditActor.ts         # N (PR2)
│   │   ├── migrations/1761000001400-CreateSupportPasswordFunctions.ts # N (PR2)
│   │   ├── migrations/1761000001500-CreateSupportAccessLog.ts         # N (PR3)
│   │   ├── pg-errors.ts                                   # M (PR1): 28000 → SESSION_REVOKED, P0002 → NOT_FOUND en funciones support_*
│   │   └── tenant-transaction.interceptor.ts              # M (PR1): no actúa en rutas @SupportArea()
│   ├── auth/
│   │   ├── jwt-auth.guard.ts (+ spec)                     # M (PR1): verificación por zona, 403 FORBIDDEN cruzado (R3)
│   │   ├── refresh-token-policy.ts (+ spec)               # N (PR1): lógica pura extraída de sessions.service (R4)
│   │   ├── sessions.service.ts                            # M (PR1): usa refresh-token-policy (sin cambio de comportamiento)
│   │   ├── cookies.ts (+ spec)                            # M (PR1): nombre y Path parametrizados (ms_support_refresh)
│   │   ├── auth.controller.ts                             # M (PR1): POST /auth/forgot-password (@Public)
│   │   ├── forgot-password.service.ts (+ spec)            # N (PR1): support_request_help + piso de tiempo (R7)
│   │   └── forgot-password-body.pipe.ts (+ spec)          # N (PR1): ignora campos extra (US1-AC9)
│   ├── support/
│   │   ├── support-area.decorator.ts                      # N (PR1): @SupportArea()
│   │   ├── support-agent.ts                               # N (PR1): tipo SupportAgent, request.supportAgent
│   │   ├── support-context.ts                             # N (PR1): supportStorage (AsyncLocalStorage)
│   │   ├── support-transaction.interceptor.ts (+ spec)    # N (PR1): transacción sin taller + validación (R3)
│   │   ├── support-session-validator.ts (+ spec)          # N (PR1): R4
│   │   ├── support-access-token.service.ts                # N (PR1): JWT con SUPPORT_JWT_SECRET y aud
│   │   ├── support-sessions.service.ts                    # N (PR1): crear, rotar, revocar (tablas de soporte)
│   │   ├── support-auth.service.ts / .controller.ts       # N (PR1): login, refresh, logout, me, password
│   │   ├── support-tickets.service.ts / .controller.ts    # N (PR1): bandeja, detalle, descartar
│   │   ├── support-password.service.ts (+ spec)           # N (PR2): temporal por soporte (R9)
│   │   ├── temporary-password-generator.ts (+ spec)       # N (PR1): 16 caracteres, randomInt (lo usa también el script)
│   │   ├── support-workshops.service.ts / .controller.ts  # N (PR3): talleres y cuentas
│   │   ├── support-access-log.service.ts / .controller.ts # N (PR3): bitácora de solo lectura (FR-027)
│   │   ├── support.module.ts                              # N (PR1)
│   │   └── dto/                                           # N: support-login, discard-ticket (PR1), generate-temporary-password (PR2), list-workshops (PR3)
│   ├── users/
│   │   ├── apply-temporary-password.ts (+ spec)           # N (PR2): núcleo extraído de resetPassword (R9)
│   │   └── users.service.ts                               # M (PR2): resetPassword usa apply-temporary-password
│   └── audit/
│       ├── audit-log.entity.ts                            # M (PR2): user.password_reset_by_support, AuditActorRole
│       └── audit.service.ts (+ spec)                      # M (PR2): recordAsSupport (R11)
└── test/
    ├── setup/db-fixtures.ts                               # M (tester, PR1): BUSINESS_TABLES + createSupportAccount(), createTicket()
    ├── setup/support.ts                                   # N (tester, PR1): loginAsSupport(), cookies de soporte
    ├── db/support-roles.e2e-spec.ts                       # N (PR1, ampliada en PR2 y PR3): roles, RLS, columnas, compuertas
    ├── auth-forgot-password.e2e-spec.ts                   # N (PR1): US1 (incluye tiempos y concurrencia)
    ├── support-auth.e2e-spec.ts                           # N (PR1): US2-AC1 a AC6, AC9, AC10
    ├── support-tickets.e2e-spec.ts                        # N (PR1): US2-AC7, AC8, AC11 a AC13
    ├── support-operations.e2e-spec.ts                     # N (PR1): script de operaciones y FR-024
    ├── support-password.e2e-spec.ts                       # N (PR2): US3-AC1 a AC10, AC13
    ├── support-password-concurrency.e2e-spec.ts           # N (PR2): US3-AC11, AC12 (y atomicidad, AC7)
    ├── support-workshops.e2e-spec.ts                      # N (PR3): US4-AC1 a AC7
    └── support-access-log.e2e-spec.ts                     # N (PR3): US4-AC8, AC9

frontend/src/
├── testing/auth-fixtures.ts                               # M (tester, PR1): mensaje de FR-022 (R12)
├── testing/support-fixtures.ts                            # N (tester, PR1): mensajes literales de la spec 003
└── app/
    ├── app.routes.ts                                      # M (PR1): /forgot-password, /support/** (lazy)
    ├── app.config.ts                                      # M (PR1): supportRefreshInterceptor
    ├── app.ts / app.html                                  # M (PR1): sin cabecera del taller en /support/**
    ├── core/
    │   ├── api/api.models.ts                              # M: tipos del contrato 003 (PR1) y UserAuditEntry ampliado (PR2)
    │   ├── api/problem.ts                                 # M (PR1): FR-022 y códigos nuevos
    │   ├── api/auth-api.service.ts (+ spec)               # M (PR1): forgotPassword()
    │   ├── api/support-api.service.ts (+ spec)            # N (PR1; ampliado en PR2 y PR3)
    │   ├── api/mock-support.store.ts (+ spec)             # N (PR1; ampliado en PR2 y PR3)
    │   ├── api/mock-api.interceptor.ts                    # M (PR1): /auth/forgot-password y /support/**
    │   ├── auth/auth-token.interceptor.ts (+ spec)        # M (PR1): token de soporte solo para /api/v1/support/**
    │   ├── auth/auth-refresh.interceptor.ts               # M (PR1): ignora las URLs del panel
    │   └── support/
    │       ├── support-session.store.ts (+ spec)          # N (PR1)
    │       ├── support-refresh.interceptor.ts (+ spec)    # N (PR1)
    │       └── support.guards.ts (+ spec)                 # N (PR1): supportAuthGuard, supportGuestGuard, supportPasswordChangeGuard
    ├── features/auth/
    │   ├── login.page.*                                   # M (PR1): enlace "¿Olvidaste tu contraseña?" y FR-022
    │   └── forgot-password.page.*                         # N (PR1)
    ├── features/support/
    │   ├── support-shell.component.*                      # N (PR1)
    │   ├── support-login.page.* | support-change-password.page.*   # N (PR1)
    │   ├── tickets-inbox.page.*                           # N (PR1)
    │   ├── ticket-detail.page.*                           # N (PR1: ver y descartar; PR2: nota y generar)
    │   ├── temporary-password.dialog.*                    # N (PR2)
    │   ├── workshops-list.page.* | workshop-accounts.page.*        # N (PR3)
    │   └── access-log.page.*                              # N (PR3): bitácora con filtros por taller y agente
    └── features/users/user-detail.page.*                  # M (PR2): actor "Soporte MotorSync" y acción nueva
```

Además (leader): `.env.example` (`SUPPORT_JWT_SECRET`), `backend/vitest.config.ts` y `vitest.config.e2e.ts` (un `SUPPORT_JWT_SECRET` de prueba, distinto de `JWT_SECRET`), y `.github/workflows/ci.yml` solo si el job de e2e no toma la variable de la configuración de Vitest.

**Structure Decision**: monorepo web existente. Un módulo de backend nuevo, `support`, más cambios acotados en `auth` (guard por zona, "¿Olvidaste tu contraseña?", política de refresh extraída), `users` (núcleo de la temporal extraído) y `audit` (`recordAsSupport`). En el frontend, `features/support` y `core/support`, con rutas diferidas bajo `/support`.

## Entrega propuesta: enmienda + 3 PRs (cortes verticales)

| PR | Historias | Contenido | Criterios cubiertos |
|---|---|---|---|
| **PR0 (leader): `docs: amend constitution 1.3.0`** | — | Texto de research R1, **aprobado por el humano el 2026-10-25**. Lo aprueban ambos integrantes en GitHub. **Prerrequisito del PR1**: entra a `main` antes. | — |
| **PR1: pedir ayuda, acceso de soporte y bandeja** | US1, US2 | Bootstrap y migraciones 1000–1200; FR-024 en triggers; `SUPPORT_JWT_SECRET`; guard por zona, `@SupportArea`, `SupportTransactionInterceptor`, `SupportSessionValidator`; login, refresh, logout, me y password de soporte (reutilizando la 002); `forgot-password` con el piso de tiempo y el límite; bandeja, detalle y descarte; script de operaciones; seed. Frontend: enlace y página de "¿Olvidaste tu contraseña?", FR-022, login, cambio de contraseña y bandeja del panel, mock. | US1-AC1 a AC11; US2-AC1 a AC13 |
| **PR2: contraseña temporal por soporte** | US3 | Migraciones 1300–1400; `applyTemporaryPassword` extraído (las e2e de la 002 siguen en verde); `SupportPasswordService` con el orden de locks de R9; `recordAsSupport`; e2e de concurrencia y atomicidad. Frontend: nota, generación y diálogo de la temporal; historial de la 002 con el actor de soporte. | US3-AC1 a AC13 |
| **PR3: consulta de talleres y bitácora** | US4 | Migración 1500; `support_list_workshops`, `support_list_workshop_accounts` y `support_list_access_log`; endpoints `/support/workshops*` y `GET /support/access-log`; `support:account -- access-log`. Frontend: talleres, cuentas y bitácora (filtros por taller y agente). | US4-AC1 a AC9 |

PR2 y PR3 dependen de PR1 y son independientes entre sí. PR1 es el más grande: si la revisión lo pide, se parte en PR1a (backend) y PR1b (frontend contra el mock), como en la 002. Con solo el PR1 desplegado, los tickets se acumulan sin poder resolverse: **no conviene liberar el PR1 a producción sin el PR2** (sí integrarlo a `main`).

## Complexity Tracking

| Violación o excepción | Por qué se necesita | Alternativa más simple descartada porque |
|---|---|---|
| Acceso entre talleres fuera de la autenticación (principio I, 1.2.0) | US2-AC7 (bandeja con datos de cuentas de todos los talleres) y US4 (talleres y sus cuentas) lo exigen por definición. | No hay alternativa dentro de la 1.2.0: se resuelve con la enmienda 1.3.0 (I-a), con funciones acotadas sin `BYPASSRLS`. |
| Rol nuevo `motorsync_support` y 12 funciones `SECURITY DEFINER` (más 2 de trigger) | Leer `users` (RLS `FORCE`) entre talleres sin `BYPASSRLS`, solo con las columnas permitidas (R1). | Reutilizar `motorsync_auth`: mezclaría la excepción de autenticación con la del panel. `BYPASSRLS`: prohibido. |
| Tablas de plataforma sin `tenant_id` (`support_accounts`, `support_sessions`, `support_refresh_tokens`, `support_ticket_events`, `help_request_throttle`) | Las cuentas de soporte no pertenecen a ningún taller (FR-008); el contador por origen no conoce el correo ni el taller (FR-004); los eventos van por su ticket. Ninguna contiene datos de negocio de un taller. | Meterlas en `users` con un taller ficticio: rompe la separación de US2-AC5 y US2-AC6 y contamina la 002 (R2). |
| Tablas de soporte con RLS `ENABLE` sin `FORCE` | El migrator (dueño) las usa en el procedimiento de operaciones, `seed-dev` y los fixtures, como `tenants` en la 002. La app sigue limitada por la política (identidad: solo sin taller) o no tiene privilegios (tickets, eventos, bitácora). | `FORCE` con políticas extra para el migrator: más políticas solo para operaciones y pruebas. |
| `support_tickets` y `support_access_log` con `tenant_id` pero sin la política por `app.tenant_id` | Son de la plataforma, no del taller: el taller no debe verlas ("Es de la plataforma, no lo ve el taller"). La app no tiene ningún privilegio sobre ellas. | Política por taller: el taller vería sus tickets (fuera de alcance) y el panel no podría listar todos. |
| `POST /auth/forgot-password` sin `forbidNonWhitelisted` | US1-AC9 exige **ignorar** los identificadores extra, no rechazarlos (R7). | El pipe global respondería 400, en contra de la spec. |
| Segundo secreto JWT (`SUPPORT_JWT_SECRET`) | La separación de tokens "por cualquier otra vía" (US2-AC5, US2-AC6) no depende de un claim (R3). | Mismo secreto con `aud`: descartado por el humano el 2026-10-25. |
| Piso fijo de 400 ms en `forgot-password` | Respuesta indistinguible en tiempo (FR-003, FR-004, SC-003) aunque la rama "existe" escriba una fila (R7). | Igualar el trabajo a mano: frágil ante planes y locks distintos. |

## Riesgos

1. **Enmienda 1.3.0**: aprobada por el humano; sigue siendo bloqueante hasta que su PR (PR0 del leader) esté en `main`.
2. **Contraseña de soporte filtrada** (riesgo aceptado en clarify): permite generar temporales en cualquier taller con un ticket abierto. Lo mitigan el bloqueo 5/15, la inactividad de 30 minutos, la auditoría en el taller, el historial del ticket y la bitácora. Un tercero puede abrir un ticket para cualquier cuenta con "¿Olvidaste tu contraseña?", así que el ticket no es una barrera real frente a un agente comprometido. Segundo factor: mejora futura.
3. **`trust proxy` en producción**: sin él, `req.ip` es la del proxy y todos los usuarios comparten un solo límite de 20 solicitudes por hora (R8). Debe configurarse en el despliegue; no cambia el contrato.
4. **Pruebas de tiempo** (US1-AC2, US1-AC6, SC-003): son estadísticas. Con el piso de 400 ms deberían ser estables; si dan falsos positivos en Windows, correrlas solo en CI (como en la 002).
5. **Concurrencia y orden de locks**: el orden nuevo (sesión de soporte → ticket → advisory → sesiones → users) se prueba con las e2e de US3-AC11 y US3-AC12. Cualquier camino futuro que tome un ticket después del advisory lock de un taller rompería el orden: hay que anotarlo en research R8 de la 002 o en "Lecciones" si alguien lo hace.
6. **Mantenimiento de funciones `support_*`**: mismo riesgo que con `motorsync_auth` (`SET ROLE` obligatorio). Se propone ampliar la lección existente de `CLAUDE.md`.
7. **Cambio de comportamiento en la 002 por FR-024**: registrarse o crear una cuenta de taller con el correo de una cuenta de soporte pasa a fallar con el error genérico de siempre (R5). Es invisible para los talleres, pero cambia una regla de la 002.
8. **Temporal mostrada una vez**: si el agente la pierde, el usuario debe pedir ayuda de nuevo (aceptado en la spec, US3-AC2).
9. **`db:bootstrap` y secreto nuevo**: al actualizar hay que volver a correr `db:bootstrap` (rol `motorsync_support`) y definir `SUPPORT_JWT_SECRET`, o la API no arranca. Va en `CLAUDE.md` y en el quickstart.
10. **Tickets de asesores con administrador activo**: generan trabajo de soporte que debería atender el administrador del taller. Soporte los descarta con motivo (US2-AC12); si el volumen crece, habría que avisar en la página de "¿Olvidaste tu contraseña?" (fuera de alcance).

## Decisiones del humano (2026-10-25)

Resuelven todas las preguntas abiertas de la versión anterior del plan. Quedan reflejadas en la spec (Clarifications, US4-AC8, US4-AC9, FR-019, FR-027), en research, data-model, contrato y quickstart.

1. **Enmienda 1.3.0**: aprobada con el texto de research R1. El leader abre el PR de la constitución; es prerrequisito del PR1.
2. **`SUPPORT_JWT_SECRET` propio**: confirmado. Es una variable nueva en `.env.example` y en CI. **Sin valor por defecto en el código**: la API no arranca sin ella en ningún entorno. Las pruebas reciben un valor de prueba desde `vitest.config.ts` y `vitest.config.e2e.ts` (como hoy `AUTH_ALLOW_SESSIONLESS_TOKENS`), así que `ci.yml` solo cambia si algún job arranca la API fuera de Vitest (research R3).
3. **FR-024 en ambos sentidos**, con el error genérico de la 002 (`REGISTRATION_FAILED`, `EMAIL_UNAVAILABLE`): confirmado (research R5).
4. **Bitácora en el panel**: se agrega una vista de solo lectura (`GET /support/access-log`, pantalla `/support/access-log`).
   - Paginada de 50 en 50, de la más reciente a la más antigua.
   - Filtrable por taller y por agente, con filtros combinables y sin endpoints auxiliares.
   - Pasa por la función acotada `support_list_access_log`.
   - **No se registra a sí misma**: FR-018 cubre las consultas de cuentas de un taller, y la bitácora no muestra cuentas (research R10).
   - El script `access-log` se mantiene.
   - Va en el PR3 (US4-AC8, US4-AC9, FR-027).
5. **Piso de 400 ms** en "¿Olvidaste tu contraseña?": confirmado.
6. **Campos extra en `forgot-password`**: se ignoran y la respuesta es 202. Confirmado.
7. **Formato de la temporal**: `ABCD-EFGH-JKMN-PQRS`.
   - 16 caracteres del alfabeto `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, sin 0/O ni 1/I/L y solo mayúsculas para dictarla sin dudas, en 4 bloques con guiones.
   - **Los guiones forman parte de la contraseña**: son 19 caracteres, dentro de los 8–128 de FR-005 de la 002, que mide la longitud en caracteres y no exige clases de caracteres.
   - El login de la 002 no cambia y compara tal cual, así que la temporal se escribe con los guiones y en mayúsculas. El diálogo del panel lo advierte (research R9).

No quedan preguntas abiertas.
