# Implementation Plan: Autenticación, talleres y usuarios

**Branch**: `feat/002-autenticacion` | **Date**: 2026-10-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-autenticacion/spec.md`

**Aprobación**: pendiente; requiere aprobación humana de spec y plan antes de implementar.

## Summary

Alta pública del taller con su primer administrador, inicio de sesión con correo y contraseña, sesión que expira tras 30 minutos de inactividad y se puede cerrar, gestión de las cuentas del equipo (crear con contraseña temporal, rol, desactivar o reactivar, restablecer contraseña) y cambio de la propia contraseña. Todo con aislamiento entre talleres y auditoría de los cambios de cuentas.

Enfoque técnico:
- Se reutiliza la base de la 001: `JwtAuthGuard` (HS256), `TenantTransactionInterceptor` (`set_config` por transacción), `AuditService.record`, los validadores de RUC (`src/common/identifiers`) y `application/problem+json`.
- `@Public()` marca registro, login, refresh y logout. En esas rutas el interceptor no fija taller y el servicio lo fija después de resolver la identidad.
- La búsqueda de la cuenta antes de conocer el taller (login, refresh) y la creación del taller (registro) pasan por **funciones `SECURITY DEFINER` con dueño `motorsync_auth`**: un rol sin login y con políticas RLS dirigidas a él (R1).
- Contraseñas con `node:crypto.scrypt`, sal por usuario y hash ficticio para igualar tiempos (R3).
- Token de acceso JWT de 15 minutos con `sid` y `pwd_change`. Refresh opaco rotativo en cookie `HttpOnly; Secure; SameSite=Strict` con detección de reutilización (R5).
- **Validación de la sesión en cada request** dentro de la transacción existente: da revocación inmediata, rol vigente, inactividad exacta de 30 minutos y la restricción de la contraseña temporal (R6, R7).
- Bloqueo de 5 fallos y 15 minutos por correo en `login_attempts`, con upsert atómico y sin Redis (R4).
- Último administrador protegido con advisory lock por taller y un trigger diferido de respaldo (R8).
- Frontend Angular: login, registro, cambio de contraseña, gestión de usuarios, refresh single-flight y guards; mock del contrato para avanzar en paralelo (R13).

## Technical Context

**Language/Version**: TypeScript 6 (`strict: true`) sobre Node 22 (CI) o 24 (local). Backend ESM.

**Primary Dependencies**: las de la 001. **Sin dependencias nuevas** en backend ni frontend:
- `node:crypto`: scrypt, `randomBytes`, `createHash`, `timingSafeEqual`.
- `@nestjs/jwt`: ya está.
- Cookies: lectura con un parser propio y escritura con `res.cookie` de Express.

**Storage**: PostgreSQL 16.
- Tablas nuevas: `users`, `user_sessions` y `refresh_tokens`, con `tenant_id` y RLS `ENABLE` + `FORCE`; y `login_attempts`, global y técnica.
- `tenants`: columna `ruc` nullable y RLS `ENABLE`.
- Rol nuevo `motorsync_auth` (`NOLOGIN`, `NOBYPASSRLS`).
- 7 funciones `auth_*` `SECURITY DEFINER`.
- DDL en [data-model.md](./data-model.md).

**Testing**:
- Vitest. Unitarias: hasher, cookies, guard, `SessionValidator`, servicios y DTOs.
- E2e contra PostgreSQL real, cuyo tiempo se manipula con el migrator: `last_activity_at`, `temp_password_expires_at`, `locked_until`.
- Prueba de RLS a nivel de base para las tablas nuevas.
- Frontend: Vitest + jsdom.

**Target Platform**: igual que la 001: API en Linux (contenedor) y web en teléfonos desde 360 px y tablets.

**Project Type**: aplicación web (monorepo `backend/` + `frontend/`).

**Performance Goals**:
- Login (scrypt N=2^15) de unos 100 ms en el servidor.
- Validación de sesión: una sentencia por clave primaria por request (unos 1–2 ms).
- El p95 < 200 ms de las búsquedas de la 001 (SC-001) no cambia: `test:perf` usa tokens sin `sid`.

**Constraints**:
- El taller sale solo de la credencial verificada en el servidor.
- Las contraseñas nunca aparecen en respuestas, logs ni auditoría.
- Mismo origen (sin CORS).
- Ninguna suite de la 001 se modifica salvo los fixtures de truncado.
- Objetivos táctiles de al menos 44 px.

**Scale/Scope**:
- 5 historias, 14 operaciones en 12 rutas.
- 4 tablas nuevas y 7 funciones.
- 7 pantallas: login, registro, cambio de contraseña, lista de usuarios, crear usuario, ficha de usuario y diálogo de restablecer.

No quedan `NEEDS CLARIFICATION`: la spec cerró clarify (sesión 2026-10-22) y las decisiones técnicas están en [research.md](./research.md) R1–R14.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluado antes de la fase 0 y **reevaluado después del diseño** (data-model, contrato).

**Resultado: PASA con una observación pendiente de decisión humana (IV-a)** y dos excepciones justificadas en Complexity Tracking: `login_attempts` sin `tenant_id` y `tenants` sin `FORCE`.

### I. Aislamiento multi-tenant (NON-NEGOTIABLE)

| Regla | Cómo se cumple | Estado |
|---|---|---|
| `tenant_id uuid NOT NULL`, indexado y con FK a `tenants` en toda tabla de negocio | `users`, `user_sessions` y `refresh_tokens` tienen `tenant_id NOT NULL REFERENCES tenants(id)` e índice `*_tenant_id_idx`. FK compuestas `(tenant_id, user_id)` y `(tenant_id, session_id)` impiden relaciones entre talleres. `login_attempts` no es de negocio (Complexity Tracking). | Cumple |
| RLS `ENABLE` + `FORCE` con política sobre `app.tenant_id` | Las tres tablas tienen `ENABLE` + `FORCE` y una política `USING`/`WITH CHECK` con `app_current_tenant()`. Las únicas excepciones son políticas `TO motorsync_auth` (solo `SELECT`, más `INSERT` del registro con `WITH CHECK` sobre el taller fijado), que solo alcanzan al código de las funciones `SECURITY DEFINER` (R1). | Cumple |
| El tenant se fija por transacción a partir del token autenticado; nunca del body, query ni headers | Rutas protegidas: igual que la 001 (claim `tenant_id` del JWT verificado). Rutas públicas: el `tenant_id` lo devuelve la base después de verificar la credencial (contraseña o hash del refresh token), y la app hace `set_config(..., true)` antes de cualquier otra operación (R2). `forbidNonWhitelisted` rechaza `tenantId` y `role` en los DTOs. | Cumple (interpretación: en login y refresh la credencial verificada cumple el papel del token; ver nota I-a) |
| Rol de app sin `BYPASSRLS`; migraciones con rol separado | `motorsync_app` y `motorsync_migrator` sin cambios. `motorsync_auth` también es `NOBYPASSRLS` y `NOLOGIN`; la app no es miembro, solo tiene `EXECUTE` sobre 7 funciones. | Cumple |
| Prueba de que A no lee ni modifica datos de B, por módulo | E2e: US1-AC10, US2-AC11, US3-AC7, US4-AC17, AC18, AC19, AC20, US5-AC8. De base: `db/auth-rls.e2e-spec.ts` (sin taller → 0 filas; con A no se ve B; `login_attempts` sin permiso; las funciones devuelven solo las columnas definidas). | Cumple |

**I-a (nota)**: las funciones `auth_find_user_for_login` y `auth_find_refresh_token` leen entre talleres por diseño, porque el login no pide taller (FR-007). Quedan acotadas a una búsqueda por igualdad de un secreto (correo + verificación de contraseña en Node, o hash de 256 bits) y devuelven columnas mínimas. Es el mismo patrón que tendrá que analizar la 003 (soporte de plataforma), que la spec ya marca como el primer acceso real entre talleres.

### II. Test-First (NON-NEGOTIABLE)

| Regla | Cómo se cumple | Estado |
|---|---|---|
| Prueba roja antes del código | `tasks.md` (siguiente paso) ordena pares `tester` → `implementer-*`. Los hooks impiden que los implementers toquen pruebas. | Cumple |
| Cada criterio tiene al menos una prueba que cita su ID | Convención de la 001: el `it()` empieza por el ID (`US2-AC9 cuenta todos los intentos simultáneos`). Se verifica en `/speckit-analyze`. | Cumple |
| Una prueba roja se arregla en producción | Lo imponen los hooks y el `reviewer`. Única edición prevista en pruebas existentes: agregar las tablas nuevas a `BUSINESS_TABLES` de `test/setup/db-fixtures.ts`, una tarea del `tester` justificada en el PR1. | Cumple |
| Backend: Vitest unitarias y e2e contra PostgreSQL real | Sí, sin mocks de base. El tiempo se simula escribiendo fechas con el migrator, nunca con relojes falsos en la base. | Cumple |

### III. Especificación y contratos primero

| Regla | Cómo se cumple | Estado |
|---|---|---|
| `spec.md`, `plan.md` y `tasks.md` aprobados por un humano | Spec con clarify cerrado (6 respuestas del 2026-10-22); este plan; `tasks.md` después de la aprobación. | Cumple (pendiente de aprobación) |
| OpenAPI en `contracts/` antes de implementar | [contracts/openapi.yaml](./contracts/openapi.yaml) (OpenAPI 3.1) con rutas públicas y protegidas, la cookie `ms_refresh` y todos los `code`. | Cumple |
| Frontend y backend en paralelo contra el contrato | El mock del frontend agrega `/auth` y `/users` con las reglas del contrato (R13). | Cumple |
| Spec de negocio; stack solo en el plan | `spec.md` no menciona tecnologías. | Cumple |

### IV. Auditoría inmutable

| Regla | Cómo se cumple | Estado |
|---|---|---|
| Eventos listados: "cambios de rol de usuarios" | `user.role_changed` con `before.role` y `after.role` (US4-AC12). | Cumple |
| Campos: `tenant_id`, actor y rol, acción, entidad, id, antes y después, fecha UTC, IP o canal | `audit_log` de la 001 sin cambios de DDL; `entity_type = 'user'`. | Cumple |
| Append-only | Sin cambios: `GRANT SELECT, INSERT` y el trigger de la 001. `GET /users/{id}/history` es solo lectura. | Cumple |
| Misma transacción | `AuditService.record` con el manager del request, junto con el `UPDATE` de la cuenta y la revocación de sesiones (US4-AC14). | Cumple |
| **Eventos nuevos**: desactivación, reactivación y restablecimiento de contraseña | La spec los exige (FR-021), pero la constitución 1.1.0 no los lista. Ver **IV-a**. | Pendiente de decisión humana |

**IV-a (recomendación: enmienda MINOR 1.2.0)**. Como en la 001 (IV-a, enmienda 1.1.0), se recomienda un PR propio `docs: amend constitution 1.2.0` que agregue al principio IV la "desactivación y reactivación de cuentas de usuario y restablecimiento de contraseña por un administrador". Debe aprobarlo ambos integrantes, según Governance.
- Alternativa: tratarlo como ampliación compatible (el principio fija un mínimo y no prohíbe auditar más) y registrarlo solo en este plan.
- La enmienda es preferible porque convierte estos eventos en obligatorios para futuras features, como la 003, que también restablecerá contraseñas.
- **Decide el humano.** Este plan no edita la constitución.

### V. Simplicidad y tipado estricto

| Regla | Cómo se cumple | Estado |
|---|---|---|
| `strict: true`, sin `any` | Igual que la 001. Los resultados de `manager.query()` y de las funciones `auth_*` se tipan en un mapper por consulta. | Cumple |
| DTOs validados en el borde | DTOs nuevos con class-validator. Validadores nuevos `IsPassword` y `IsEmailNormalized`; el RUC reutiliza `IsEcDocument`/`isValidRuc`. | Cumple |
| YAGNI | Sin Redis, colas, Passport, `cookie-parser`, bcrypt ni argon2. Sin tabla de roles ni permisos (2 roles fijos). Sin versión optimista en `users` (ningún criterio la pide). | Cumple |
| Fechas `timestamptz` UTC | Todas. No hay dinero. | Cumple |

### Restricciones técnicas

| Restricción | Cómo se cumple | Estado |
|---|---|---|
| Stack Angular + NestJS + PostgreSQL 16 | Sí. `GRANT … WITH INHERIT FALSE, SET TRUE` requiere PG16, que ya es el del contenedor y el de CI. | Cumple |
| Búsqueda < 200 ms p95 | Sin cambios en las consultas de la 001. La validación de sesión agrega una sentencia por clave primaria. | Cumple |
| Móvil: 44 px | Pantallas nuevas mobile-first; "Cerrar sesión" a 2 toques como máximo (FR-025). | Cumple |
| Secretos fuera del repo | Sin secretos nuevos: el JWT reutiliza `JWT_SECRET`. `AUTH_ALLOW_SESSIONLESS_TOKENS` y `AUTH_COOKIE_SECURE` son banderas, no secretos. | Cumple |

### Flujo y arnés

Ciclo spec → clarify → **plan (aquí)** → tasks → issues. Este plan solo escribe en `specs/`. Los cambios en `db/bootstrap.sql`, `.env.example`, `ci.yml` y `test/setup/db-fixtures.ts` quedan como tareas para los roles correspondientes.

## Project Structure

### Documentation (this feature)

```text
specs/002-autenticacion/
├── spec.md
├── plan.md              # este archivo
├── research.md          # fase 0: decisiones R1–R14
├── data-model.md        # fase 1: DDL, RLS, funciones SECURITY DEFINER, GRANTs
├── quickstart.md        # fase 1: validación de punta a punta
├── contracts/
│   └── openapi.yaml     # fase 1: OpenAPI 3.1
├── checklists/
│   └── requirements.md
└── tasks.md             # fase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

