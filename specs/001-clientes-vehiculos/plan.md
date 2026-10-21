# Implementation Plan: Registro de clientes y vehículos con búsqueda por placa

**Branch**: `feat/001-clientes-vehiculos` | **Date**: 2026-10-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-clientes-vehiculos/spec.md`

## Summary

Alta, búsqueda y edición de clientes (persona natural o empresa, con cédula, RUC o pasaporte de Ecuador) y de sus vehículos, con búsqueda por placa mientras se escribe en la recepción, transferencia auditada de propietario y aislamiento estricto entre talleres.

Enfoque técnico:
- API REST en NestJS 12 (`/api/v1`) sobre PostgreSQL 16 con RLS.
- Cada request abre una transacción con `set_config('app.tenant_id', <tenant del JWT>, true)` (TypeORM `QueryRunner` + `AsyncLocalStorage`).
- Búsqueda parcial con índices GIN `pg_trgm` + `btree_gin` compuestos por `tenant_id`.
- Auditoría append-only en `audit_log`, en la misma transacción.
- Bloqueo optimista con `version`.
- Frontend Angular 22 standalone, mobile-first, que avanza contra el contrato OpenAPI con un interceptor de mocks.

## Technical Context

**Language/Version**: TypeScript 6 (`strict: true`) sobre Node 22. Backend ESM (`"type": "module"`, `module: nodenext`).

**Primary Dependencies**:
- Backend: NestJS 12 (`@nestjs/common`, `core`, `platform-express`).
- Nuevas en backend:
  - `@nestjs/typeorm` + `typeorm` 0.3 + `pg` (datos, R1).
  - `@nestjs/jwt` (auth mínima, R3).
  - `class-validator` + `class-transformer` (DTOs, principio V).
- Frontend: Angular 22 standalone (`@angular/forms`, `@angular/router`, `HttpClient`). **Sin dependencias nuevas.**

**Storage**: PostgreSQL 16 con las extensiones `pg_trgm`, `unaccent` y `btree_gin`, y RLS `ENABLE` + `FORCE` en todas las tablas de negocio. Roles `motorsync_migrator` y `motorsync_app` (R2).

**Testing**:
- Backend: Vitest. Unitarias `*.spec.ts` en `src/`; e2e `*.e2e-spec.ts` en `test/` contra PostgreSQL real (contenedor local o service de CI); rendimiento `*.perf-spec.ts` en `test/perf/`.
- Frontend: Vitest + jsdom (`ng test`).

**Target Platform**:
- API: Linux (contenedor) y desarrollo en Windows/macOS.
- Web: navegadores modernos en teléfonos de gama media (desde 360 px) y tablets.

**Project Type**: aplicación web (monorepo `backend/` + `frontend/`).

**Performance Goals**: p95 < 200 ms en las búsquedas por placa, documento y VIN, con 10 talleres × (30 000 clientes + 50 000 vehículos) (SC-001).

**Constraints**:
- Taller tomado solo del JWT.
- El rol app sin `BYPASSRLS` y sin `DELETE`.
- Auditoría en la misma transacción.
- Objetivos táctiles de al menos 44 px.
- Presupuesto de bundle inicial de 500 kB (`angular.json`).

**Scale/Scope**:
- 4 historias, 10 operaciones en 8 rutas.
- 3 tablas de negocio + `tenants`.
- 6 pantallas: búsqueda de vehículos, ficha de vehículo, formulario de vehículo, búsqueda de clientes, ficha de cliente, formulario de cliente (más el diálogo de transferencia y `/dev-token`).

No quedan `NEEDS CLARIFICATION`: todo se resolvió en [research.md](./research.md).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluado antes de la fase 0 y **reevaluado después del diseño** (data-model, contrato). Resultado: **PASA con 2 observaciones que requieren decisión humana** (IV-a y II-a). Ninguna bloquea la implementación.

### I. Aislamiento multi-tenant (NON-NEGOTIABLE)

| Regla | Cómo se cumple | Estado |
|---|---|---|
| `tenant_id uuid NOT NULL`, indexada, con FK a `tenants` en toda tabla de negocio | `clients`, `vehicles` y `audit_log` tienen `tenant_id NOT NULL REFERENCES tenants(id)` e índice `*_tenant_id_idx` ([data-model](./data-model.md#ddl)). | Cumple |
| RLS `ENABLE` + `FORCE` con política sobre `current_setting('app.tenant_id')` | Las tres tablas tienen `ENABLE` + `FORCE` y una política `USING`/`WITH CHECK` con `app_current_tenant()` (envoltorio de `current_setting('app.tenant_id', true)`). | Cumple |
| `SET LOCAL app.tenant_id` por transacción desde el token; nunca del body, query ni headers | `TenantTransactionInterceptor`: `set_config('app.tenant_id', jwt.tenant_id, true)` dentro de la transacción del request. `forbidNonWhitelisted` rechaza `tenantId` en el body, y `X-Tenant-Id` se ignora (R3). | Cumple |
| Rol de app sin `BYPASSRLS`; migraciones con rol separado | `motorsync_app` (`NOBYPASSRLS`, no es dueño de tablas) y `motorsync_migrator`. Se crean con `db:bootstrap` en local y en CI (R2). | Cumple |
| Prueba de que A no lee ni modifica datos de B, por módulo | E2E de aislamiento en `clients`, `vehicles` y `audit`: US1-AC8, US1-AC9, US2-AC9, US2-AC10, US3-AC10, US3-AC11, US4-AC13, US4-AC14. Además, una prueba a nivel de BD (con `motorsync_app` y sin tenant → 0 filas; con tenant A no se ve B). | Cumple |
| Defensa adicional | FK compuesta `vehicles(tenant_id, owner_client_id) → clients(tenant_id, id)`: aunque la aplicación fallara, un vehículo no puede apuntar a un cliente de otro taller (las comprobaciones de FK no pasan por RLS). | Cumple (extra) |

### II. Test-First (NON-NEGOTIABLE)

| Regla | Cómo se cumple | Estado |
|---|---|---|
| Prueba roja antes del código | `tasks.md` ordenará pares `tester` → `implementer-*`. Los hooks impiden que los implementers toquen las pruebas. | Cumple |
| Cada criterio tiene al menos una prueba que cita su ID | Convención: el nombre del `it()` empieza por el ID (`US3-AC12 rechaza placa de auto con formato inválido`). La trazabilidad se verifica en `/speckit-analyze`. | Cumple |
| Una prueba roja se arregla en producción, no en la prueba | Lo imponen los hooks y el `reviewer`. | Cumple |
| Backend: unitarias con **Jest** y e2e contra PostgreSQL real | e2e contra PostgreSQL real: cumple. **Jest → Vitest**: el scaffold aprobado en el PR #2 usa Vitest. Ver **II-a**. | Observación |

**II-a (observación)**: la constitución nombra Jest; el repo usa Vitest desde el scaffold (#2, ya en `main`). El espíritu del principio (unitarias + e2e contra BD real, headless) se cumple igual. Se recomienda una **enmienda PATCH (1.0.1)** que diga "Vitest" o "el runner del scaffold". Queda registrado en Complexity Tracking.

### III. Especificación y contratos primero

| Regla | Cómo se cumple | Estado |
|---|---|---|
| `spec.md`, `plan.md` y `tasks.md` aprobados por un humano antes de implementar | Spec con clarify cerrado; este plan; `tasks.md` en el siguiente paso. Requiere aprobación humana. | Cumple (pendiente de aprobación) |
| OpenAPI en `contracts/` antes de implementar | [contracts/openapi.yaml](./contracts/openapi.yaml) (OpenAPI 3.1) con todas las operaciones, errores y códigos. | Cumple |
| Frontend y backend en paralelo contra el contrato | El frontend usa tipos escritos desde el contrato y un `mockApiInterceptor` (R8). | Cumple |
| Spec en términos de negocio; stack solo en el plan | `spec.md` no menciona tecnologías. | Cumple |

### IV. Auditoría inmutable

| Regla | Cómo se cumple | Estado |
|---|---|---|
| Eventos listados por la constitución | Ninguno aplica a esta feature (no hay presupuestos, OT, inventario ni roles). | n/a |
| Campos: `tenant_id`, actor, acción, entidad, id, antes y después (JSON), fecha UTC, IP o canal | Todos están en `audit_log`. Además se guardan `actor_name`, `actor_role` y `reason`. | Cumple |
| Append-only: el rol app solo tiene `INSERT` y `SELECT`; sin endpoints de edición ni borrado | `GRANT SELECT, INSERT`, más un trigger que rechaza `UPDATE`/`DELETE`. El contrato no expone escritura sobre la auditoría. | Cumple |
| Misma transacción que el cambio | `AuditService` usa el `EntityManager` de la transacción del request. Lo prueba US4-AC9. | Cumple |
| **Eventos nuevos de esta feature** | `vehicle.owner_changed`, `vehicle.plate_changed`, `vehicle.vin_changed` y `client.document_changed` **no están en la lista** del principio IV. Ver **IV-a**. | Observación |

**IV-a (observación)**: la spec (FR-020, US4-AC8, US4-AC11) exige auditar el cambio de propietario y el cambio de identificadores. La constitución no lo prohíbe: auditar más no viola "estos eventos se registran". Pero la lista es la referencia del `reviewer`, y conviene que sea completa. Se recomienda una **enmienda MINOR (1.1.0)** que agregue "cambio de propietario de un vehículo" y "modificación de placa, VIN o documento de identidad", y que mencione el campo opcional `reason` (motivo). **Decide el humano**; mientras tanto el plan implementa la auditoría tal como pide la spec.

### V. Simplicidad y tipado estricto

| Regla | Cómo se cumple | Estado |
|---|---|---|
| `strict: true`, sin `any` | Ambos `tsconfig` ya tienen `strict`. Los resultados de `manager.query()` (que devuelve `any`) se tipan en el borde, en un único mapper por consulta, con un comentario que lo justifica. | Cumple |
| DTOs validados en el borde con class-validator | `ValidationPipe` global (`whitelist`, `forbidNonWhitelisted`, `transform`) y validadores propios (`IsEcPlate`, `IsEcDocument`, `IsVin`) sobre funciones puras. | Cumple |
| YAGNI | Sin Redis, colas, motor de búsqueda, librería de UI, MSW ni generador de clientes. Solo 6 dependencias nuevas en el backend, todas necesarias; ninguna en el frontend. Historial de propietarios sobre `audit_log`, sin tabla extra. | Cumple |
| Dinero `numeric(12,2)`; fechas `timestamptz` UTC | No hay dinero en esta feature. Todas las fechas son `timestamptz` y la API las expone en ISO 8601 UTC. | Cumple |

### Restricciones técnicas

| Restricción | Cómo se cumple | Estado |
|---|---|---|
| Stack Angular + NestJS + PostgreSQL 16 en monorepo | Sí. El frontend no es todavía PWA (manifest/service worker): esta feature no lo necesita. | Cumple |
| Búsqueda < 200 ms p95 con índices `(tenant_id, columna)` | B-tree únicos `(tenant_id, plate)`, `(tenant_id, document_number)` y `(tenant_id, vin)`, más GIN `(tenant_id, … gin_trgm_ops)`. Prueba de volumen con `test:perf` (R4). | Cumple |
| Móvil: 44 px, gama media | Mobile-first desde 360 px, verificado en quickstart §4 (R9). La compresión de imágenes no aplica. | Cumple |
| Placas y VIN normalizados y únicos por tenant | Normalización en API y frontend, `COLLATE "C"` e índices únicos por tenant. Además un `CHECK` de formato de placa en la BD. | Cumple |
| Secretos fuera del repo | `JWT_SECRET` y las contraseñas de roles van en `.env` (local). En CI, `JWT_SECRET` se genera en el job y las contraseñas son de una BD efímera. | Cumple |

### Flujo y arnés

Ciclo spec → clarify → **plan (aquí)** → tasks → issues. Roles de agentes respetados: este plan solo escribe en `specs/`. Los cambios fuera de `specs/` (`.env.example`, `ci.yml`, `docker-compose.yml`) quedan como tareas para el leader o los implementers.

## Project Structure

### Documentation (this feature)

```text
specs/001-clientes-vehiculos/
├── spec.md
├── plan.md              # este archivo
├── research.md          # fase 0: decisiones R1–R9
├── data-model.md        # fase 1: DDL, índices, RLS, validaciones
├── quickstart.md        # fase 1: validación de punta a punta
├── contracts/
│   └── openapi.yaml     # fase 1: OpenAPI 3.1
├── checklists/
│   └── requirements.md
└── tasks.md             # fase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
backend/
├── db/
│   └── bootstrap.sql                       # roles + extensiones (R2), lo ejecuta scripts/db-bootstrap.ts
├── scripts/
│   ├── db-bootstrap.ts                     # npm run db:bootstrap (DATABASE_ADMIN_URL)
│   ├── seed-dev.ts                         # npm run db:seed:dev (talleres A y B de ejemplo)
│   └── issue-dev-token.ts                  # npm run token:dev
├── src/
│   ├── main.ts                             # prefijo /api/v1, ValidationPipe global, filtro de errores
│   ├── app.module.ts
│   ├── config/
│   │   └── env.ts                          # lee y valida DATABASE_URL, JWT_SECRET, …
│   ├── database/
│   │   ├── data-source.ts                  # DataSource app y migrator (entidades por referencia)
│   │   ├── migrate.ts                      # npm run db:migrate
│   │   ├── migrations/                     # *-CreateTenantsAndHelpers, -CreateClients, -CreateVehicles, -CreateAuditLog
│   │   ├── tenant-context.ts               # AsyncLocalStorage<{ manager, tenantId, user }>
│   │   ├── tenant-transaction.interceptor.ts
│   │   └── pg-errors.ts                    # 23505/23514 → errores de dominio
│   ├── auth/
│   │   ├── jwt-auth.guard.ts               # guard global HS256
│   │   ├── auth-user.ts                    # { userId, tenantId, role, name }
│   │   └── current-user.decorator.ts
│   ├── common/
│   │   ├── identifiers/                    # normalize.ts, plate.ts, vin.ts, ec-document.ts, phone.ts (+ *.spec.ts)
│   │   ├── validation/                     # decoradores class-validator sobre identifiers/
│   │   ├── reason-policy.ts                # FR-019: motivo obligatorio para asesor
│   │   └── problem-details.filter.ts       # application/problem+json con code
│   ├── audit/
│   │   ├── audit.module.ts
│   │   ├── audit.service.ts                # record() con el manager del contexto
│   │   └── audit-log.entity.ts
│   ├── clients/
│   │   ├── clients.module.ts
│   │   ├── clients.controller.ts           # /clients, /clients/search, /clients/:id
│   │   ├── clients.service.ts
│   │   ├── client.entity.ts
│   │   └── dto/
│   └── vehicles/
│       ├── vehicles.module.ts
│       ├── vehicles.controller.ts          # /vehicles, /vehicles/search, /vehicles/:id, transfers, history
│       ├── vehicles.service.ts
│       ├── ownership.service.ts            # transferencia + auditoría
│       ├── vehicle.entity.ts
│       └── dto/
├── test/
│   ├── setup/                              # globalSetup: migraciones; fixtures con el migrator; issueTestToken()
│   ├── db/rls.e2e-spec.ts                  # aislamiento y privilegios a nivel BD
│   ├── clients.e2e-spec.ts
│   ├── vehicles.e2e-spec.ts
│   ├── ownership.e2e-spec.ts
│   └── perf/
│       ├── seed-volume.sql
│       └── search.perf-spec.ts
└── vitest.config.perf.ts

