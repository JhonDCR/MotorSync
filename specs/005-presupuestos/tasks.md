# Tasks: Presupuestos (005) — modo ligero, un solo PR

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [data-model.md](./data-model.md), [contracts/openapi.yaml](./contracts/openapi.yaml)
**PR único**: `feat/005-presupuestos` (base `feat/004-checkin-360`). Pares prueba (rojo) → implementación. Pruebas: camino feliz, aislamiento y errores clave.

## Phase 1: Foundational

- [x] T001 `tester`: bloque "db" en `backend/test/budgets.e2e-spec.ts`: como `motorsync_app` sin tenant → 0 filas en `budgets` y `budget_lines`; con tenant A no se ven filas de B; `DELETE` sobre `budgets` falla por permisos; insertar una línea en un presupuesto `enviado` falla por el trigger (US3-AC2, US2-AC2).
- [x] T002 `implementer-backend`: migración `backend/src/database/migrations/1761000001700-CreateBudgets.ts` según data-model (checks, FKs compuestas, RLS ENABLE+FORCE, grants de D7, trigger `budget_lines_draft_only`, `budget_counters`).
- [x] T003 [P] `tester`: unitarias `backend/src/budgets/money.util.spec.ts`: 2 × 18.50 = 37.00; subtotal 62.00 → IVA 9.30 y total 71.30; redondeo mitad hacia arriba (1.5 × 0.33 = 0.495 → 0.50); rechaza más de 2 decimales (US1-AC1, SC-002).
- [x] T004 `implementer-backend`: `backend/src/budgets/money.util.ts` (centavos con `BigInt`, `DEFAULT_TAX_RATE = '0.15'`).

## Phase 2: US1 + US2 — Borrador, envío y decisión (P1)

- [x] T005 [US1] `tester`: e2e en `backend/test/budgets.e2e-spec.ts`: US1-AC1 (201, número 1 y luego 2, montos 62.00/9.30/71.30, `taxRate` 0.1500), US1-AC2 (PUT recalcula), US1-AC3 (400 sin líneas, `quantity` 0, `unitPrice` "1.234", `kind` inválido), US1-AC4 (404 al crear sobre un check-in de B y al leer/editar un presupuesto de B; nada cambia en B).
- [x] T006 [US2] `tester`: e2e en el mismo archivo: US2-AC1 (send → approve y send → reject; `decidedBy`/`decidedAt`; fila en `audit_log` con acción `budget.approved`/`budget.rejected` y before/after de `status`), US2-AC2 (409 con `currentStatus` al editar un `enviado`, aprobar un `borrador` y rechazar un `aprobado`).
- [x] T007 [US1][US2] `implementer-backend`: `budgets.module.ts`, `budgets.controller.ts`, `budgets.service.ts`, `dto/budget-input.dto.ts` en `backend/src/budgets/` (transacción con tenant de la sesión, guardias `asesor`/`admin`, contador, `UPDATE … WHERE status` → 409, `AuditService` en approve/reject); registrar en `backend/src/app.module.ts`.

## Phase 3: US3 — Consultar (P2)

- [x] T008 [US3] `tester`: e2e: US3-AC1 (lista por vehículo ordenada desc con 2 presupuestos de distintos check-ins; lista por check-in solo con el suyo; detalle con líneas), US3-AC2 (404 en listas de vehículo y check-in de B; listas de A sin filas de B).
- [x] T009 [US3] `implementer-backend`: `GET /checkins/{id}/budgets`, `GET /vehicles/{id}/budgets` y `GET /budgets/{id}` en `budgets.controller.ts` y `budgets.service.ts`.

## Phase 4: Frontend

- [x] T010 [P] `tester`: specs `frontend/src/app/features/budgets/budget.service.spec.ts` (rutas del contrato) y `budget-form/budget-form.component.spec.ts` (agrega/quita líneas, previsualiza 62.00/9.30/71.30, bloquea guardar sin líneas, muestra el 409 con el estado actual) (US1-AC1, US1-AC3, US2-AC2).
- [x] T011 `implementer-frontend`: `budget.service.ts`, `budget-form/` (crear y editar borrador) y `budget-detail/` (montos y acciones Enviar/Aprobar/Rechazar según estado) en `frontend/src/app/features/budgets/`; rutas `checkins/:id/budgets/new`, `budgets/:id` y `budgets/:id/edit` en `frontend/src/app/app.routes.ts`.
- [x] T012 [P] `tester`: spec `frontend/src/app/features/budgets/budget-list/budget-list.component.spec.ts` (lista con estado y total; estado vacío) (US3-AC1).
- [x] T013 `implementer-frontend`: `budget-list/`, enlaces "Presupuestos" en el detalle del check-in y del vehículo, y handlers de presupuestos en la API simulada (`--configuration mock`) de `frontend/src/app/core/`.

## Phase 5: Cierre

- [x] T014 `implementer-backend`: correr lint, `npm test`, `npm run test:e2e` y `npm run build` en backend y frontend; ajustar `quickstart.md` si cambió algún comando.

## Dependencias

T001→T002; T003→T004; T002+T004→T005/T006→T007→T008→T009. Frontend T010→T011→T012→T013 en paralelo contra el contrato. MVP: US1+US2.