Solo se listan archivos nuevos (N) o modificados (M).

```text
backend/
├── db/bootstrap.sql                                  # M: rol motorsync_auth + GRANT ... SET TRUE (R1)
├── scripts/
│   ├── seed-dev.ts                                   # M: RUC de los talleres + admin y asesor por taller
│   └── issue-dev-token.ts                            # M: avisa si AUTH_ALLOW_SESSIONLESS_TOKENS no está activo
├── src/
│   ├── app.module.ts                                 # M: AuthModule, UsersModule
│   ├── config/env.ts                                 # M: AUTH_ALLOW_SESSIONLESS_TOKENS, AUTH_COOKIE_SECURE
│   ├── common/
│   │   ├── identifiers/email.ts (+ .spec.ts)         # N: normalizeEmail, isValidEmail, emailHash
│   │   ├── validation/is-password.ts                 # N
│   │   └── problem-details.filter.ts                 # M: 403 → FORBIDDEN, 429 → ACCOUNT_LOCKED
│   ├── database/
│   │   ├── migrations/1761000000400-AddTenantRuc.ts           # N
│   │   ├── migrations/1761000000500-CreateUsers.ts            # N
│   │   ├── migrations/1761000000600-CreateSessions.ts         # N
│   │   ├── migrations/1761000000700-CreateLoginAttempts.ts    # N
│   │   ├── migrations/1761000000800-CreateAuthFunctions.ts    # N
│   │   ├── pg-errors.ts                              # M: tenants_ruc_key, users_email_key, users_last_admin
│   │   └── tenant-transaction.interceptor.ts         # M: @Public, SessionValidator, @Roles, @AllowPendingPasswordChange
│   ├── auth/
│   │   ├── public.decorator.ts                       # N: @Public()
│   │   ├── roles.decorator.ts                        # N: @Roles('admin')
│   │   ├── allow-pending-password-change.decorator.ts # N
│   │   ├── jwt-auth.guard.ts                         # M: Reflector, sid/pwd_change opcionales, TOKEN_EXPIRED
│   │   ├── auth-user.ts                              # M: sessionId?, mustChangePassword
│   │   ├── password-hasher.ts                        # N: scrypt + hash ficticio (R3)
│   │   ├── cookies.ts                                # N: parse del header Cookie + opciones de ms_refresh (R11)
│   │   ├── auth-transaction.ts                       # N: withAuthTransaction (R2)
│   │   ├── session-validator.ts                      # N: validación por request (R6)
│   │   ├── sessions.service.ts                       # N: crear, rotar, revocar sesiones y refresh tokens (R5)
│   │   ├── login-throttle.service.ts                 # N: auth_login_* (R4)
│   │   ├── access-token.service.ts                   # N: firma del JWT con sid y pwd_change
│   │   ├── auth.service.ts                           # N: register, login, refresh, logout, me, changePassword
│   │   ├── auth.controller.ts                        # N: /auth/*
│   │   ├── auth.module.ts                            # N
│   │   └── dto/                                      # N: register, login, change-password
│   ├── users/
│   │   ├── users.module.ts                           # N
│   │   ├── users.controller.ts                       # N: /users/*  (@Roles('admin'))
│   │   ├── users.service.ts                          # N: crear, rol, activar, restablecer, último admin (R8)
│   │   ├── user.entity.ts                            # N (sin password_hash en las lecturas)
│   │   └── dto/                                      # N: create-user, change-role, reset-password
│   └── audit/audit-log.entity.ts                     # M: acciones user.*, entity_type 'user'
└── test/
    ├── setup/db-fixtures.ts                          # M (tester): BUSINESS_TABLES + createUser() con hash
    ├── setup/auth.ts                                 # M (tester): loginAs(), cookies de supertest
    ├── db/auth-rls.e2e-spec.ts                       # N
    ├── auth-register.e2e-spec.ts                     # N  US1
    ├── auth-login.e2e-spec.ts                        # N  US2 (incluye tiempos y concurrencia)
    ├── auth-session.e2e-spec.ts                      # N  US3
    ├── auth-password.e2e-spec.ts                     # N  US5
    ├── users.e2e-spec.ts                             # N  US4 (gestión, último admin, concurrencia)
    └── users-audit.e2e-spec.ts                       # N  US4 auditoría y aislamiento

frontend/src/app/
├── app.routes.ts                                     # M: /login, /register, /change-password, /users…, guards
├── app.config.ts                                     # M: authRefreshInterceptor
├── app.ts / app.html                                 # M: barra con usuario, taller y "Cerrar sesión"
├── core/
│   ├── api/api.models.ts                             # M: tipos del contrato 002
│   ├── api/auth-api.service.ts (+ spec)              # N
│   ├── api/users-api.service.ts (+ spec)             # N
│   ├── api/mock-api.interceptor.ts / mock-api.store.ts   # M: rutas /auth y /users
│   └── auth/
│       ├── session.store.ts (+ spec)                 # N: signals de la sesión
│       ├── auth-refresh.interceptor.ts (+ spec)      # N: refresh single-flight, redirecciones
│       └── auth.guards.ts (+ spec)                   # N: authGuard, adminGuard, passwordChangeGuard
├── features/auth/
│   ├── login.page.* | register.page.* | change-password.page.*   # N
└── features/users/
    ├── users-list.page.* | user-form.page.* | user-detail.page.* | reset-password.dialog.*  # N
```

