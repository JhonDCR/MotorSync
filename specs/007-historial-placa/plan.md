# Implementation Plan: Historial clínico por placa (007)

**Branch**: `feat/007-historial-placa` (base `main`) | **Date**: 2026-10-27 | **Spec**: [spec.md](./spec.md)  
**Aprobación**: pendiente del humano (spec y plan).  
**Modo**: ligero (un solo PR).  

## Summary

Módulo de historial por placa (backend + frontend) que proporciona una vista unificada del historial clínico y operativo de un vehículo en el taller. Agrupa cronológicamente en un timeline sus check-ins 360°, presupuestos, órdenes de trabajo y transferencias de propietario. Calcula métricas de odómetro acumulado, visitas e inversión histórica, y expone en el frontend una interfaz interactiva con filtros instantáneos y formato imprimible para el cliente.

## Technical Context

- **Stack**: NestJS 12 + PostgreSQL 16 con RLS (`backend/src/vehicles/`), Angular 22 standalone (`frontend/src/app/features/vehicles/vehicle-history/`).
- **Pruebas**: Vitest; e2e contra PostgreSQL real (`backend/test/vehicle-history.e2e-spec.ts`); frontend con jsdom (`vehicle-history.component.spec.ts`).
- **Restricciones**: Sin librerías nuevas (YAGNI). Montos formateados como string decimal con 2 decimales (`numeric(12,2)`). Tiempo de respuesta < 200 ms (p95).

## Decisiones

| # | Decisión | Por qué / alternativa descartada |
|---|---|---|
| D1 | Endpoint `GET /api/v1/vehicles/:vehicleId/history` dentro de `VehiclesController` / `VehicleHistoryService`. | Mantiene la cohesión del agregado de vehículos sin dispersar rutas ni crear micro-módulos innecesarios. |
| D2 | Sin tablas nuevas (constitución V - YAGNI): lectura agregada sobre `vehicles`, `clients`, `checkins`, `budgets`, `work_orders`, `work_order_items`, `work_order_notes` y `audit_log`. | Toda la información ya existe en las tablas de las features 001, 004, 005 y 006. Crear una tabla de historial crearía desincronización y duplicación. |
| D3 | Consulta bajo transacción con RLS fijando `app.tenant_id`: si el vehículo no existe o es de otro taller, retorna 404 de inmediato. | Garantiza aislamiento total (Constitución I) y previene enumeración de vehículos entre talleres. |
| D4 | Inversión acumulada (`totalInvested`) calculada sumando los presupuestos aprobados con OT en estado `entregada`. | Refleja el gasto real ejecutado y facturado, excluyendo presupuestos borradores, rechazados o de OT canceladas. |
| D5 | Odómetro actual calculado como `Math.max(initialMileage, ...checkins.map(c => c.mileage))`. | El kilometraje es creciente y los check-ins representan lecturas verificadas de odómetro. |
| D6 | Frontend: Nueva página `VehicleHistoryComponent` bajo la ruta `/vehicles/:id/history` y botón de acceso directo "Historial clínico" en `VehicleDetailPage`. | Permite tanto ver la ficha rápida como consultar la historia clínica profunda del vehículo. |
| D7 | Filtro de timeline en el cliente por tipo de evento (`todos`, `checkin`, `budget`, `work_order`, `ownership_transfer`). | Respuesta instantánea sin consultas adicionales al servidor. |
| D8 | Estilos `@media print` dedicados para exportar o imprimir en formato A4 limpio sin elementos de navegación ni botones. | Permite al taller entregar un comprobante físico o PDF al cliente al entregar el vehículo. |

## Constitution Check

| Principio | Cómo se cumple | Estado |
|---|---|---|
| I. Multi-tenant (`tenant_id`, RLS) | Todas las lecturas ejecutan con RLS activa. Acceso a un vehículo del taller B retorna 404 (US1-AC4). Prueba e2e multi-tenant explícita. | Cumple |
| I. Tenant desde la sesión | `TenantContext` inyectado por middleware de sesión JWT (002). | Cumple |
| II. Test-First con IDs | Pruebas e2e y unitarias creadas antes del código de producción con referencias `[USx-ACy]`. | Cumple |
| III. Spec y contratos primero | [contracts/openapi.yaml](./contracts/openapi.yaml) define el payload y códigos HTTP antes de implementar. | Cumple |
| IV. Auditoría inmutable | Solo lectura; no modifica tablas auditables. Muestra los eventos de `audit_log` (`vehicle.owner_changed`) en el timeline. | Cumple |
| V. Simplicidad y tipado estricto | TypeScript `strict: true`, DTOs de respuesta fuertemente tipados, sin dependencias externas añadidas. | Cumple |

## Project Structure

```text
backend/src/vehicles/
  vehicle-history.service.ts       # Servicio de consulta y consolidación de timeline y métricas
  vehicles.controller.ts           # Endpoint GET /vehicles/:vehicleId/history
  dto/vehicle-history.dto.ts       # Tipos y contratos del historial
backend/test/
  vehicle-history.e2e-spec.ts      # Pruebas e2e: camino feliz, métricas, sin eventos, aislamiento multi-tenant

frontend/src/app/features/vehicles/
  vehicle-history/
    vehicle-history.component.ts   # Página del historial clínico
    vehicle-history.component.html # Tarjetas de métricas y timeline
    vehicle-history.component.scss # Estilos responsivos y @media print
    vehicle-history.component.spec.ts # Pruebas unitarias de la vista y filtros
  vehicle-detail.page.html         # Botón de enlace a "Historial clínico"
frontend/src/app/core/api/
  vehicles-api.service.ts          # Método getHistory(vehicleId)
```

## Complexity Tracking

Ninguna. Módulo de agregación de lectura pura.

## Riesgos

- **Rendimiento con vehículos muy antiguos (muchas visitas)**: mitigado gracias a los índices compuestos existentes `(tenant_id, vehicle_id, created_at DESC)` en `checkins`, `budgets` y `work_orders`.
