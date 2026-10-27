# Tasks: Órdenes de trabajo (006) — modo ligero, un solo PR

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [data-model.md](./data-model.md), [contracts/openapi.yaml](./contracts/openapi.yaml)
**PR único**: `feat/006-ordenes-trabajo` (base `feat/005-presupuestos-main`). Pares prueba (rojo) → implementación. Pruebas: camino feliz, aislamiento y errores clave.

## Phase 1: Foundational

- [ ] T001 `tester`: bloque "db" en `backend/test/work-orders.e2e-spec.ts`: como `motorsync_app` sin tenant → 0 filas en las 4 tablas de OT; con tenant A no se ven filas de B; `UPDATE`/`DELETE` sobre `work_order_items`, `work_order_status_changes` y `work_order_notes` fallan por permisos; segunda OT activa del mismo check-in viola el índice único parcial (US1-AC2, US3-AC2).
- [ ] T002 `implementer-backend`: migración `backend/src/database/migrations/1761000001800-CreateWorkOrders.ts` según data-model (checks, FKs compuestas, índice único parcial, RLS ENABLE+FORCE, grants, `work_order_counters`).

## Phase 2: US1 + US2 — Crear, avanzar, cancelar y anotar (P1)

- [ ] T003 [US1] `tester`: e2e en `backend/test/work-orders.e2e-spec.ts`: US1-AC1 (201, número 1, 2 ítems copiados en orden, responsable = autor, historial `abierta`), US1-AC2 (409 `budget_not_approved` con un `enviado`; 409 `work_order_exists` al repetir), US1-AC3 (admin reasigna → 200; asesor → 403; usuario de B → 422), US1-AC4 (404 al crear con presupuesto de B y al leer/avanzar/anotar una OT de B; nada cambia en B).
- [ ] T004 [US2] `tester`: e2e en el mismo archivo: US2-AC1 (start → finish → deliver; 4 filas de historial; 3 filas en `audit_log` `work_order.status_changed` con before/after y `reason` no nulo para el asesor), US2-AC2 (cancel con motivo → `work_order.cancelled`; sin motivo → 400), US2-AC3 (409 con `currentStatus` en abierta → finish y en cancel de una `terminada`), US2-AC4 (nota 201 visible en detalle; 409 en OT `entregada`).
- [ ] T005 [US1][US2] `implementer-backend`: `work-orders.module.ts`, `work-orders.controller.ts`, `work-orders.service.ts`, `dto/` en `backend/src/work-orders/` (transacción con tenant de la sesión, guardias `asesor`/`admin` y `admin` en assignee, contador, `INSERT … SELECT` de ítems, mapeo `23505` → 409, `UPDATE … WHERE status` → 409, historial + `AuditService` con motivo); registrar en `backend/src/app.module.ts`.

## Phase 3: US3 — Tablero y consultas (P2)

- [ ] T006 [US3] `tester`: e2e: US3-AC1 (filtro `status=en_proceso` solo devuelve esas, desc; detalle con ítems, historial y notas; lista por vehículo), US3-AC2 (tablero de A sin OT de B; 404 en vehículo de B).
- [ ] T007 [US3] `implementer-backend`: `GET /work-orders`, `GET /vehicles/{id}/work-orders` y `GET /work-orders/{id}` en `work-orders.controller.ts` y `work-orders.service.ts`.

## Phase 4: Frontend

- [ ] T008 [P] `tester`: specs `frontend/src/app/features/work-orders/work-order.service.spec.ts` (rutas del contrato) y `work-order-detail/work-order-detail.component.spec.ts` (botones según estado, cancelar pide motivo, muestra el 409 con el estado actual, agrega nota) (US2-AC1..AC4).
- [ ] T009 `implementer-frontend`: `work-order.service.ts` y `work-order-detail/` en `frontend/src/app/features/work-orders/`; botón "Crear OT" en el detalle de un presupuesto `aprobado`; selector de responsable solo para admin; ruta `work-orders/:id` en `frontend/src/app/app.routes.ts`.
- [ ] T010 [P] `tester`: spec `frontend/src/app/features/work-orders/work-order-board/work-order-board.component.spec.ts` (filtro por estado llama con `status`; estado vacío) (US3-AC1).
- [ ] T011 `implementer-frontend`: `work-order-board/`, ruta `work-orders`, enlace en el menú y en el detalle del vehículo, y handlers de OT en la API simulada (`--configuration mock`) de `frontend/src/app/core/`.

## Phase 5: Cierre

- [ ] T012 `implementer-backend`: correr lint, `npm test`, `npm run test:e2e` y `npm run build` en backend y frontend; ajustar `quickstart.md` si cambió algún comando.

## Dependencias

T001→T002→T003/T004→T005→T006→T007. Frontend T008→T009→T010→T011 en paralelo contra el contrato. MVP: US1+US2.