frontend/
├── proxy.conf.json                         # /api → http://localhost:3000
└── src/app/
    ├── app.routes.ts                       # '' → búsqueda de vehículos; clients/*; vehicles/*; dev-token (solo dev)
    ├── core/
    │   ├── api/
    │   │   ├── api.models.ts               # tipos del contrato
    │   │   ├── vehicles-api.service.ts
    │   │   ├── clients-api.service.ts
    │   │   ├── problem.ts                  # code → mensaje en español
    │   │   └── mock-api.interceptor.ts     # USE_MOCK_API
    │   └── auth/
    │       ├── auth-token.interceptor.ts
    │       └── dev-token.page.ts
    ├── shared/
    │   ├── identifiers/                    # mismas reglas y vectores que el backend
    │   ├── validators/                     # ValidatorFn de Angular sobre identifiers/
    │   └── styles/_touch.scss              # $touch-target: 44px
    └── features/
        ├── vehicles/
        │   ├── vehicle-search.page.ts      # US1
        │   ├── vehicle-form.page.ts        # US3 + edición (US4)
        │   ├── vehicle-detail.page.ts      # ficha + historial de propietarios
        │   └── transfer-ownership.dialog.ts
        └── clients/
            ├── client-search.page.ts       # US4-AC1, AC2
            ├── client-form.page.ts         # US2 + edición
            └── client-detail.page.ts       # US4-AC3
