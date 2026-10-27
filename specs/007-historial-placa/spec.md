# Feature Specification: Historial clínico por placa (007)

**Feature Branch**: `feat/007-historial-placa` (base `main`)  
**Created**: 2026-10-27  
**Status**: Draft (modo ligero; pendiente de aprobación humana)  
**Input**: "Módulo de historial por placa: consolidación de todo el historial clínico y operativo de un vehículo en el taller (check-ins 360°, presupuestos, órdenes de trabajo y transferencias de propietario). Resumen con métricas de odómetro, visitas y gasto acumulado, línea de tiempo cronológica filtrable por tipo de evento y vista amigable para imprimir/compartir con el cliente. Multi-tenant estricto."

## Actores

- **Asesor de servicio** y **administrador del taller** (roles autenticados de la 002). Ambos consultan el historial clínico completo de cualquier vehículo de su taller, filtran eventos y acceden a los detalles de cada visita.

## User Scenarios & Testing

### User Story 1 - Consulta consolidada del historial clínico (Timeline) (Priority: P1)

El asesor o administrador busca un vehículo por su placa o accede desde su ficha técnica para revisar la línea de tiempo unificada de todas las visitas, diagnósticos, presupuestos y trabajos realizados a lo largo de su vida en el taller.

**Why this priority**: Es la propuesta de valor central del taller automotriz (RF-05): conocer el pasado técnico del vehículo para diagnosticar mejor, sustentar garantías y brindar transparencia al cliente.

**Independent Test**: Registrar un vehículo con check-in, presupuesto aprobado, OT entregada y transferencia de propietario en el taller A. Consultar el historial y comprobar que todos los eventos aparecen ordenados cronológicamente (más reciente primero) con sus metadatos.

**Acceptance Scenarios**:

1. **US1-AC1 (camino feliz - timeline consolidado)**: **Given** un vehículo del taller A con al menos un check-in, un presupuesto, una orden de trabajo y una transferencia de propietario, **When** el usuario consulta su historial, **Then** recibe una lista cronológica unificada ordenada descendentemente por fecha (`occurredAt`), con cada evento tipificado (`checkin`, `budget`, `work_order`, `ownership_transfer`).
2. **US1-AC2 (campos y metadatos de eventos)**: **Given** un evento en la línea de tiempo, **Then** contiene:
   - `checkin`: id, fecha, odómetro registrado, nivel de combustible, conteo de daños observados, conteo de fotos, si incluye inventario, y nombre del autor que lo recibió.
   - `budget`: id, checkinId, fecha, número correlativo, estado (`borrador`, `enviado`, `aprobado`, `rechazado`), subtotal, IVA, total y cantidad de líneas.
   - `work_order`: id, budgetId, checkinId, fecha de creación, número correlativo, estado (`abierta`, `en_proceso`, `terminada`, `entregada`, `cancelada`), técnico responsable asignado, cantidad de ítems, cantidad de notas de avance, y fecha de entrega si ya fue entregada.
   - `ownership_transfer`: id, fecha, propietario anterior (nombre y documento), nuevo propietario (nombre y documento), motivo registrado y usuario que realizó la transferencia.
3. **US1-AC3 (vehículo nuevo o sin intervenciones)**: **Given** un vehículo recién registrado sin check-ins ni órdenes, **When** se consulta su historial, **Then** devuelve una lista de timeline vacía y los datos básicos del vehículo con el odómetro inicial.
4. **US1-AC4 (aislamiento multi-tenant)**: **Given** un vehículo perteneciente al taller B, **When** un usuario del taller A solicita su historial por id o por placa, **Then** recibe respuesta 404 (No encontrado), exactamente igual que con un id inexistente, sin filtrar ningún dato del taller B.

---

### User Story 2 - Resumen clínico y métricas del vehículo (Priority: P1)

El asesor visualiza inmediatamente en la cabecera un resumen ejecutivo del vehículo: odómetro actual calculado, número de visitas, órdenes de trabajo completadas y el total invertido históricamente.

**Why this priority**: Permite al asesor dimensionar en segundos la fidelidad del cliente, el uso del vehículo y el volumen de reparaciones previas sin tener que sumar evento por evento.

**Independent Test**: Consultar las métricas de un vehículo con 2 check-ins (10.000 km y 15.000 km) y 2 OT entregadas (\$150 y \$250); verificar que el odómetro actual reporte 15.000 km y la inversión acumulada \$400.00.

**Acceptance Scenarios**:

1. **US2-AC1 (odómetro actual y kilometraje acumulado)**: **Given** un vehículo con kilometraje inicial y múltiples check-ins, **Then** el odómetro actual (`currentMileage`) es el valor máximo entre el kilometraje inicial y los kilometrajes de sus check-ins; además se informa la variación (`mileageDelta = currentMileage - initialMileage`).
2. **US2-AC2 (conteo de visitas y trabajos)**: **Given** el historial del vehículo, **Then** se reporta `totalCheckins` (número total de check-ins registrados), `totalWorkOrders` (total de OT generadas) y `totalDeliveredWorkOrders` (total de OT finalizadas y entregadas).
3. **US2-AC3 (inversión total acumulada)**: **Given** un vehículo con órdenes de trabajo entregadas, **Then** se reporta `totalInvested` con la suma exacta en `numeric(12,2)` de los presupuestos aprobados de dichas OT entregadas (o \$0.00 si no tiene ninguna entregada).
4. **US2-AC4 (última intervención y propietario actual)**: **Given** el vehículo, **Then** se informa la fecha de la última visita (`lastVisitAt`) y los datos del propietario actual (`displayName`, `documentNumber`, `phone`).

