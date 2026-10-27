# Implementation Plan: Presupuestos de un check-in

**Branch**: `feat/005-presupuestos` (base `feat/004-checkin-360`) | **Date**: 2026-10-26 | **Spec**: [spec.md](./spec.md)
**Aprobación**: pendiente del humano (spec y plan).
**Modo**: ligero (entrega 2026-10-30). Sin `research.md`; decisiones abajo.

## Summary

Módulo `budgets` (backend + frontend) que crea presupuestos en borrador para un check-in de la 004, recalcula montos en el servidor, gestiona la máquina de estados y audita aprobación/rechazo. Reutiliza contexto de tenant, RLS, guardias de sesión/rol, Problem Details y el patrón de contador correlativo de la 004.

## Technical Context

- **Stack**: NestJS 12 + TypeORM (`backend/src/budgets/`), Angular 22 standalone (`frontend/src/app/features/budgets/`), PostgreSQL 16 con RLS.
- **Pruebas**: Vitest; e2e contra PostgreSQL real (`backend/test/budgets.e2e-spec.ts`); frontend con jsdom.
- **Restricciones**: sin librerías nuevas; montos `numeric(12,2)`, cantidades `numeric(10,2)`, tasa `numeric(5,4)`.

## Decisiones

| # | Decisión | Por qué / alternativa descartada |
|---|---|---|
| D1 | Montos como **string decimal** en la API (`"18.50"`) y `numeric` en BD; cálculo en el servidor con aritmética entera en centavos (`BigInt`) en `money.util.ts`. | Nunca `float` (requisito). Sin librería decimal nueva. El cliente solo muestra lo que devuelve el servidor (previsualización con la misma util copiada al frontend). |
| D2 | IVA: constante `DEFAULT_TAX_RATE = '0.15'` guardada en `budgets.tax_rate` al crear. | Sin tabla de configuración por taller (supuesto de la spec); hacerla después no requiere migrar. |
| D3 | Edición del borrador = `PUT /budgets/{id}` que reemplaza todas las líneas (borra e inserta) en una transacción. | Más simple que PATCH por línea. |
| D4 | Transiciones por rutas explícitas: `POST /budgets/{id}/send`, `/approve`, `/reject`. `UPDATE … WHERE status = <esperado>`; 0 filas → 409 con `currentStatus`. | Evita carreras sin bloqueos explícitos. |
| D5 | Correlativo con `budget_counters` igual que `checkin_counters` (004 D4). | Patrón probado. |
| D6 | `approve`/`reject` escriben en `audit_log` vía `AuditService` existente en la misma transacción (acción `budget.approved`/`budget.rejected`, before/after `{status}`). | Constitución IV. "Cambio de precio en presupuesto aprobado" no aplica: un aprobado no se edita. |
| D7 | `motorsync_app`: `SELECT, INSERT, UPDATE` en `budgets` (sin `DELETE`); `SELECT, INSERT, DELETE` en `budget_lines` (reemplazo de líneas); el servicio verifica `borrador` antes. Trigger `budget_lines_draft_only` rechaza insertar/borrar líneas si el presupuesto no está en `borrador`. | Segunda barrera en BD para FR-005. |
| D8 | `vehicle_id` denormalizado en `budgets` (copiado del check-in, FK compuesta) para listar por vehículo sin join. | Consulta directa por índice. |

## Constitution Check

| Principio | Cómo se cumple | Estado |
|---|---|---|
| I. `tenant_id NOT NULL`, FK, índice | `budgets`, `budget_lines`, `budget_counters` ([data-model](./data-model.md)); FKs compuestas `(tenant_id, checkin_id)` y `(tenant_id, vehicle_id)`. | Cumple |
| I. RLS `ENABLE` + `FORCE` | Política `tenant_isolation` en las 3 tablas. | Cumple |
| I. Tenant desde la sesión | `database/tenant-context` y guardias de la 002. | Cumple |
| I. Prueba A no lee/modifica B | US1-AC4, US3-AC2 en e2e + prueba de BD sin tenant → 0 filas. | Cumple |
| II. Test-first con IDs de AC | Pares prueba → implementación en tasks.md. | Cumple |
| III. Spec, plan, tasks y contrato | [contracts/openapi.yaml](./contracts/openapi.yaml). | Cumple |
| IV. Auditoría | Aprobación/rechazo en `audit_log` en la misma transacción (D6). | Cumple |
| V. Strict, DTOs, YAGNI | DTOs class-validator con regex decimal `^\d{1,10}(\.\d{1,2})?$`; sin dependencias nuevas. | Cumple |

## Project Structure

```text
backend/src/budgets/             budgets.module.ts, budgets.controller.ts, budgets.service.ts, money.util.ts, dto/
backend/src/database/migrations/ 1761000001700-CreateBudgets.ts
backend/test/budgets.e2e-spec.ts
frontend/src/app/features/budgets/  budget.service.ts, budget-form/, budget-list/, budget-detail/
```

## Complexity Tracking

Ninguna.

## Riesgos

- Depende de la 004 sin mergear: si la 004 cambia en revisión, rebase de esta rama.
- Redondeo: mitad hacia arriba por línea y en el IVA; validar con el negocio (ver preguntas abiertas).