Además, fuera de `backend/` y `frontend/`: `.env.example` (M: las 2 banderas) y `.github/workflows/ci.yml` (M: `AUTH_ALLOW_SESSIONLESS_TOKENS: 'true'` en el job de backend).

**Structure Decision**: monorepo web existente. Dos módulos de backend nuevos: `auth` (ya existe la carpeta, se amplía) y `users`. Pantallas en `features/auth` y `features/users`, siguiendo el patrón de la 001.

## Entrega propuesta: 3 PRs (cortes verticales)

| PR | Historias | Contenido | Criterios cubiertos |
|---|---|---|---|
| **PR1: base, registro e inicio de sesión** | US1, US2 | Bootstrap (`motorsync_auth`), 5 migraciones, `@Public`, hasher, `login-throttle`, `AuthService.register/login`, `access-token` con `sid`, `SessionValidator` en el interceptor (revocación y rol vigente), `AUTH_ALLOW_SESSIONLESS_TOKENS`, `pg-errors`, filtro 403/429, seed-dev con usuarios, e2e de RLS. Frontend contra el mock: login y registro. | US1-AC1 a AC10; US2-AC1 a AC12 (AC12 en backend: 401 sin token) |
| **PR2: sesión y frontend** | US3, US5 | `refresh` (rotación, reutilización, carrera, inactividad), `logout`, `GET /auth/me`, `POST /auth/password`, restricción `PASSWORD_CHANGE_REQUIRED`, vencimiento de 72 h, cookie y CSRF. Frontend: `session.store`, interceptor de refresh, guards, cambio de contraseña, barra con "Cerrar sesión", retiro de `/dev-token` de producción. | US3-AC1 a AC7; US5-AC1 a AC9 (con cuentas temporales creadas por fixture) |
| **PR3: gestión de usuarios** | US4 | `/users` completo con `@Roles('admin')`, último administrador (advisory lock + trigger), revocación al desactivar y restablecer, `auth_clear_login_failures`, auditoría `user.*` e historial. Frontend: pantallas de usuarios. | US4-AC1 a AC24 |

