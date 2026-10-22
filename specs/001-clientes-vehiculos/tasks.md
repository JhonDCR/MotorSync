---

description: "Tareas de 001-clientes-vehiculos, agrupadas por PR y por historia, en pares TDD"
---

# Tasks: Registro de clientes y vehículos con búsqueda por placa

**Input**: Design documents from `specs/001-clientes-vehiculos/`

**Prerequisites**: [plan.md](./plan.md) (aprobado el 2026-10-21), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/openapi.yaml](./contracts/openapi.yaml), [quickstart.md](./quickstart.md)

**Tests**: obligatorios (constitución, principio II). Cada tarea de prueba precede a su tarea de implementación y cita los IDs de los criterios que cubre. Cada `it()` empieza por el ID del criterio (`US3-AC12 …`). La prueba se entrega **en rojo**; el implementer la pone en verde **sin tocarla**.

**Organization**: 3 PRs (decisión P3 del plan). Dentro de cada PR hay una base técnica y luego fases por historia.

## Format: `[ID] [P?] [Story] Descripción — ruta(s) — agente`

- **[P]**: se puede hacer en paralelo con otras tareas [P] de la misma fase (archivos distintos, sin dependencias pendientes).
- **[USn]**: historia de la spec a la que pertenece.
- **Agentes**: `tester` (solo `*.spec.ts`, `*.e2e-spec.ts`, `backend/test/**`, `frontend/src/testing/**`), `implementer-backend` (solo `backend/`, sin pruebas), `implementer-frontend` (solo `frontend/`, sin pruebas), `reviewer` (solo lectura) y `leader` (archivos del arnés y raíz: `.env.example`, `.github/workflows/ci.yml`, `CLAUDE.md`).
- Rutas relativas a la raíz del repo. Los archivos de fixtures y SQL de prueba viven en `backend/test/`, así que los escribe el `tester`.
- **Códigos de error** (contrato): cuando una tarea dice "400 `INVALID_*`", "400 `REQUIRED`", "400 `UNKNOWN_FIELD`" o "400 `REASON_REQUIRED`", la respuesta es `400` con `code = VALIDATION_ERROR` y ese valor en `errors[].code` del campo afectado. `SEARCH_TERM_TOO_SHORT`, `NOT_FOUND`, `CLIENT_NOT_FOUND`, `*_ALREADY_EXISTS`, `VERSION_CONFLICT` y `SAME_OWNER` van en `code`.

---

# PR1 — Base técnica + US2 (registrar cliente)

Rama sugerida: `feat/001-clientes-vehiculos` (o una rama de PR por corte, según decida el leader). Al terminar: alta, consulta y búsqueda de clientes de punta a punta, con RLS y JWT.

## Phase 1: Setup (PR1)

**Purpose**: dependencias, roles de BD, migraciones y validación temprana del riesgo TypeORM + ESM + Vitest.

- [x] T001 Escribir la e2e "humo" de conexión, transacción y fijado del tenant en `backend/test/db/smoke.e2e-spec.ts`. Debe comprobar: (a) `import { DataSource } from 'typeorm'` carga en ESM y conecta con `DATABASE_URL` (rol `motorsync_app`); (b) `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` → `false`; (c) dentro de una transacción de `QueryRunner`, tras `SELECT set_config('app.tenant_id', $1, true)`, `current_setting('app.tenant_id', true)` devuelve el uuid, y después del `COMMIT` en la misma conexión devuelve `''` o `NULL`; (d) dos transacciones concurrentes con tenants distintos ven cada una el suyo; (e) `app_current_tenant()` devuelve `NULL` sin `set_config`. Cubre el riesgo 1 del plan y el principio I — tester
- [x] T002 [P] Escribir el arnés de pruebas e2e: `backend/test/setup/global-setup.ts` (ejecuta `runMigrations()` exportado por `backend/src/database/migrate.ts` con `DATABASE_MIGRATOR_URL`); `backend/test/setup/db-fixtures.ts` (conexión como `motorsync_migrator`: `createTenant(name)`, `truncateBusinessTables()` con `TRUNCATE clients, vehicles, audit_log, tenants CASCADE` tolerando tablas aún inexistentes); `backend/test/setup/auth.ts` (`issueTestToken({ tenantId, userId, role, name, expiresIn? })` HS256 con `JWT_SECRET`) — tester
- [x] T003 [P] Añadir a `.env.example` (valores solo de desarrollo): `DATABASE_ADMIN_URL=postgresql://motorsync:motorsync_dev@localhost:5432/motorsync`, `DATABASE_MIGRATOR_URL=postgresql://motorsync_migrator:migrator_dev@localhost:5432/motorsync`, `DATABASE_URL=postgresql://motorsync_app:app_dev@localhost:5432/motorsync`, `DB_MIGRATOR_PASSWORD=migrator_dev`, `DB_APP_PASSWORD=app_dev`, `JWT_SECRET=` con un texto de ejemplo de ≥ 32 caracteres y la advertencia de no usarlo fuera de local — leader
- [x] T004 [P] Actualizar `.github/workflows/ci.yml`, job `backend`: env `DATABASE_ADMIN_URL` (usuario `motorsync` del service), `DATABASE_MIGRATOR_URL`, `DATABASE_URL` (rol `motorsync_app`), `DB_MIGRATOR_PASSWORD`, `DB_APP_PASSWORD` (valores efímeros de CI); un paso que exporte `JWT_SECRET=$(openssl rand -hex 32)` a `$GITHUB_ENV`; y los pasos `npm run db:bootstrap`, `npm run build`, `npm run db:migrate` antes de `npm run test:e2e`. `docker-compose.yml` no cambia (el bootstrap corre con `npm run db:bootstrap`, ver research R2) — leader
- [x] T005 Añadir a `backend/package.json` las dependencias `@nestjs/typeorm`, `typeorm` (0.3.x), `pg`, `@nestjs/jwt`, `class-validator`, `class-transformer` (y `@types/pg` en dev), y los scripts `db:bootstrap` (`node dist/scripts/db-bootstrap.js`), `db:migrate` (`node dist/src/database/migrate.js`) y `token:dev` (`node dist/scripts/issue-dev-token.js`). Ajustar `backend/tsconfig.build.json` para compilar `scripts/` — implementer-backend
- [x] T006 Crear `backend/db/bootstrap.sql` (idempotente: roles `motorsync_migrator` `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE` y `motorsync_app` `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT`, contraseñas desde parámetros; `CREATE EXTENSION IF NOT EXISTS pg_trgm, unaccent, btree_gin`; `GRANT CONNECT` a ambos; `ALTER SCHEMA public OWNER TO motorsync_migrator`; `GRANT USAGE ON SCHEMA public TO motorsync_app`) y `backend/scripts/db-bootstrap.ts`, que lo ejecuta con `DATABASE_ADMIN_URL` pasando `DB_MIGRATOR_PASSWORD` y `DB_APP_PASSWORD` — implementer-backend
- [x] T007 [P] Crear `backend/src/config/env.ts`: lee y valida `DATABASE_URL`, `DATABASE_MIGRATOR_URL`, `JWT_SECRET` (≥ 32 caracteres) y `PORT`; lanza un error claro al arrancar si falta alguno — implementer-backend
- [x] T008 Crear `backend/src/database/data-source.ts` (dos fábricas: app con `DATABASE_URL` y migrator con `DATABASE_MIGRATOR_URL`; `synchronize: false`; entidades y migraciones **por referencia de clase**, sin globs), `backend/src/database/migrate.ts` (exporta `runMigrations()` y es ejecutable) y la migración `backend/src/database/migrations/1761000000000-CreateTenantsAndHelpers.ts` con el DDL de `tenants`, `app_current_tenant()`, `immutable_unaccent(text)` y sus `GRANT EXECUTE` exactamente como en data-model.md. Configurar `globalSetup: ['./test/setup/global-setup.ts']` en `backend/vitest.config.e2e.ts`. Deja T001 en verde — implementer-backend