```

**Structure Decision**: aplicación web con los dos proyectos ya existentes (`backend/`, `frontend/`). En el backend hay un módulo Nest por agregado (`clients`, `vehicles`) más dos módulos transversales (`audit`, `auth`) y la infraestructura de `database/`. En el frontend, una carpeta por agregado en `features/`, con `core/` (API y auth) y `shared/` (validación y estilos). Las pruebas unitarias van junto al archivo (`*.spec.ts`) y las e2e en `backend/test/`.

## Entrega por cortes verticales

La feature cabe en un solo `tasks.md`, pero se propone integrarla en **3 PRs** para revisar cambios pequeños:

1. **PR 1, base + US2**: bootstrap de roles, migraciones de `tenants` y `clients`, contexto de tenant, guard JWT, filtro de errores y prueba RLS de BD. Alta, consulta y búsqueda de clientes en API y frontend.
2. **PR 2, US3 + US1**: migración de `vehicles`, alta de vehículo, búsqueda por placa y VIN, pantalla inicial de búsqueda y prueba de rendimiento.
3. **PR 3, US4**: edición con `version`, migración de `audit_log`, transferencia con motivo, historial de propietarios y prohibición de borrado.

Si el humano prefiere features separadas, el PR 3 puede convertirse en `002-transferencia-propietario` sin cambiar el contrato.

## Cambios fuera de `specs/` que requieren las tareas

| Archivo | Cambio | Responsable sugerido |
|---|---|---|
| `.env.example` | Añadir `DATABASE_ADMIN_URL`, `DATABASE_MIGRATOR_URL`, `DATABASE_URL`, `DB_APP_PASSWORD`, `DB_MIGRATOR_PASSWORD`, `JWT_SECRET` (de ejemplo) | implementer-backend |
| `.github/workflows/ci.yml` | Variables de los 3 roles; pasos `db:bootstrap`, `build`, `db:migrate` antes de `test:e2e`; `JWT_SECRET` generado; paso `test:perf` | leader / implementer-backend |
| `backend/package.json` | Dependencias nuevas y scripts `db:bootstrap`, `db:migrate`, `db:seed:dev`, `token:dev`, `test:perf` | implementer-backend |
| `frontend/angular.json` | Configuración `mock` y `proxyConfig` | implementer-frontend |

## Riesgos

| Riesgo | Mitigación |
|---|---|
| TypeORM 0.3 (CJS) en un backend ESM con Vitest: carga de entidades y metadatos de decoradores | Entidades y migraciones registradas por referencia; `type` explícito en cada `@Column`. La primera tarea del PR 1 es una prueba e2e "humo" de conexión + transacción + `set_config`, que valida la integración antes de construir encima. |
| Un servicio usa el `DataSource` global en lugar del manager del contexto y se salta `set_config` | Con RLS, una consulta sin tenant devuelve 0 filas y falla de forma visible, no filtra datos. Además el `reviewer` lo revisa (la regla es que solo `tenant-context.ts` toca el `DataSource`). |
| El p95 de la búsqueda de 2 caracteres por "contiene" | GIN compuesto con `tenant_id` acota a ≤ 50 000 filas. Si `test:perf` falla, plan B: para 2 caracteres, solo prefijo. Esto cambiaría el comportamiento de US1-AC3 y habría que volver a la spec. |
| RUC de sociedades que no cumplen el módulo 11 | Se valida solo la estructura (R7). Ver la pregunta P1. |
| Pool de conexiones: una transacción por request retiene la conexión durante todo el request | Los requests son cortos y sin E/S externa. Pool por defecto de 10 conexiones; se mide en `test:perf`. |

## Preguntas abiertas para el humano

- **P1**: ¿Aceptan validar el RUC de sociedades (tercer dígito 9 o 6) solo por estructura, sin dígito verificador módulo 11, para no rechazar RUC reales emitidos por el SRI? Es la opción por defecto del plan. La alternativa es exigir el módulo 11 y aceptar falsos rechazos.
- **P2**: ¿Aprueban las enmiendas recomendadas de la constitución: **MINOR 1.1.0** (eventos auditables nuevos y campo `reason`, IV-a) y **PATCH 1.0.1** (Vitest en lugar de Jest, II-a)? Las enmiendas van en un PR propio aprobado por ambos integrantes.
- **P3**: ¿Prefieren entregar la feature en 3 PRs dentro de `001` (recomendado) o separar US4 como `002-transferencia-propietario`?

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Vitest en lugar de Jest (principio II) | Es el runner del scaffold ya aprobado y fusionado (#2); el frontend de Angular 22 también usa Vitest. Un solo runner en todo el monorepo. | Volver a Jest obligaría a rehacer el scaffold y a mantener dos runners. Se propone la enmienda PATCH 1.0.1 en lugar de cambiar el código. |
| Eventos auditables no listados en el principio IV | Los exige la spec (FR-020) y el humano lo confirmó en clarify. | No auditarlos incumpliría la spec. Se propone la enmienda MINOR 1.1.0 para que la lista de la constitución quede completa. |
| Tres extensiones de PostgreSQL (`pg_trgm`, `unaccent`, `btree_gin`) | "Contiene" sobre placa y documento, nombre sin tildes, y GIN compuesto con `tenant_id` para cumplir los 200 ms. | Un B-tree de prefijo no cubre "contiene" (US1-AC3); normalizar tildes en la app duplica reglas. Las tres vienen con PostgreSQL y son *trusted*. |
