# Data Model: Historial por placa (007)

Feature de consulta y consolidación (lectura pura). **No crea tablas nuevas en la base de datos**.

Reutiliza las tablas maestras de las features 001, 004, 005 y 006, todas con `tenant_id uuid NOT NULL REFERENCES tenants(id)`, `ENABLE` + `FORCE ROW LEVEL SECURITY` y política `tenant_isolation USING/WITH CHECK (tenant_id = app_current_tenant())`:

## Tablas consultadas

| Tabla | Origen | Columnas relevantes para el historial | Índice aprovechado |
|---|---|---|---|
| `vehicles` | 001 | `id`, `plate`, `brand`, `model`, `year`, `color`, `body_type`, `vin`, `initial_mileage`, `client_id`, `created_at` | `(tenant_id, id)`, `(tenant_id, plate)` |
| `clients` | 001 | `id`, `display_name`, `document_type`, `document_number`, `phone` | `(tenant_id, id)` |
| `checkins` | 004 | `id`, `mileage`, `fuel_level`, `damages`, `photos`, `has_inventory`, `author_name`, `created_at` | `(tenant_id, vehicle_id, created_at DESC)` |
| `budgets` | 005 | `id`, `checkin_id`, `number`, `status`, `subtotal`, `tax`, `total`, `created_at`, `lines` | `(tenant_id, vehicle_id, created_at DESC)` |
| `work_orders` | 006 | `id`, `budget_id`, `checkin_id`, `number`, `status`, `assignee_id`, `created_at`, `updated_at` | `(tenant_id, vehicle_id, created_at DESC)` |
| `work_order_items` | 006 | `work_order_id`, `id` (para conteo de ítems) | `(tenant_id, work_order_id)` |
| `work_order_notes` | 006 | `work_order_id`, `id` (para conteo de notas) | `(tenant_id, work_order_id)` |
| `audit_log` | 001 | `entity_type = 'vehicle'`, `entity_id = :vehicleId`, `action = 'vehicle.owner_changed'`, `before`, `after`, `actor_name`, `occurred_at` | `(tenant_id, entity_type, entity_id, occurred_at DESC)` |

## Estrategia de consulta

1. **Verificación de pertenencia**:
   Se consulta `vehicles` con JOIN a `clients` por `(tenant_id, id)`. Si no existe fila bajo RLS, el endpoint responde inmediatamente con `404 NOT_FOUND` (evita revelar existencia en otro taller).

2. **Extracción paralela/combinada bajo la misma transacción**:
   - `checkins`: registros del vehículo ordenados por `created_at DESC`.
   - `budgets`: registros del vehículo ordenados por `created_at DESC`, con subtotal, total y conteo de líneas.
   - `work_orders`: registros con JOIN a `users` para el nombre del responsable, conteo de `work_order_items` y `work_order_notes`, y fecha de entrega desde `work_order_status_changes` (si aplica).
   - `audit_log`: transferencias de propiedad del vehículo (`action = 'vehicle.owner_changed'`).

3. **Agregación en memoria de métricas**:
   - `currentMileage`: `Math.max(initialMileage, ...checkins.map(c => c.mileage))`.
   - `mileageDelta`: `currentMileage - initialMileage`.
   - `totalCheckins`: `checkins.length`.
   - `totalWorkOrders`: `workOrders.length`.
   - `totalDeliveredWorkOrders`: `workOrders.filter(wo => wo.status === 'entregada').length`.
   - `totalInvested`: Suma de los presupuestos de las órdenes `entregada`.
   - `lastVisitAt`: Fecha máxima entre el check-in más reciente y la OT más reciente.

4. **Ensamblado del Timeline**:
   Cada entidad se transforma a su respectivo `VehicleTimelineEvent` y se mezclan en una sola lista ordenada por `occurredAt DESC`.