**Checkpoint**: T001 en verde: TypeORM funciona en ESM con Vitest y `set_config` local se comporta como se espera.

## Phase 2: Foundational (PR1)

**Purpose**: contexto de tenant, autenticación, errores, validadores de documento y base del frontend. Bloquea todas las historias.

- [x] T009 [P] Pruebas unitarias del interceptor en `backend/src/database/tenant-transaction.interceptor.spec.ts`: abre la transacción, llama `set_config('app.tenant_id', <tenant del usuario autenticado>, true)` como primera sentencia, publica el manager en el `AsyncLocalStorage`, hace `COMMIT` si el handler termina bien y `ROLLBACK` si lanza (y libera el `QueryRunner` en ambos casos); nunca usa valores de `body`, `query` ni cabeceras — tester
- [x] T010 Implementar `backend/src/database/tenant-context.ts` (`AsyncLocalStorage<{ manager, tenantId, user }>`, `getManager()` que lanza si no hay contexto) y `backend/src/database/tenant-transaction.interceptor.ts`. Regla: solo estos archivos usan el `DataSource` directamente — implementer-backend
- [x] T011 [P] Pruebas unitarias del guard en `backend/src/auth/jwt-auth.guard.spec.ts`: 401 sin token, con firma inválida, expirado, con `alg` distinto de HS256 (incluido `none`), sin `tenant_id` o `sub` uuid, o con `role` fuera de `asesor` o `admin`; con un token válido expone `{ userId, tenantId, role, name }` — tester
- [x] T012 Implementar `backend/src/auth/jwt-auth.guard.ts` (global, solo HS256), `backend/src/auth/auth-user.ts`, `backend/src/auth/current-user.decorator.ts` y `backend/scripts/issue-dev-token.ts` (`--tenant`, `--role`, `--name`, `--user` opcional) — implementer-backend
- [x] T013 [P] Pruebas en `backend/src/common/problem-details.filter.spec.ts` (respuestas `application/problem+json` con `type`, `title`, `status`, `code`, `errors[]`, `existingId`, `current` según el esquema `Problem` del contrato; un error de validación con propiedad no permitida produce `VALIDATION_ERROR` con `errors[].code = UNKNOWN_FIELD`) y `backend/src/database/pg-errors.spec.ts` (`23505` en `clients_tenant_document_key` → `DOCUMENT_ALREADY_EXISTS`, `vehicles_tenant_plate_key` → `PLATE_ALREADY_EXISTS`, `vehicles_tenant_vin_key` → `VIN_ALREADY_EXISTS`; `23514` en `vehicles_plate_format` → `VALIDATION_ERROR`/`INVALID_PLATE`). Reescribir `backend/test/app.e2e-spec.ts` con el prefijo y el guard globales: `GET /api/v1` sin token → 401 `application/problem+json` con `code = UNAUTHORIZED`; con `issueTestToken()` válido → 200 — tester
- [x] T014 Implementar `backend/src/common/problem-details.filter.ts`, `backend/src/database/pg-errors.ts` y el cableado en `backend/src/main.ts` (prefijo `/api/v1`, `ValidationPipe` global con `whitelist`, `forbidNonWhitelisted` y `transform`, filtro global) y `backend/src/app.module.ts` (TypeORM con la fábrica app, guard global, interceptor global). Se conserva el `AppController` existente, que ahora queda protegido en `GET /api/v1` y sirve de prueba de humo de la app — implementer-backend
- [x] T015 [P] Pruebas unitarias de identificadores en `backend/src/common/identifiers/normalize.spec.ts`, `backend/src/common/identifiers/ec-document.spec.ts` y `backend/src/common/identifiers/phone.spec.ts`, con vectores fijos: cédula válida e inválida (longitud, provincia 01–24/30, tercer dígito 0–5, verificador módulo 10); RUC persona natural (cédula válida + `001`), sociedad privada (tercer dígito 9) y pública (6) validados **solo por estructura**, sin módulo 11 (decisión P1); RUC que no termina en `001` → inválido; pasaporte `^[A-Z0-9]{5,20}$`; teléfono `^\+?\d{7,15}$` tras quitar espacios, guiones y paréntesis; normalización de documento sin espacios ni guiones. Cubre la base de US2-AC3, US2-AC4, US2-AC5 y US2-AC7 — tester
- [x] T016 Implementar `backend/src/common/identifiers/normalize.ts`, `backend/src/common/identifiers/ec-document.ts` y `backend/src/common/identifiers/phone.ts` como funciones puras sin dependencias — implementer-backend
- [x] T017 [P] Escribir la prueba RLS de BD para clientes en `backend/test/db/rls.e2e-spec.ts` (conexión `motorsync_app`): sin `set_config` → `SELECT count(*) FROM clients` = 0; con el tenant A no se ven filas de B; `INSERT` con `tenant_id` de B bajo el tenant A falla por `WITH CHECK`; `DELETE FROM clients` → `permission denied`; `motorsync_app` no es dueño de `clients`; `relforcerowsecurity = true`. Cubre el principio I y FR-022/FR-023 — tester
- [x] T018 Crear la migración `backend/src/database/migrations/1761000000100-CreateClients.ts` con el DDL de `clients` de data-model.md **literal** (incluidas las restricciones `clients_company_requires_ruc`, `clients_names_by_type`, `clients_tenant_id_id_key`, las columnas generadas `display_name` y `search_name`, los índices `clients_tenant_document_key`, `clients_tenant_document_trgm_idx`, `clients_tenant_search_name_trgm_idx`, la política y `GRANT SELECT, INSERT, UPDATE`) y la entidad `backend/src/clients/client.entity.ts` (`type` explícito en cada `@Column`; columnas generadas como `insert: false, update: false`) — implementer-backend
- [x] T019 [P] Pruebas del frontend base en `frontend/src/app/core/auth/auth-token.interceptor.spec.ts` (añade `Authorization: Bearer` con el token guardado; sin token no añade la cabecera) y `frontend/src/app/core/api/problem.spec.ts` (traduce cada `code` y `errors[].code` del contrato a su mensaje en español de la spec: "Cédula inválida", "RUC inválido", "Placa inválida: para autos use 3 letras y 3 o 4 dígitos (ej. PBA1234)", "Placa inválida: para motos use 2 letras, 3 dígitos y 1 letra (ej. AB123C)", "VIN inválido", "El motivo es obligatorio (entre 10 y 500 caracteres)", "El vehículo ya pertenece a este cliente", "No se encontró ningún vehículo"). Ajustar `frontend/src/app/app.spec.ts` si la nueva shell lo rompe — tester
- [x] T020 Implementar `frontend/src/app/core/auth/auth-token.interceptor.ts`, `frontend/src/app/core/auth/dev-token.page.ts` (ruta `/dev-token`, solo con `isDevMode()`), `frontend/src/app/core/api/problem.ts`, `frontend/src/app/core/api/api.models.ts` (todos los esquemas de `contracts/openapi.yaml`), el token `USE_MOCK_API` y `provideHttpClient(withInterceptors(...))` en `frontend/src/app/app.config.ts`, `frontend/proxy.conf.json` (`/api` → `http://localhost:3000`), la configuración `mock` y `proxyConfig` en `frontend/angular.json`, y `frontend/src/app/shared/styles/_touch.scss` (`$touch-target: 44px`) — implementer-frontend

