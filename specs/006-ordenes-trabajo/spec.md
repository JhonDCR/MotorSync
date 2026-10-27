# Feature Specification: Órdenes de trabajo (OT)

**Feature Branch**: `feat/006-ordenes-trabajo` (sale de `feat/005-presupuestos-main`)
**Created**: 2026-10-27
**Status**: Draft (modo ligero, sin ronda de clarify; supuestos al final)
**Input**: "Una OT se crea a partir de un presupuesto aprobado y copia sus líneas como ítems. El administrador asigna un responsable o la deja al asesor. Estados abierta → en proceso → terminada → entregada, con fecha y autor en cada cambio; se cancela solo antes de terminarse. Notas de avance opcionales. Tablero del taller filtrable por estado, detalle y OT por vehículo. Multi-tenant y auditoría."

## Actores

- **Asesor** y **administrador del taller** (roles de la 002). Ambos crean OT, cambian su estado y agregan notas; solo el administrador reasigna el responsable.

## User Scenarios & Testing

### User Story 1 - Abrir una OT desde un presupuesto aprobado (Priority: P1)

El asesor convierte el presupuesto aprobado en una OT con los mismos ítems; el administrador puede asignarla a otro usuario del taller.

**Why this priority**: es lo que pone el trabajo en marcha en el taller.

**Independent Test**: aprobar un presupuesto de 2 líneas en el taller A, crear la OT y verificar ítems, número y responsable.

**Acceptance Scenarios**:

1. **US1-AC1 (camino feliz)**: **Given** un presupuesto `aprobado` del taller A con 2 líneas, **When** el asesor crea la OT, **Then** queda `abierta` con número correlativo del taller, el mismo check-in y vehículo, 2 ítems con tipo, descripción y cantidad copiados en el mismo orden, el asesor como autor y responsable, y un primer registro de historial (`abierta`, autor, fecha).
2. **US1-AC2 (reglas de creación)**: **Given** un presupuesto que no está `aprobado`, o que ya tiene una OT, o cuyo check-in ya tiene una OT activa (no `entregada` ni `cancelada`), **When** se intenta crear la OT, **Then** se rechaza con un conflicto que indica el motivo y no se crea nada.
3. **US1-AC3 (asignación)**: **Given** una OT `abierta` o `en_proceso`, **When** el administrador asigna como responsable a un usuario activo de su taller, **Then** el responsable cambia; si lo intenta un asesor, o el usuario es de otro taller o está inactivo, se rechaza y nada cambia.
4. **US1-AC4 (aislamiento)**: **Given** un usuario del taller A, **When** crea una OT con un presupuesto del taller B, o lee, cambia o anota una OT de B, **Then** recibe "no encontrado", igual que con un id inexistente, y nada cambia en B.

### User Story 2 - Avanzar, cancelar y anotar la OT (Priority: P1)

El asesor mueve la OT por sus estados, deja notas de avance y la cancela si el cliente desiste antes de terminarla.

**Independent Test**: abierta → en_proceso → terminada → entregada con historial completo y auditoría de cada cambio.

**Acceptance Scenarios**:

1. **US2-AC1 (flujo y auditoría)**: **Given** una OT `abierta`, **When** el asesor la pasa a `en_proceso`, `terminada` y `entregada`, **Then** cada cambio queda en el historial de la OT con estado, autor y fecha, y en la auditoría con el estado antes y después, en la misma operación.
2. **US2-AC2 (cancelación)**: **Given** una OT `abierta` o `en_proceso`, **When** se cancela con un motivo (1 a 500 caracteres), **Then** queda `cancelada` con el motivo en el historial y en la auditoría; sin motivo se rechaza.
3. **US2-AC3 (transiciones inválidas)**: **Given** una OT, **When** se salta un estado (abierta → terminada), se retrocede, o se cancela una `terminada`, `entregada` o `cancelada`, **Then** se rechaza indicando el estado actual y nada cambia.
4. **US2-AC4 (notas)**: **Given** una OT no `cancelada` ni `entregada`, **When** el asesor agrega una nota (1 a 1000 caracteres), **Then** aparece en el detalle con autor y fecha; las notas no se editan ni se borran.