---

### User Story 3 - Visualización web, filtros y vista de impresión (Priority: P2)

El asesor interactúa con la línea de tiempo en el frontend (ordenador o tablet en bahía), filtra por tipo de evento para buscar una reparación específica y puede imprimir una ficha técnica limpia para entregar al cliente.

**Why this priority**: La interfaz táctil y de escritorio debe ser rápida de operar en recepción y permitir entregar al cliente un informe físico de su historial de mantenimiento.

**Acceptance Scenarios**:

1. **US3-AC1 (pantalla de historial y navegación)**: **Given** la ficha de un vehículo (`/vehicles/:id`), **When** el usuario pulsa en la acción "Historial clínico", **Then** navega a `/vehicles/:id/history` mostrando la tarjeta de métricas, el botón de imprimir y la línea de tiempo cronológica con insignias de estado distintivas.
2. **US3-AC2 (filtros rápidos de evento)**: **Given** la lista de eventos, **When** el usuario selecciona un filtro (`Todos`, `Check-ins`, `Presupuestos`, `Órdenes de trabajo`, `Transferencias`), **Then** la lista se filtra instantáneamente en el cliente sin recargar la página.
3. **US3-AC3 (enlaces directos a entidades)**: **Given** cualquier tarjeta de evento en el timeline, **When** el usuario pulsa sobre ella o su enlace, **Then** navega a la vista de detalle correspondiente (`/checkins/:id`, `/budgets/:id` o `/work-orders/:id`).
4. **US3-AC4 (modo impresión limpio)**: **Given** la página de historial clínico, **When** se activa la vista de impresión del navegador (`Ctrl+P` / botón imprimir), **Then** se ocultan barras de navegación, botones de acción y controles interactivos; se imprime un formato con cabecera de taller, datos del vehículo, métricas y el historial en texto claro.
5. **US3-AC5 (manejo de errores y 404)**: **Given** un id de vehículo que no existe o pertenece a otro taller, **When** se intenta acceder a su historial, **Then** se muestra un estado amigable de "Vehículo no encontrado" con botón para volver al buscador principal.

---

## Edge Cases

- **Vehículo sin eventos**: Muestra métricas en cero o basadas en kilometraje inicial, con mensaje claro "Sin historial de visitas registrado aún".
- **Check-in sin presupuesto ni OT**: Aparece el evento de check-in en el timeline sin romper la cadena.
- **OT cancelada**: Aparece en el timeline con estado `cancelada` y su motivo de cancelación visible; no suma al total de inversión acumulada.
- **Presupuesto rechazado**: Aparece en el timeline con estado `rechazado`; no suma al total invertido.
- **Concurrencia**: Como es un módulo de lectura y consolidación, no introduce condiciones de carrera de escritura; las lecturas son consistentes bajo aislamiento de transacción y RLS.

## Requirements

### Functional Requirements

- **FR-001**: El historial clínico se consulta por identificador único del vehículo (`vehicleId`) o resolviendo su placa previamente.
- **FR-002**: Toda lectura aplica Row-Level Security (`current_setting('app.tenant_id')`); ningún taller puede ver eventos ni vehículos de otro taller.
- **FR-003**: El odómetro actual se deriva determinísticamente: $\max(\text{initialMileage}, \max(\text{checkin.mileage}))$.
- **FR-004**: La inversión total acumulada suma únicamente el total con impuestos de los presupuestos aprobados cuyas órdenes de trabajo estén en estado `entregada`.
- **FR-005**: La cronología se ordena descendentemente por fecha (`occurredAt DESC`), resolviendo empates por id.
- **FR-006**: Ninguna ruta de historial modifica datos de la base de datos (módulo de consulta pura, idempotente y de solo lectura).
- **FR-007**: Los roles autorizados son `asesor` y `admin` (la misma política de acceso de taller de la 002).

### Key Entities & Structures

- **VehicleHistorySummary**:
  - `vehicle`: id, placa, marca, modelo, año, color, carrocería, VIN, kilometraje inicial.
  - `owner`: id, nombre, documento, teléfono.
  - `metrics`: kilometraje actual, variación de kilometraje, total de check-ins, total de OT, total de OT entregadas, total invertido, fecha de última visita.
- **VehicleTimelineEvent**:
  - `id`: uuid del evento.
  - `kind`: `'checkin' | 'budget' | 'work_order' | 'ownership_transfer'`.
  - `occurredAt`: timestamptz ISO 8601.
  - `data`: payload tipado según el `kind`.

## Success Criteria

- **SC-001**: Tiempo de respuesta de `GET /api/v1/vehicles/:id/history` inferior a 200 ms (p95) en vehículos con decenas de intervenciones.
- **SC-002**: 100 % de cobertura de pruebas para aislamiento multi-tenant (el taller A nunca ve registros de B).
- **SC-003**: El odómetro e inversión calculada coinciden de forma exacta con la suma de los registros subyacentes.
- **SC-004**: La interfaz es plenamente usable en dispositivos móviles, tablets y formato impreso A4.