**Checkpoint**: base lista: transacción por request con tenant del JWT, errores problem+json, tabla `clients` con RLS y frontend capaz de llamar a la API o a mocks.

## Phase 3: User Story 2 — Registrar cliente (P1) (PR1)

**Goal**: el asesor registra personas naturales y empresas con documento ecuatoriano válido y único por taller.

**Independent Test**: quickstart §2, filas 1 a 4; e2e `backend/test/clients.e2e-spec.ts`.

- [x] T021 [US2] E2E de alta y consulta de clientes en `backend/test/clients.e2e-spec.ts`. Cubre US2-AC1 (natural con cédula → 201 y `GET /api/v1/clients/{id}` con `vehicles: []`), US2-AC2 (empresa con RUC; empresa con `cedula` o `passport` → 400 `INVALID_DOCUMENT_TYPE`), US2-AC3 (pasaporte de 5 a 20 alfanuméricos), US2-AC4 (`INVALID_CEDULA`), US2-AC5 (`INVALID_RUC`), US2-AC6 (documento repetido con espacios o guiones → 409 `DOCUMENT_ALREADY_EXISTS` + `existingId`), US2-AC7 (`INVALID_EMAIL`; teléfono con menos de 7 o más de 15 dígitos → `INVALID_PHONE`; correo omitido o `null` → 201), US2-AC8 (cada obligatorio faltante → `errors[].code = REQUIRED`), US2-AC9 (mismo documento en el taller B → 201) y US2-AC10 (`tenantId` en el body → 400 `UNKNOWN_FIELD`; `X-Tenant-Id: <B>` ignorado: el cliente queda en A; B no lo ve por `GET /clients/{id}` → 404). Verifica también `createdAt`, `updatedAt`, `updatedBy` y `updatedByName` (FR-017) — tester
- [x] T022 [US2] Implementar en `backend/src/clients/dto/create-client.dto.ts` (`firstNames` y `lastNames` de 1 a 100, obligatorios si `natural`; `businessName` de 1 a 200, obligatorio si `company`; `phone` obligatorio; `email` opcional y nullable), `backend/src/common/validation/is-ec-document.ts` y `is-ec-phone.ts` (decoradores sobre `common/identifiers`), `backend/src/clients/clients.service.ts` (`create`, `getById` con `vehicles: []` hasta el PR2; normaliza el documento, el teléfono y el correo en minúsculas; rellena `created_by`, `updated_by` y `updated_by_name` desde el usuario autenticado), `backend/src/clients/clients.controller.ts` (`POST /clients` con `Location`, `GET /clients/:clientId`; uuid inválido → 404) y `backend/src/clients/clients.module.ts` — implementer-backend
- [x] T023 [P] [US2] Pruebas de identificadores y validadores del frontend en `frontend/src/app/shared/identifiers/ec-document.spec.ts`, `frontend/src/app/shared/identifiers/phone.spec.ts` y `frontend/src/app/shared/validators/client.validators.spec.ts`, con **los mismos vectores** que T015. Cubre US2-AC3, US2-AC4, US2-AC5 y US2-AC7 — tester
- [x] T024 [US2] Implementar `frontend/src/app/shared/identifiers/ec-document.ts`, `frontend/src/app/shared/identifiers/phone.ts`, `frontend/src/app/shared/identifiers/normalize.ts` y `frontend/src/app/shared/validators/client.validators.ts` (`ValidatorFn`) — implementer-frontend
- [x] T025 [P] [US2] Pruebas del servicio en `frontend/src/app/core/api/clients-api.service.spec.ts` con `HttpTestingController`: `create`, `getById` y `search` llaman a las rutas y verbos del contrato y propagan el `Problem` tipado — tester
- [x] T026 [US2] Implementar `frontend/src/app/core/api/clients-api.service.ts` — implementer-frontend
- [x] T027 [US2] Pruebas del formulario en `frontend/src/app/features/clients/client-form.page.spec.ts`. Cubre US2-AC1 (guardar natural y navegar a la ficha), US2-AC2 (con "Empresa" solo se ofrece RUC y se pide razón social), US2-AC3, US2-AC4 y US2-AC5 (mensajes junto al campo), US2-AC6 (409 → mensaje y enlace "Abrir cliente existente" con `existingId`), US2-AC7 (correo opcional; si se informa se valida) y US2-AC8 (marca cada obligatorio faltante y no envía). Advierte de un posible duplicado cédula/RUC (edge case) buscando los 10 primeros dígitos antes de enviar, sin bloquear. Edge case de conexión inestable: si el guardado falla por red (status 0), el formulario conserva lo escrito y ofrece "Reintentar"; un reintento que recibe 409 `DOCUMENT_ALREADY_EXISTS` ofrece abrir el registro existente — tester
- [x] T028 [US2] Implementar `frontend/src/app/features/clients/client-form.page.ts` (+ `.html`/`.scss`, mobile-first, objetivos táctiles de 44 px) y su ruta `clients/new` en `frontend/src/app/app.routes.ts` — implementer-frontend
- [x] T029 [P] [US2] Pruebas del mock en `frontend/src/app/core/api/mock-api.interceptor.spec.ts`, parte de clientes: `POST /clients` (201, 400 con `errors[]`, 409 duplicado), `GET /clients/{id}` (200, 404) y `GET /clients/search` (200, 400 `SEARCH_TERM_TOO_SHORT`); solo actúa si `USE_MOCK_API` es `true` — tester
- [x] T030 [US2] Implementar la parte de clientes de `frontend/src/app/core/api/mock-api.interceptor.ts` (datos en memoria que respetan el contrato y las mismas validaciones) — implementer-frontend