### User Story 3 - Tablero y consultas (Priority: P2)

El taller ve sus OT filtradas por estado y abre el detalle; el vehículo muestra sus OT (base del historial por placa).

**Acceptance Scenarios**:

1. **US3-AC1 (tablero, detalle y por vehículo)**: **Given** OT del taller A en distintos estados, **When** se filtra por `en_proceso`, **Then** solo aparecen esas, más reciente primero, con número, placa, responsable y estado; el detalle muestra ítems, historial y notas; la lista del vehículo muestra todas sus OT.
2. **US3-AC2 (aislamiento)**: **Given** OT del taller B, **When** un usuario de A abre el tablero o la lista de un vehículo de B, **Then** el tablero no incluye OT de B y la lista del vehículo de B responde "no encontrado".

### Edge Cases

- Sin OT o sin resultados para el filtro: lista vacía.
- Dos usuarios crean la OT del mismo presupuesto a la vez: solo una se crea; la otra recibe conflicto.
- Cambio de estado concurrente: el segundo recibe conflicto con el estado actual.
- Sesión expirada o rol no permitido: lo definido en la 002.

## Requirements

### Functional Requirements

- **FR-001**: Una OT pertenece a un taller y a un presupuesto `aprobado` del mismo taller; hereda su check-in y vehículo.
- **FR-002**: Máximo una OT por presupuesto y una OT activa (no `entregada` ni `cancelada`) por check-in.
- **FR-003**: Los ítems son una copia de las líneas del presupuesto (tipo, descripción, cantidad, orden) al crear la OT; no se editan. Sin precios: el monto vive en el presupuesto.
- **FR-004**: Estados: `abierta` → `en_proceso` → `terminada` → `entregada`; `cancelada` solo desde `abierta` o `en_proceso`, con motivo obligatorio. `entregada` y `cancelada` son finales.
- **FR-005**: Cada cambio de estado (incluida la creación) guarda estado, autor y fecha en el historial de la OT.
- **FR-006**: Cada cambio de estado y cada cancelación se registran en la auditoría en la misma operación, con motivo (constitución IV).
- **FR-007**: Responsable: por defecto quien crea; solo el administrador lo cambia, a un usuario activo del taller, mientras la OT esté `abierta` o `en_proceso`.
- **FR-008**: Número correlativo por taller; autor, fechas y taller salen de la sesión y del servidor.
- **FR-009**: Nadie ve, crea ni modifica OT de otro taller.

### Key Entities

- **Orden de trabajo**: número, presupuesto, check-in, vehículo, estado, responsable, autor, fechas.
- **Ítem de OT**: tipo, descripción, cantidad, orden.
- **Cambio de estado**: estado nuevo, autor, fecha, motivo (si cancela).
- **Nota de avance**: texto, autor, fecha.

## Success Criteria

- **SC-001**: Crear la OT desde un presupuesto aprobado toma un clic y menos de 10 segundos.
- **SC-002**: El 100 % de los cambios de estado tiene historial y registro de auditoría.
- **SC-003**: El 100 % de las pruebas de aislamiento entre talleres pasa.

## Assumptions

- No existe rol "técnico" en la 002 (solo `asesor` y `admin`). El responsable es un usuario del taller con esos roles; crear el rol técnico queda fuera de alcance.
- Los ítems no se marcan como hechos uno a uno; el avance se expresa con estado y notas.
- "Entregada" solo cambia el estado: sin firma de entrega, factura ni cobro.
- No se borran OT; se cancelan.
- Fuera de alcance: inventario (descontar repuestos), tiempos por técnico, adjuntos en notas, vista Kanban con arrastrar.
