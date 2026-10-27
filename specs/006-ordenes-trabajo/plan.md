# Implementation Plan: Órdenes de trabajo (OT)

**Branch**: `feat/006-ordenes-trabajo` (base `feat/005-presupuestos-main`) | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)
**Aprobación**: pendiente del humano (spec y plan).
**Modo**: ligero (entrega 2026-10-30). Sin `research.md`; decisiones abajo.

## Summary

Módulo `work-orders` (backend + frontend) que crea una OT desde un presupuesto `aprobado` de la 005, copia sus líneas como ítems, gestiona la máquina de estados con historial y auditoría, notas append-only y reasignación por el administrador. Reutiliza tenant context, RLS, guardias de sesión/rol, Problem Details, `AuditService`, el contador correlativo y el patrón `UPDATE … WHERE status` → 409 de la 005.

## Technical Context

- **Stack**: NestJS 12 + TypeORM (`backend/src/work-orders/`), Angular 22 standalone (`frontend/src/app/features/work-orders/`), PostgreSQL 16 con RLS.
- **Pruebas**: Vitest; e2e contra PostgreSQL real (`backend/test/work-orders.e2e-spec.ts`); frontend con jsdom.
- **Restricciones**: sin librerías nuevas; cantidades `numeric(10,2)` como string decimal en la API (igual que la 005).

## Decisiones

| # | Decisión | Por qué / alternativa descartada |
|---|---|---|
| D1 | `POST /budgets/{id}/work-orders` crea la OT; el servicio lee el presupuesto (RLS) y exige `aprobado` → si no, 409 `budget_not_approved`. | Ruta anidada como en la 005. |
| D2 | `UNIQUE (tenant_id, budget_id)` y índice único parcial `(tenant_id, checkin_id) WHERE status NOT IN ('entregada','cancelada')`. Violaciones `23505` → 409 `work_order_exists` / `checkin_has_active_work_order`. | La BD resuelve la carrera de dos creaciones simultáneas (edge case). |
| D3 | Ítems copiados con `INSERT … SELECT` desde `budget_lines` en la misma transacción. `motorsync_app` solo `SELECT, INSERT` en `work_order_items`. | Inmutables por permisos (FR-003). |
| D4 | Transiciones: `POST /work-orders/{id}/start`, `/finish`, `/deliver`, `/cancel` (body `{reason}`). `UPDATE … WHERE status = <esperado>`; 0 filas → 409 con `currentStatus`. | Igual que 005 D4. |
| D5 | Historial en `work_order_status_changes` (append-only: `SELECT, INSERT`) y `audit_log` vía `AuditService` en la misma transacción. Acciones `work_order.status_changed` y `work_order.cancelled`, before/after `{status}`. | Constitución IV (cambio de estado y anulación de OT). El historial es lo que la UI lee; `audit_log` es la evidencia. |
| D6 | `reason` en `audit_log`: en `cancel` es el motivo del usuario; en el resto, texto fijo (`"OT en proceso"`, `"OT terminada"`, `"OT entregada"`), igual que la 005 para cumplir el CHECK `audit_log_asesor_reason`. | No pedir motivo al usuario para avances normales. |
| D7 | `PATCH /work-orders/{id}/assignee` `{userId}` solo con rol `admin`; el servicio verifica que el usuario exista (RLS de `users`) y esté activo → si no, 422. | Sin rol técnico (supuesto de la spec). No se audita: no es un cambio de rol ni de estado. |
| D8 | Notas en `work_order_notes` (`SELECT, INSERT`); 409 si la OT está `entregada` o `cancelada`. | Append-only (US2-AC4). |
| D9 | `GET /work-orders?status=` (tablero, paginado `limit` ≤ 100, desc) y `GET /vehicles/{id}/work-orders`; `vehicle_id` denormalizado con FK compuesta como en 005 D8. | Base del historial por placa (007). |
| D10 | Correlativo con `work_order_counters` (005 D5). | Patrón probado. |

## Constitution Check

| Principio | Cómo se cumple | Estado |
|---|---|---|
| I. `tenant_id NOT NULL`, FK, índice | 5 tablas en [data-model](./data-model.md); FKs compuestas a `budgets`, `checkins`, `vehicles`, `users`. | Cumple |
| I. RLS `ENABLE` + `FORCE` | Política `tenant_isolation` en todas. | Cumple |
| I. Tenant desde la sesión | `database/tenant-context` y guardias de la 002. | Cumple |
| I. Prueba A no lee/modifica B | US1-AC4, US3-AC2 en e2e + prueba de BD sin tenant → 0 filas. | Cumple |
| II. Test-first con IDs de AC | Pares prueba → implementación en tasks.md. | Cumple |
| III. Spec, plan, tasks y contrato | [contracts/openapi.yaml](./contracts/openapi.yaml). | Cumple |
| IV. Auditoría | Cambio de estado y anulación de OT en `audit_log` en la misma transacción, con motivo (D5, D6). | Cumple |
| V. Strict, DTOs, YAGNI | DTOs class-validator; sin dependencias nuevas; sin rol técnico ni Kanban. | Cumple |

## Project Structure

```text
backend/src/work-orders/          work-orders.module.ts, work-orders.controller.ts, work-orders.service.ts, dto/
backend/src/database/migrations/  1761000001800-CreateWorkOrders.ts
backend/test/work-orders.e2e-spec.ts
frontend/src/app/features/work-orders/  work-order.service.ts, work-order-board/, work-order-detail/
```

## Complexity Tracking

Ninguna.

## Riesgos

- Depende de la 005 sin mergear (PR #22): si cambia en revisión, rebase.
- Responsable restringido a `asesor`/`admin`; si el negocio exige técnicos sin acceso, hace falta otra feature de roles.
