# Tasks: Historial clínico por placa (007) — modo ligero, un solo PR

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [data-model.md](./data-model.md), [contracts/openapi.yaml](./contracts/openapi.yaml)  
**PR único**: `feat/007-historial-placa` (base `main`). Pares prueba (rojo) → implementación.

## Phase 1: Backend Tests (tester)

- [ ] T001 [US1] `tester`: e2e en `backend/test/vehicle-history.e2e-spec.ts`:
  - US1-AC1: 200 con timeline cronológico unificado (más reciente primero) combinando check-ins, presupuestos, OT y transferencias de propietario.
  - US1-AC2: validación de payload y metadatos por cada tipo de evento (`checkin`, `budget`, `work_order`, `ownership_transfer`).
  - US1-AC3: vehículo sin eventos devuelve timeline vacío y métricas basadas en odómetro inicial.
  - US1-AC4: aislamiento multi-tenant: usuario del taller A consultando vehículo del taller B recibe 404 (exactamente igual que inexistente).
- [ ] T002 [US2] `tester`: e2e en `backend/test/vehicle-history.e2e-spec.ts`:
  - US2-AC1: `currentMileage` calcula el valor máximo entre odómetro inicial y check-ins, y calcula `mileageDelta`.
  - US2-AC2: conteos precisos de `totalCheckins`, `totalWorkOrders` y `totalDeliveredWorkOrders`.
  - US2-AC3: `totalInvested` suma exactamente los presupuestos de OT `entregada` (ignora canceladas, borradores o rechazados).
  - US2-AC4: `lastVisitAt` con la fecha más reciente de intervención y datos del propietario actual.

## Phase 2: Backend Implementation (implementer-backend)

- [ ] T003 [US1][US2] `implementer-backend`:
  - Crear `backend/src/vehicles/dto/vehicle-history.dto.ts` según el contrato OpenAPI.
  - Implementar `backend/src/vehicles/vehicle-history.service.ts`:
    - Consulta de verificación del vehículo y cliente bajo RLS (404 si no existe).
    - Extracción paralela de check-ins, presupuestos, órdenes de trabajo (con items y notas) y auditoría de transferencias.
    - Agregación en memoria de métricas clínicas (`currentMileage`, `totalInvested`, `lastVisitAt`, etc.).
    - Ordenamiento descendente del timeline unificado por `occurredAt`.
  - Agregar endpoint `GET /api/v1/vehicles/:vehicleId/history` en `backend/src/vehicles/vehicles.controller.ts` y registrar el servicio en `vehicles.module.ts`.

## Phase 3: Frontend Tests (tester)

- [ ] T004 [US3] `tester`:
  - Unit specs en `frontend/src/app/core/api/vehicles-api.service.spec.ts` para el método `getHistory(vehicleId)`.
  - Unit specs en `frontend/src/app/features/vehicles/vehicle-history/vehicle-history.component.spec.ts`:
    - Muestra estado de carga y renderiza métricas y resumen del vehículo (US2-AC1..AC4).
    - Renderiza timeline con insignias de estado por tipo de evento (US1-AC1..AC2).
    - Filtro interactivo en cliente por tipo de evento (US3-AC2).
    - Enlaces directos a las vistas de detalle de check-in, presupuesto y OT (US3-AC3).
    - Manejo de error 404 con mensaje amigable y botón de regreso a búsqueda (US3-AC5).

## Phase 4: Frontend Implementation (implementer-frontend)

- [ ] T005 [US3] `implementer-frontend`:
  - Definir interfaces de modelo para el historial clínico en `frontend/src/app/core/api/api.models.ts`.
  - Agregar método `getHistory(vehicleId: string): Observable<VehicleClinicalHistory>` en `frontend/src/app/core/api/vehicles-api.service.ts`.
- [ ] T006 [US3] `implementer-frontend`:
  - Crear componente `VehicleHistoryComponent` en `frontend/src/app/features/vehicles/vehicle-history/`:
    - Template con tarjetas de métricas, controles de filtro rápido y lista cronológica de eventos.
    - SCSS responsivo y sección `@media print` para formato de impresión limpio (US3-AC4).
  - Registrar ruta `vehicles/:id/history` en `frontend/src/app/app.routes.ts`.
  - Agregar botón de acción "Historial clínico" en la barra de herramientas de `frontend/src/app/features/vehicles/vehicle-detail.page.html`.
- [ ] T007 [US3] `implementer-frontend`:
  - Agregar soporte para `getHistory` en la API simulada mock de desarrollo (`frontend/src/app/core/api/mock/`).

## Phase 5: Verification & Closing

- [ ] T008 `implementer-backend`:
  - Correr `npm run lint`, `npm test`, `npm run test:e2e` y `npm run build` en backend y frontend.
  - Verificar que no haya regresiones en suites anteriores.

## Dependencias

T001/T002 (rojo backend) → T003 (verde backend).  
T004 (rojo frontend) → T005 → T006 → T007 (verde frontend).  
T008 (cierre de suite).