## Phase 4: Búsqueda y ficha de cliente (habilitador de US4 adelantado al PR1)

**Goal**: buscar clientes por documento o nombre y ver su ficha. La spec lo asigna a US4 (US4-AC1 a US4-AC3), pero el PR2 lo necesita para elegir el propietario de un vehículo (US3-AC9), así que se adelanta.

- [x] T031 [US4] E2E en `backend/test/clients-search.e2e-spec.ts`. Cubre US4-AC1 (`1712345675` y `171234567-5` → el cliente es el primero), US4-AC2 (`nunez` encuentra "José Andrés Núñez" y "Maria Nunez"; empresas por razón social), FR-003 (exacta → prefijo → contiene; 25 coincidencias → 20 items y `hasMore: true`), menos de 2 caracteres → 400 `SEARCH_TERM_TOO_SHORT`, y FR-023 (los clientes del taller B no aparecen para A) — tester
- [x] T032 [US4] Implementar `searchClients` en `backend/src/clients/clients.service.ts` (consulta de referencia de data-model.md, con filtro explícito `tenant_id = app_current_tenant()`, `LIMIT 21` y escape de `%`, `_` y `\` en el nombre) y `GET /clients/search` en `backend/src/clients/clients.controller.ts` (declarado antes de `:clientId`) — implementer-backend
- [x] T033 [P] [US4] Pruebas de `frontend/src/app/features/clients/client-search.page.spec.ts` (US4-AC1, US4-AC2: búsqueda mientras se escribe con `debounceTime(250)` y cancelación de la anterior; aviso "más resultados" con `hasMore`) y `frontend/src/app/features/clients/client-detail.page.spec.ts` (US4-AC3: datos de contacto, lista de vehículos con enlace a cada ficha y "Este cliente no tiene vehículos registrados" con acción para registrar uno si la lista está vacía; FR-017 "última modificación por X el Y") — tester
- [x] T034 [US4] Implementar `frontend/src/app/features/clients/client-search.page.ts` y `frontend/src/app/features/clients/client-detail.page.ts` (+ plantillas y estilos) y sus rutas `clients` y `clients/:id` — implementer-frontend

## Cierre PR1

- [x] T035 Actualizar `CLAUDE.md` con los comandos nuevos (`npm run db:bootstrap`, `npm run db:migrate`, `npm run token:dev`) y el orden de arranque local — leader
- [ ] T036 Revisar el diff del PR1 contra spec.md, plan.md (Constitution Check) y la constitución 1.1.0. Foco: tenant tomado solo del JWT, ningún uso del `DataSource` fuera de `database/`, RLS `FORCE` en `clients`, ningún `any` sin justificar, y que cada criterio US2-AC1 a AC10 y US4-AC1 a AC3 tenga una prueba con su ID — reviewer
- [ ] T037 Verificar el PR1: `cd backend && npm run lint && npm test && npm run db:bootstrap && npm run build && npm run db:migrate && npm run test:e2e`; `cd frontend && npm run lint && npm test -- --watch=false && npm run build`; quickstart §1 (sin `db:seed:dev`, que llega en el PR2; los talleres se crean con los fixtures o a mano) y §2, filas 1 a 4. CI en verde — leader

---

# PR2 — US3 (registrar vehículo) + US1 (buscar por placa) + rendimiento

## Phase 5: Base del PR2

- [ ] T038 [P] Pruebas unitarias en `backend/src/common/identifiers/plate.spec.ts` y `backend/src/common/identifiers/vin.spec.ts`. Normalización para alta y edición (`pba-1234` y ` pba 1234 ` → `PBA1234`; `PBA*1234` → error, no se limpia) y para búsqueda (se descartan los caracteres no alfanuméricos). Formato auto `^[A-Z]{3}[0-9]{3,4}$` (acepta `PBA123` y `PBA1234`; rechaza `PB1234`, `PBA12`, `PBA12345`, `1234PBA` y `AB123C`) y moto `^[A-Z]{2}[0-9]{3}[A-Z]$` (acepta `AB123C`; rechaza `PBA1234` y `AB1234`) según `bodyType`. VIN `^[A-HJ-NPR-Z0-9]{17}$` (rechaza I, O, Q y longitudes distintas de 17). Cubre US3-AC2, US3-AC4, US3-AC12, US3-AC13 y US3-AC14 — tester
- [ ] T039 Implementar `backend/src/common/identifiers/plate.ts`, `backend/src/common/identifiers/vin.ts` y los decoradores `backend/src/common/validation/is-ec-plate.ts` (valida contra el `bodyType` del mismo DTO) e `is-vin.ts` — implementer-backend
- [ ] T040 Ampliar `backend/test/db/rls.e2e-spec.ts` con `vehicles`: aislamiento igual que en T017; `DELETE` → `permission denied`; insertar un vehículo del tenant A con `owner_client_id` de un cliente de B falla por `vehicles_owner_same_tenant_fk` (US3-AC11); `CHECK vehicles_plate_format` rechaza `AB123C` con `body_type = 'sedan'` — tester
- [ ] T041 Crear la migración `backend/src/database/migrations/1761000000200-CreateVehicles.ts` con el DDL de `vehicles` de data-model.md **literal** (`year smallint CHECK (year >= 1950)`, `initial_mileage integer CHECK (initial_mileage BETWEEN 0 AND 9999999)`, `body_type IN ('sedan','suv','pickup','motorcycle','other')`, `vin` nullable con `CHECK`, `vehicles_plate_format`, `vehicles_owner_same_tenant_fk`, índices `vehicles_tenant_plate_key`, `vehicles_tenant_vin_key` parcial, `vehicles_tenant_plate_trgm_idx` y `vehicles_tenant_owner_idx`, la política y `GRANT SELECT, INSERT, UPDATE`) y la entidad `backend/src/vehicles/vehicle.entity.ts` — implementer-backend
- [ ] T042 [P] Crear `backend/scripts/seed-dev.ts` (`npm run db:seed:dev`, con conexión del migrator): talleres A y B con clientes y vehículos de ejemplo (incluidos los de los ejemplos de la spec: `PBA1234`, `PBA1299`, `GYE0123` y una moto `AB123C`); imprime los uuid de los talleres. Añadir el script `db:seed:dev` (`node dist/scripts/seed-dev.js`) a `backend/package.json` — implementer-backend

## Phase 6: User Story 3 — Registrar vehículo de un cliente (P1) (PR2)

**Goal**: el asesor registra vehículos de clientes existentes, con placa oficial normalizada y única y VIN opcional único.

**Independent Test**: quickstart §2, filas 5 a 7; e2e `backend/test/vehicles.e2e-spec.ts`.

- [ ] T043 [US3] E2E en `backend/test/vehicles.e2e-spec.ts`. Cubre:
  - US3-AC1: 201 y `GET /api/v1/vehicles/{id}` con `owner`; la ficha del cliente (`GET /clients/{id}`) lista el vehículo (US4-AC3).
  - US3-AC2: se guarda `PBA1234`.
  - US3-AC3: `PBA-1234` o `pba 1234` repetido → 409 `PLATE_ALREADY_EXISTS` + `existingId`.
  - US3-AC4: `INVALID_VIN`; el VIN se guarda normalizado.
  - US3-AC5: → 409 `VIN_ALREADY_EXISTS`.
  - US3-AC6: dos vehículos sin VIN conviven.
  - US3-AC7: año 1949 o año en curso + 2 → `INVALID_YEAR`; kilometraje -1, 1,5 o 10 000 000 → `INVALID_MILEAGE`.
  - US3-AC8: `bodyType` fuera del enum → 400.
  - US3-AC10: la misma placa en el taller B → 201.
  - US3-AC11: `ownerClientId` de un cliente de B → 404 `CLIENT_NOT_FOUND`, sin crear nada.
  - US3-AC12 y US3-AC13: formato auto y moto, con los mensajes exactos de la spec en `errors[].message`.
  - US3-AC14: placa con `*` → `INVALID_PLATE`.
  - US1-AC9: `GET /vehicles/{id}` de otro taller → 404 `NOT_FOUND`.
  - FR-014: el vehículo siempre tiene exactamente un `owner`.
  - tester
- [ ] T044 [US3] Implementar `backend/src/vehicles/dto/create-vehicle.dto.ts` (`brand`, `model` y `color` de 1 a 60; `year` entero ≥ 1950 y ≤ año UTC en curso + 1; `initialMileage` entero de 0 a 9 999 999; `bodyType` enum; `vin` opcional y nullable), `backend/src/vehicles/vehicles.service.ts` (`create`: verifica el propietario bajo RLS → `CLIENT_NOT_FOUND`; `getById` con `owner`), `backend/src/vehicles/vehicles.controller.ts` (`POST /vehicles` con `Location`, `GET /vehicles/:vehicleId`) y `backend/src/vehicles/vehicles.module.ts`; y completar `vehicles` (ordenados por placa) en `getById` de `backend/src/clients/clients.service.ts` — implementer-backend
- [ ] T045 [P] [US3] Pruebas de `frontend/src/app/shared/identifiers/plate.spec.ts`, `frontend/src/app/shared/identifiers/vin.spec.ts` y `frontend/src/app/shared/validators/vehicle.validators.spec.ts` (validador de placa que depende del control `bodyType`), con **los mismos vectores** que T038. Cubre US3-AC2, US3-AC4, US3-AC12, US3-AC13 y US3-AC14 — tester
- [ ] T046 [US3] Implementar `frontend/src/app/shared/identifiers/plate.ts`, `frontend/src/app/shared/identifiers/vin.ts` y `frontend/src/app/shared/validators/vehicle.validators.ts` — implementer-frontend
- [ ] T047 [P] [US3] Pruebas del servicio en `frontend/src/app/core/api/vehicles-api.service.spec.ts` (`create`, `getById` y `search` según el contrato) — tester
- [ ] T048 [US3] Implementar `frontend/src/app/core/api/vehicles-api.service.ts` — implementer-frontend
- [ ] T049 [US3] Pruebas del formulario en `frontend/src/app/features/vehicles/vehicle-form.page.spec.ts`. Cubre US3-AC2 (muestra la placa normalizada), US3-AC4, US3-AC7, US3-AC8 (selector con Sedán, SUV, Pickup, Moto y Otro), US3-AC9 (placa precargada desde `?plate=`; elegir propietario con la búsqueda de clientes; "Registrar cliente nuevo" vuelve al formulario sin perder lo escrito), US3-AC12 y US3-AC13 (mensajes según la carrocería), US3-AC14 (al cambiar la carrocería se revalida la placa) y US3-AC3/US3-AC5 (409 → enlace "Abrir vehículo existente"). Edge case de conexión inestable: un fallo de red conserva lo escrito y ofrece "Reintentar" — tester
- [ ] T050 [US3] Implementar `frontend/src/app/features/vehicles/vehicle-form.page.ts` (+ plantilla y estilos; `autocapitalize="characters"` en placa y VIN; objetivos de 44 px) y la ruta `vehicles/new` — implementer-frontend
- [ ] T051 [P] [US3] Pruebas de `frontend/src/app/features/vehicles/vehicle-detail.page.spec.ts` (US3-AC1: datos del vehículo y del propietario actual con enlace a su ficha; FR-017 última modificación; 404 → "No se encontró ningún vehículo") — tester
- [ ] T052 [US3] Implementar `frontend/src/app/features/vehicles/vehicle-detail.page.ts` y la ruta `vehicles/:id` — implementer-frontend

## Phase 7: User Story 1 — Buscar vehículo por placa (P1) (PR2)

**Goal**: buscar por placa completa o parcial, o por VIN completo, y ver al instante el vehículo y su propietario.

**Independent Test**: quickstart §2, filas 8 a 10, y §5; e2e `backend/test/vehicles-search.e2e-spec.ts`.

- [ ] T053 [US1] E2E en `backend/test/vehicles-search.e2e-spec.ts`. Cubre:
  - US1-AC1: `PBA1234` es el primero, con todos los campos del vehículo y del propietario del esquema `VehicleSearchResponse`.
  - US1-AC2: `pba-1234`, `PBA 1234` y ` pba1234 ` dan el mismo resultado.
  - US1-AC3: `BA12` → `PBA1234` y `PBA1299`, sin `GYE0123`.
  - US1-AC4: orden exacta → prefijo → contiene; 25 coincidencias → 20 + `hasMore: true`.
  - US1-AC5: 1 carácter válido (o `*%`) → 400 `SEARCH_TERM_TOO_SHORT`.
  - US1-AC6: placa inexistente → `items: []`.
  - US1-AC7: VIN completo → el vehículo; un fragmento de VIN no coincide por VIN.
  - US1-AC8: `PBA1234` y `BA12` solo en B → `items: []` para A, con la misma respuesta que para una placa inexistente.
  - tester
- [ ] T054 [US1] Implementar `searchVehicles` en `backend/src/vehicles/vehicles.service.ts` (consulta de referencia de data-model.md, con filtro explícito `tenant_id = app_current_tenant()`, `LIMIT 21` y `OR v.vin = $1` solo si el término tiene forma de VIN) y `GET /vehicles/search` en `backend/src/vehicles/vehicles.controller.ts` (declarado antes de `:vehicleId`); mapper tipado del resultado de `manager.query()` con el comentario que justifica el `any` del borde — implementer-backend
- [ ] T055 [US1] Pruebas de `frontend/src/app/features/vehicles/vehicle-search.page.spec.ts`. Cubre US1-AC1 (tarjeta con vehículo y propietario), US1-AC2 (normaliza antes de buscar), US1-AC4 (aviso de más resultados), US1-AC5 (con menos de 2 caracteres muestra "Escriba al menos 2 caracteres" y no llama a la API), US1-AC6 ("No se encontró ningún vehículo"; si el término normalizado tiene forma de placa completa de auto o moto, además "Registrar vehículo", que navega a `vehicles/new?plate=<normalizada>`; con un fragmento solo se muestra el mensaje), US1-AC8 (para el usuario, una placa de otro taller se ve igual que una inexistente), FR-026 (es la ruta `''`; busca mientras se escribe con `debounceTime(250)` + `switchMap`) y que se puede buscar por VIN — tester
- [ ] T056 [US1] Implementar `frontend/src/app/features/vehicles/vehicle-search.page.ts` (+ plantilla y estilos; campo grande con `inputmode="text"` y `autocapitalize="characters"`) como ruta `''` en `frontend/src/app/app.routes.ts` — implementer-frontend
- [ ] T057 [P] [US1] Ampliar `frontend/src/app/core/api/mock-api.interceptor.spec.ts` con la parte de vehículos: `GET /vehicles/search` (orden, `hasMore`, 400), `POST /vehicles` (201, 400 `INVALID_PLATE`, 409) y `GET /vehicles/{id}` (200, 404) — tester
- [ ] T058 [US1] Implementar la parte de vehículos de `frontend/src/app/core/api/mock-api.interceptor.ts` — implementer-frontend

## Phase 8: Rendimiento (US1-AC10, FR-005, SC-001) (PR2)

- [ ] T059 [US1] Escribir `backend/test/perf/seed-volume.sql` (con `generate_series`: 10 talleres × 30 000 clientes y 50 000 vehículos; documentos, placas y VIN válidos y únicos por taller; nombres con tildes; `ANALYZE` al final) y `backend/test/perf/search.perf-spec.ts`: 300 búsquedas por tipo (placa exacta, placa parcial de 2 a 4 caracteres, documento, VIN y nombre) con tokens de talleres distintos, medidas con `performance.now()`. Falla si el p95 de placa, documento o VIN es ≥ 200 ms (el de nombre se reporta). Además, `EXPLAIN (FORMAT JSON)` de las consultas de búsqueda no contiene `Seq Scan` sobre `vehicles` ni `clients`. Cubre US1-AC10 y SC-001 — tester
- [ ] T060 [US1] Crear `backend/vitest.config.perf.ts` (`include: ['test/perf/**/*.perf-spec.ts']`, mismo `globalSetup`, `testTimeout` amplio) y el script `test:perf` en `backend/package.json`. Si el p95 no se cumple, ajustar índices o consultas en `backend/src/` sin cambiar el comportamiento de la spec, y avisar al leader si hiciera falta el plan B del plan — implementer-backend
- [ ] T061 Añadir el paso `npm run test:perf` al job `backend` de `.github/workflows/ci.yml`, después de `npm run test:e2e`, y documentar `npm run db:seed:dev` y `npm run test:perf` en `CLAUDE.md` — leader

## Cierre PR2

- [ ] T062 Revisar el diff del PR2. Foco: FK compuesta y `CHECK` de placa iguales al data-model, filtro explícito por tenant en las búsquedas, mensajes exactos de US3-AC12 y US3-AC13, ninguna fuga entre talleres en los 409 (FR-024), y pruebas con ID para US1-AC1 a AC10 y US3-AC1 a AC14 — reviewer
- [ ] T063 Verificar el PR2: lo mismo que en T037 más `npm run test:perf`; quickstart §2 filas 5 a 10, §4 (revisión manual a 360 × 640 y 768 × 1024: sin scroll horizontal, objetivos de ≥ 44 px, búsqueda como pantalla inicial: FR-025, FR-026, SC-002) y §5. CI en verde — leader

---

# PR3 — US4 (buscar clientes, editar y cambiar propietario)

## Phase 9: Base del PR3

- [ ] T064 Ampliar `backend/test/db/rls.e2e-spec.ts` con `audit_log`: aislamiento por tenant; `motorsync_app` puede hacer `INSERT` y `SELECT` pero `UPDATE` y `DELETE` → `permission denied`; con `motorsync_migrator`, `UPDATE` y `DELETE` fallan por el trigger `audit_log_no_update_delete`; `CHECK audit_log_asesor_reason` rechaza `actor_role = 'asesor'` sin `reason`; `reason` de 9 caracteres → rechazado. Cubre el principio IV y US4-AC10 ("nadie puede editar ni borrar") — tester
- [ ] T065 Crear la migración `backend/src/database/migrations/1761000000300-CreateAuditLog.ts` con el DDL de `audit_log` de data-model.md **literal** (columnas, `CHECK`, índices `audit_log_tenant_id_idx` y `audit_log_entity_idx`, política, `GRANT SELECT, INSERT`, función y trigger) y `backend/src/audit/audit-log.entity.ts`, `backend/src/audit/audit.service.ts` (`record()` con el manager de `tenant-context`; toma `actor_*`, `ip` y `channel = 'web'` del contexto del request) y `backend/src/audit/audit.module.ts` — implementer-backend
- [ ] T066 [P] Pruebas unitarias en `backend/src/common/reason-policy.spec.ts` (FR-019): el asesor necesita un `reason` de 10 a 500 caracteres tras `trim` para transferir o cambiar placa, VIN o documento; el admin puede omitirlo; editar campos que no son identificadores nunca lo exige; un valor normalizado igual al guardado no cuenta como cambio — tester
- [ ] T067 Implementar `backend/src/common/reason-policy.ts` — implementer-backend

## Phase 10: User Story 4 — Editar y cambiar propietario (P2) (PR3)

**Goal**: mantener los datos al día con ediciones seguras ante la concurrencia y transferencias de propietario auditadas.

**Independent Test**: quickstart §2, filas 11 a 15; e2e `backend/test/clients-update.e2e-spec.ts`, `backend/test/vehicles-update.e2e-spec.ts`, `backend/test/ownership.e2e-spec.ts` y `backend/test/no-delete.e2e-spec.ts`.

- [ ] T068 [US4] E2E en `backend/test/clients-update.e2e-spec.ts`. Cubre:
  - US4-AC4: teléfono, correo o nombre válidos → 200, `version + 1` y `updatedByName` del token.
  - US4-AC5: documento duplicado → 409 `DOCUMENT_ALREADY_EXISTS`; documento inválido → 400.
  - US4-AC11: cambio de documento → un registro `client.document_changed` con `before` y `after` `{documentType, documentNumber}`, `reason`, `actor_role`, `ip` y `occurred_at` UTC.
  - US4-AC12: `version` antigua → 409 `VERSION_CONFLICT` + `current`.
  - US4-AC13: un cliente de B → 404 sin cambios ni auditoría en ninguno de los dos talleres.
  - US4-AC15: asesor que cambia el documento sin motivo o con menos de 10 caracteres → 400 `REASON_REQUIRED`, sin cambios ni auditoría.
  - US4-AC16: admin sin motivo → 200 y auditoría con `reason = null`; admin con motivo → se audita el motivo.
  - `clientType` en el body → 400.
  - tester
- [ ] T069 [US4] Implementar `backend/src/clients/dto/update-client.dto.ts` (`version` obligatorio; resto opcional; `reason` de 10 a 500), `update` en `backend/src/clients/clients.service.ts` (`UPDATE … WHERE id AND version RETURNING *`; 0 filas → 404 o 409 con `current`; aplica `reason-policy`; `audit.record('client.document_changed')` en la misma transacción) y `PATCH /clients/:clientId` — implementer-backend
- [ ] T070 [US4] E2E en `backend/test/vehicles-update.e2e-spec.ts`. Cubre:
  - US4-AC5: placa o VIN duplicados → 409; placa con formato inválido → 400.
  - US4-AC6: marca, modelo, año, color, carrocería y kilometraje → 200 sin motivo ni auditoría.
  - US3-AC14: cambiar `bodyType` a `motorcycle` dejando `PBA1234` → 400 `INVALID_PLATE`.
  - US4-AC11: cambiar placa y VIN en un solo `PATCH` → dos registros (`vehicle.plate_changed`, `vehicle.vin_changed`) con el mismo `reason`.
  - US4-AC12: `VERSION_CONFLICT` + `current`.
  - US4-AC13.
  - US4-AC15 y US4-AC16 sobre placa y VIN.
  - `ownerClientId` en el body del `PATCH` → 400.
  - tester
- [ ] T071 [US4] Implementar `backend/src/vehicles/dto/update-vehicle.dto.ts`, `update` en `backend/src/vehicles/vehicles.service.ts` (revalida la placa contra la carrocería resultante; auditoría por identificador cambiado) y `PATCH /vehicles/:vehicleId` — implementer-backend
- [ ] T072 [US4] E2E en `backend/test/ownership.e2e-spec.ts`. Cubre:
  - US4-AC7: asesor con motivo → 200; el vehículo sale de la ficha de Ana y aparece en la de Carlos.
  - US4-AC8: exactamente un `vehicle.owner_changed` con `tenant_id`, actor, rol, `before` y `after` (`ownerClientId`, `ownerDisplayName`, `ownerDocumentNumber`), `reason`, `occurred_at` UTC e `ip` o `channel`.
  - US4-AC9: cliente destino inexistente → 404 `CLIENT_NOT_FOUND` sin cambios ni auditoría; con `AuditService.record` forzado a lanzar (override del provider en el módulo de prueba) → el propietario no cambia.
  - US4-AC10: `GET /vehicles/{id}/ownership-history` del más reciente al más antiguo, con motivo cuando existe.
  - US4-AC13: transferir un vehículo de B, o a un cliente de B → 404, sin auditoría en ningún taller.
  - US4-AC14: el historial solo devuelve registros del propio taller.
  - US4-AC15: asesor sin motivo → 400 `REASON_REQUIRED`.
  - US4-AC16: admin sin motivo → 200.
  - Edge case: transferir al propietario actual → 422 `SAME_OWNER` sin auditoría.
  - `version` antigua → 409 `VERSION_CONFLICT`.
  - tester
- [ ] T073 [US4] Implementar `backend/src/vehicles/ownership.service.ts` (verifica el destino bajo RLS, `SAME_OWNER`, `reason-policy`, `UPDATE` con versión y `audit.record('vehicle.owner_changed')` en la misma transacción; historial desde `audit_log` con `audit_log_entity_idx`) y los endpoints `POST /vehicles/:vehicleId/ownership-transfers` y `GET /vehicles/:vehicleId/ownership-history` en `backend/src/vehicles/vehicles.controller.ts` — implementer-backend
- [ ] T074 [P] [US4] E2E en `backend/test/no-delete.e2e-spec.ts` (US4-AC17, FR-021): `DELETE /api/v1/clients/{id}` y `DELETE /api/v1/vehicles/{id}` → 404 y el registro sigue existiendo; ningún controlador declara `@Delete` (comprobado recorriendo las rutas registradas en la app) — tester
- [ ] T075 [US4] Confirmar que T074 está en verde sin código nuevo. Si alguna ruta `DELETE` existiera, eliminarla de `backend/src/` — implementer-backend
- [ ] T076 [P] [US4] Pruebas en `frontend/src/app/core/api/clients-api.service.spec.ts` y `frontend/src/app/core/api/vehicles-api.service.spec.ts` (`update`, `transferOwnership`, `getOwnershipHistory`) y en `frontend/src/app/core/auth/current-session.spec.ts` (lee `role` y `name` del payload del JWT guardado, sin verificar la firma, solo para la UI; token ausente o mal formado → sin sesión) — tester
- [ ] T077 [US4] Implementar los métodos nuevos en `frontend/src/app/core/api/clients-api.service.ts` y `frontend/src/app/core/api/vehicles-api.service.ts`, y `frontend/src/app/core/auth/current-session.ts` — implementer-frontend
- [ ] T078 [US4] Pruebas del modo edición en `frontend/src/app/features/clients/client-form.page.spec.ts` (`clients/:id/edit`). Cubre US4-AC4, US4-AC5, US4-AC11 y US4-AC15 (si cambia el documento y el rol es asesor, aparece el campo "Motivo" obligatorio de 10 a 500), US4-AC16 (admin: motivo opcional), US4-AC12 (409 → aviso "El registro cambió", muestra los datos actuales y permite repetir la edición) y US4-AC17 (sin acción de eliminar ni desactivar) — tester
- [ ] T079 [US4] Implementar el modo edición en `frontend/src/app/features/clients/client-form.page.ts` y la ruta `clients/:id/edit` — implementer-frontend
- [ ] T080 [US4] Pruebas en `frontend/src/app/features/vehicles/vehicle-form.page.spec.ts` (modo edición `vehicles/:id/edit`: US4-AC6, US4-AC11 y US4-AC15/AC16 al cambiar placa o VIN, US4-AC12, US4-AC17), `frontend/src/app/features/vehicles/transfer-ownership.dialog.spec.ts` (US4-AC7: elegir cliente destino con la búsqueda y confirmar explícitamente; US4-AC15/AC16: motivo obligatorio u opcional según el rol; `SAME_OWNER` → "El vehículo ya pertenece a este cliente"; `VERSION_CONFLICT`) y `frontend/src/app/features/vehicles/vehicle-detail.page.spec.ts` (US4-AC10: historial del más reciente al más antiguo con anterior, nuevo, fecha, usuario y motivo; sin acciones de editar ni borrar el historial; US4-AC17) — tester
- [ ] T081 [US4] Implementar el modo edición en `frontend/src/app/features/vehicles/vehicle-form.page.ts`, `frontend/src/app/features/vehicles/transfer-ownership.dialog.ts` y la sección de historial en `frontend/src/app/features/vehicles/vehicle-detail.page.ts` — implementer-frontend
- [ ] T082 [P] [US4] Ampliar `frontend/src/app/core/api/mock-api.interceptor.spec.ts` con `PATCH /clients/{id}`, `PATCH /vehicles/{id}` (200, 409 `VERSION_CONFLICT`, 400 `REASON_REQUIRED` según el rol del token), `POST /vehicles/{id}/ownership-transfers` (200, 404, 409, 422) y `GET /vehicles/{id}/ownership-history` — tester
- [ ] T083 [US4] Implementar esas rutas en `frontend/src/app/core/api/mock-api.interceptor.ts` — implementer-frontend

## Cierre PR3

- [ ] T084 Revisar el diff del PR3 contra la spec y la constitución 1.1.0 (principio IV ampliado). Foco: auditoría en la misma transacción, append-only, motivo según el rol tomado solo del JWT, bloqueo optimista en todas las escrituras, ningún endpoint ni botón de borrado, y pruebas con ID para US4-AC4 a AC17 — reviewer
- [ ] T085 Verificar el PR3: lo mismo que en T063; quickstart §2 completo (filas 1 a 15) y §4 (diálogo de transferencia con token asesor y admin). CI en verde — leader

---

## Dependencies & Execution Order

- **Enmienda de la constitución 1.1.0** (PR propio del leader, decisión P2): debe integrarse a `main` **antes que el PR1**, porque el PR1 ya usa Vitest y el PR3 audita eventos que solo lista la 1.1.0. Los reviewers (T036, T062, T084) revisan contra la 1.1.0.
- **PR1 → PR2 → PR3**, en ese orden: cada PR se integra a `main` antes de empezar el siguiente, o en ramas apiladas si el leader lo prefiere.
- **Dentro del PR1**:
  - T001 y T002 (pruebas) → T003 a T008 (setup).
  - T008 desbloquea la fase 2.
  - Dentro de la fase 2 los pares son independientes: T009→T010, T011→T012, T013→T014, T015→T016, T017→T018, T019→T020. T014 depende de T010 y T012.
  - US2 (T021 a T030) necesita toda la fase 2. La fase 4 (T031 a T034) necesita T022, T026 y T030.
- **Dentro del PR2**:
  - T038→T039 y T040→T041 antes de US3.
  - US3 (T043 a T052) antes de US1 (T053 a T058), porque la búsqueda necesita vehículos y la página inicial enlaza con `vehicles/new`.
  - Rendimiento (T059 a T061) después de T054.
- **Dentro del PR3**:
  - T064→T065 y T066→T067 antes de T068.
  - Backend: T068→T069, T070→T071, T072→T073 (T073 necesita T071 por el `update` con versión).
  - Frontend: T076→T077 y luego T078 a T083.
- Cada par prueba → implementación es secuencial: el implementer empieza cuando la prueba está en rojo por la razón correcta.

## Parallel Examples

```text
PR1 fase 2, a la vez:  T009 (tester), T011 (tester), T013 (tester), T015 (tester), T017 (tester), T019 (tester)
PR1 US2, a la vez:     T023 y T025 y T029 (tester, frontend) mientras implementer-backend hace T022
PR2 US3, a la vez:     T045, T047 y T051 (tester, frontend) mientras implementer-backend hace T044
PR3, a la vez:         T074 y T076 (tester) mientras implementer-backend hace T069
```

## Implementation Strategy

- **MVP = PR1 + PR2** (US2, US3 y US1, todas P1): con eso la recepción ya registra y busca. El PR3 (US4, P2) añade edición, transferencia y auditoría.
- Cada PR deja la rama verde y es demostrable con la sección correspondiente del quickstart.
- Si `test:perf` (T059) no cumple el p95 y el ajuste de T060 no basta, el leader detiene el PR2 y se vuelve a la spec (plan B del plan).

## Trazabilidad de criterios → tareas de prueba

| Criterios | Tareas |
|---|---|
| US1-AC1 a AC8 | T053, T055 |
| US1-AC9 | T043 |
| US1-AC10 | T059 |
| US2-AC1 a AC10 | T021 (backend), T023, T027 (frontend); base en T015 |
| US3-AC1 a AC14 | T043 (backend), T045, T049, T051 (frontend); base en T038, T040 |
| US4-AC1 a AC3 | T031, T033, T043 (vehículos en la ficha) |
| US4-AC4 a AC6 | T068, T070, T078, T080 |
| US4-AC7 a AC10 | T072, T080; inmutabilidad en T064 |
| US4-AC11 | T068, T070 |
| US4-AC12 | T068, T070, T072, T078, T080 |
| US4-AC13, AC14 | T068, T070, T072 |
| US4-AC15, AC16 | T066, T068, T070, T072, T078, T080 |
| US4-AC17 | T074, T078, T080 |
| FR-022 a FR-024 (aislamiento) | T001, T017, T040, T064 más los casos multi-tenant de cada e2e |
| FR-025, FR-026, SC-002 | T055 (ruta inicial y búsqueda al escribir) y la revisión manual de T063 |