Cada PR deja la 001 en verde y es desplegable por sí mismo. PR2 y PR3 dependen de PR1. PR3 solo depende de PR2 por los fixtures de sesión.

## Complexity Tracking

| Violación o excepción | Por qué se necesita | Alternativa más simple descartada porque |
|---|---|---|
| `login_attempts` sin `tenant_id` ni RLS (principio I: "toda tabla de negocio") | El bloqueo debe aplicarse por correo **exista o no** (US2-AC8), y un correo inexistente no tiene taller. No es dato de negocio: solo guarda un hash SHA-256 del correo, un contador y una fecha. | Contador en `users`: no cubre correos inexistentes y revela existencia. `motorsync_app` no tiene **ningún** privilegio sobre la tabla; solo la tocan 4 funciones. |
| `tenants` con RLS `ENABLE` sin `FORCE` | `tenants` es el registro de talleres, no una tabla de negocio con `tenant_id`. Sin `FORCE`, el migrator (dueño) sigue insertando talleres en fixtures, `seed-dev` y `seed-volume.sql` como en la 001, y ninguna suite de la 001 cambia. La app (no dueña) sí queda limitada a su propio taller. | `FORCE` obligaría a reescribir los fixtures de la 001 para fijar `app.tenant_id` antes de cada `INSERT INTO tenants`. Dejarla sin RLS y con `SELECT` para la app expondría todos los talleres. |
| Rol nuevo `motorsync_auth` y 7 funciones `SECURITY DEFINER` | El login sin taller (FR-007) y el registro (FR-004) necesitan leer o crear filas antes de conocer el taller (R1). | Dueño `motorsync_migrator`: no funciona con `FORCE` (es `NOBYPASSRLS`). Darle `BYPASSRLS` abre todas las tablas. |
| Una sentencia extra por request (validación de sesión) | FR-013 y US4-AC6 exigen revocación inmediata; FR-014 y US4-AC5, rol vigente en la siguiente acción; FR-012, inactividad exacta (R6). | Aceptar la ventana de 15 minutos del token de acceso viola la spec. |

