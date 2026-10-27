# Tasks: Check-in 360° (004) — modo ligero, un solo PR

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [data-model.md](./data-model.md), [contracts/openapi.yaml](./contracts/openapi.yaml)
**PR único**: `feat/004-checkin-360`. Pares prueba (rojo) → implementación. Pruebas: camino feliz, aislamiento y errores clave; sin concurrencia ni rendimiento.

## Phase 1: Foundational (BD)

- [ ] T001 `tester`: prueba de BD de RLS en `backend/test/checkins.e2e-spec.ts` (bloque "db"): como `motorsync_app` sin tenant → 0 filas en `checkins`, `checkin_damages`, `checkin_images`; con tenant A no se ven filas de B; `UPDATE`/`DELETE` sobre `checkins` fallan por permisos (US2-AC2, US2-AC3).
- [ ] T002 `implementer-backend`: migración `backend/src/database/migrations/1761000001600-CreateCheckins.ts` según data-model (enums `fuel_level IN ('vacio','1/4','1/2','3/4','lleno')`, `view IN ('frente','atras','izquierda','derecha','arriba')`, `type IN ('rayon','golpe','abolladura','rotura','faltante','otro')`, `reason` 1..1000, `note ≤ 500`, `octet_length(data) ≤ 1048576`, FKs compuestas con `tenant_id`, RLS ENABLE+FORCE, grants `SELECT, INSERT` y `UPDATE` solo en `checkin_counters`).

## Phase 2: US1 — Registrar recepción (P1)

- [ ] T003 [US1] `tester`: e2e `POST /vehicles/{id}/checkins` en `backend/test/checkins.e2e-spec.ts`: US1-AC1 (201, número correlativo 1 y luego 2, autor y propietario de la sesión/vehículo), US1-AC2 (400 sin firma, `mileage` -1, `fuelLevel` inválido, `view` inválida), US1-AC3 (409 con `lastMileage`), US1-AC4 (400 foto no JPEG/PNG por magic bytes y > 1 MB), US1-AC5 (404 vehículo de B, nada creado).
- [ ] T004 [P] [US1] `tester`: unitarias de `backend/src/checkins/image.util.spec.ts` (decodifica base64, verifica magic bytes JPEG `FFD8FF`/PNG `89504E47`, rechaza > 1 048 576 bytes).
- [ ] T005 [US1] `implementer-backend`: `backend/src/checkins/image.util.ts` y DTOs `backend/src/checkins/dto/create-checkin.dto.ts` (class-validator: inventario ≤ 30 ítems de 1..100, daños ≤ 20, `whitelist`).
- [ ] T006 [US1] `implementer-backend`: `checkins.module.ts`, `checkins.controller.ts`, `checkins.service.ts` en `backend/src/checkins/` (transacción con tenant de la sesión, guardias de la 002 para `asesor`/`admin`, contador `UPDATE checkin_counters … RETURNING`, FR-004 con `max(mileage)`, límite de body 25 MB solo en esta ruta); registrar en `backend/src/app.module.ts`.
- [ ] T007 [P] [US1] `tester`: specs de `frontend/src/app/features/checkins/checkin.service.spec.ts` (POST según contrato) y `checkin-form/checkin-form.component.spec.ts` (envía payload válido; bloquea guardar sin firma ni motivo; muestra `lastMileage` ante 409).
- [ ] T008 [US1] `implementer-frontend`: `checkin.service.ts`, `checkin-form/`, `damage-map/` (5 vistas, toque para marcar daño con tipo, nota y foto comprimida en canvas a JPEG 0.7, máx. 1280 px) y `signature-pad/` (canvas táctil → PNG) en `frontend/src/app/features/checkins/`; ruta `vehicles/:id/checkins/new` en `frontend/src/app/app.routes.ts`; objetivos táctiles ≥ 44 px.

## Phase 3: US2 — Consultar check-ins (P2)

- [ ] T009 [US2] `tester`: e2e en `backend/test/checkins.e2e-spec.ts`: US2-AC1 (lista ordenada desc con `damageCount`, detalle completo, imagen devuelve los mismos bytes y `Content-Type`), US2-AC2 (404 en lista de vehículo de B, detalle e imagen de B; la lista de A no incluye B), US2-AC3 (PUT/PATCH/DELETE `/checkins/{id}` → 404).
- [ ] T010 [US2] `implementer-backend`: `GET /vehicles/{id}/checkins`, `GET /checkins/{id}`, `GET /checkins/{id}/images/{imageId}` en `backend/src/checkins/checkins.controller.ts` y `checkins.service.ts`.
- [ ] T011 [P] [US2] `tester`: specs `frontend/src/app/features/checkins/checkin-list/checkin-list.component.spec.ts` (lista y estado vacío) y `checkin-detail/checkin-detail.component.spec.ts` (daños por vista, fotos y firma cargadas como blob; 404 → "no encontrado").
- [ ] T012 [US2] `implementer-frontend`: `checkin-list/` y `checkin-detail/` en `frontend/src/app/features/checkins/`, rutas `vehicles/:id/checkins` y `checkins/:id` en `app.routes.ts`, enlace "Check-ins" en el detalle del vehículo.

## Phase 4: Cierre

- [ ] T013 `implementer-frontend`: handlers de check-in en la API simulada (`--configuration mock`) con las mismas reglas del contrato, en el mock existente de `frontend/src/app/core/`.
- [ ] T014 `implementer-backend`: actualizar `quickstart.md` si cambió algún comando y correr lint, `npm test`, `npm run test:e2e` y `npm run build` en backend y frontend.

## Dependencias

T001→T002→T003/T004→T005→T006→T009→T010. Frontend (T007→T008→T011→T012→T013) puede ir en paralelo contra el contrato desde el inicio. MVP: US1.