## Riesgos y preguntas abiertas para el humano

1. **IV-a**: ¿enmienda MINOR 1.2.0 (recomendada) o justificación en el plan? Si es enmienda, ¿quién abre el PR `docs: amend constitution 1.2.0` antes del PR3?
2. **Bloqueo como denegación de servicio**: un tercero que conozca un correo puede bloquearlo 15 minutos de forma repetida. Se aceptó en la spec. Mitigarlo exigiría límites por IP o CAPTCHA (fuera de alcance).
3. **Carga de scrypt**: con el pool de libuv por defecto (4 hilos), muchos logins simultáneos se encolan. Si hace falta, se sube `UV_THREADPOOL_SIZE` en el despliegue; no cambia el código.
4. **Prueba de tiempos (US2-AC3, SC-003)**: es estadística y puede ser inestable en Windows. Se propone una tolerancia del 25 % sobre la mediana y correrla solo en CI si da falsos positivos en local.
5. **Carrera de refresh entre pestañas**: la ventana de 10 s sin revocar es un compromiso entre seguridad y uso. ¿Está bien ese valor?
6. **Tokens sin `sid`**: `AUTH_ALLOW_SESSIONLESS_TOKENS` debe quedar en `false` en cualquier despliegue real. Se propone que `loadEnv` falle al arrancar si es `true` y `NODE_ENV=production`.
7. **Administrador único sin acceso**: no hay recuperación hasta la feature 003 (soporte de plataforma). Riesgo aceptado en la spec.
8. **Funciones `SECURITY DEFINER` en migraciones futuras**: por `INHERIT FALSE`, toda migración que las cambie debe hacer `SET ROLE motorsync_auth` (data-model, "Mantenimiento"). Conviene anotarlo en "Lecciones" de `CLAUDE.md` si alguien lo olvida dos veces.
