# Feature Specification: Presupuestos de un check-in

**Feature Branch**: `feat/005-presupuestos` (sale de `feat/004-checkin-360`)
**Created**: 2026-10-26
**Status**: Draft (modo ligero, sin ronda de clarify)
**Input**: "El asesor crea un presupuesto para un check-in con líneas de mano de obra y repuestos (descripción, cantidad, precio unitario), con subtotal, IVA y total. Estados borrador → enviado → aprobado/rechazado por el cliente (lo registra el asesor); solo el borrador se edita. Listar y ver presupuestos de un vehículo y de un check-in. Sin PDF ni correo. Multi-tenant y roles como en la 004."

## Actores

- **Asesor** y **administrador del taller** (roles de la 002): mismos permisos sobre presupuestos.
- **Cliente**: decide aprobar o rechazar fuera del sistema; el asesor registra su decisión.

## User Scenarios & Testing

### User Story 1 - Armar un presupuesto en borrador (Priority: P1)

Tras el check-in, el asesor crea un presupuesto con líneas de mano de obra y de repuestos y ve el subtotal, el IVA y el total calculados.

**Why this priority**: sin presupuesto no hay aprobación del cliente ni OT.

**Independent Test**: crear un presupuesto con dos líneas para un check-in del taller A y verificar los montos.

**Acceptance Scenarios**:

1. **US1-AC1 (camino feliz)**: **Given** un check-in del taller A, **When** el asesor crea un presupuesto con "Cambio de pastillas" (mano de obra, 1 × 25,00) y "Pastillas delanteras" (repuesto, 2 × 18,50), **Then** queda en `borrador` con número correlativo del taller, autor, fecha, subtotal 62,00, IVA 15 % de 9,30 y total 71,30, exactos al centavo.
2. **US1-AC2 (edición del borrador)**: **Given** un presupuesto en `borrador`, **When** el asesor reemplaza sus líneas, **Then** se guardan las nuevas líneas y los montos se recalculan.
3. **US1-AC3 (validaciones)**: **Given** el formulario, **When** no hay líneas, una línea no tiene descripción, la cantidad es ≤ 0, el precio es negativo, tiene más de 2 decimales o el tipo no es `mano_obra` ni `repuesto`, **Then** no se guarda nada y se indica el campo con error.
4. **US1-AC4 (aislamiento)**: **Given** un asesor del taller A, **When** crea un presupuesto para un check-in del taller B, o lee o edita un presupuesto de B, **Then** recibe "no encontrado", igual que con un id inexistente, y nada cambia en B.

### User Story 2 - Enviar y registrar la decisión del cliente (Priority: P1)

El asesor marca el presupuesto como enviado y luego registra si el cliente lo aprobó o lo rechazó.

**Why this priority**: el presupuesto aprobado es la base de la OT (siguiente feature).

**Independent Test**: borrador → enviado → aprobado; el presupuesto ya no se puede editar y la decisión queda auditada.

**Acceptance Scenarios**:

1. **US2-AC1 (flujo y auditoría)**: **Given** un borrador, **When** el asesor lo envía y luego registra "aprobado" (o "rechazado"), **Then** el estado cambia en ese orden, se guarda quién y cuándo decidió, y la aprobación o el rechazo queda en la auditoría con el estado antes y después.
2. **US2-AC2 (transiciones inválidas)**: **Given** un presupuesto `enviado`, `aprobado` o `rechazado`, **When** se intenta editar sus líneas, o se intenta aprobar un borrador o cambiar la decisión de uno ya decidido, **Then** se rechaza indicando el estado actual y nada cambia.

### User Story 3 - Consultar presupuestos (Priority: P2)

El asesor ve los presupuestos de un check-in y de un vehículo (más reciente primero) y abre cualquiera con sus líneas y montos.

**Acceptance Scenarios**:

1. **US3-AC1 (lista y detalle)**: **Given** un vehículo con dos presupuestos en distintos check-ins, **When** el asesor abre la lista del vehículo, **Then** ve ambos del más reciente al más antiguo con número, fecha, estado y total; la lista del check-in solo muestra el suyo; el detalle muestra líneas y montos.
2. **US3-AC2 (aislamiento)**: **Given** presupuestos del taller B, **When** un usuario de A pide la lista de un vehículo o check-in de B, **Then** recibe "no encontrado"; las listas de A nunca incluyen presupuestos de B.

### Edge Cases

- Check-in o vehículo sin presupuestos: lista vacía.
- Un check-in puede tener varios presupuestos (por ejemplo, uno rechazado y otro nuevo).
- Sesión expirada o rol no permitido: lo definido en la 002.

## Requirements

### Functional Requirements

- **FR-001**: Un presupuesto pertenece a un taller y a un check-in del mismo taller (y por él, a su vehículo).
- **FR-002**: Línea: tipo (`mano_obra`, `repuesto`), descripción (1 a 200 caracteres), cantidad (> 0, hasta 2 decimales), precio unitario (≥ 0, hasta 2 decimales). Entre 1 y 50 líneas.
- **FR-003**: Total de línea = cantidad × precio, redondeado a 2 decimales; subtotal = suma de líneas; IVA = subtotal × tasa, redondeado a 2 decimales (mitad hacia arriba); total = subtotal + IVA. Montos exactos en decimal, nunca en coma flotante.
- **FR-004**: La tasa de IVA es 15 % y se guarda en cada presupuesto al crearlo, para que un cambio futuro de tasa no altere presupuestos existentes.
- **FR-005**: Estados: `borrador` → `enviado` → `aprobado` | `rechazado`. Solo el `borrador` se edita; `aprobado` y `rechazado` son finales.
- **FR-006**: Número correlativo por taller; autor, fechas y taller salen de la sesión y del servidor.
- **FR-007**: Aprobar o rechazar se registra en la auditoría en la misma operación (constitución IV).
- **FR-008**: Nadie ve, crea ni modifica presupuestos de otro taller.

### Key Entities

- **Presupuesto**: número, check-in, vehículo, estado, tasa de IVA, subtotal, IVA, total, autor, fechas de creación, envío y decisión.
- **Línea de presupuesto**: tipo, descripción, cantidad, precio unitario, total de línea.

## Success Criteria

- **SC-001**: Un asesor arma un presupuesto de 5 líneas en menos de 3 minutos.
- **SC-002**: El 100 % de los montos calculados coincide al centavo con el cálculo manual.
- **SC-003**: El 100 % de las pruebas de aislamiento entre talleres pasa.

## Assumptions

- IVA fijo de 15 % (Ecuador) como constante; no hay pantalla para configurarlo por taller. Se guarda por presupuesto (FR-004) para poder hacerlo configurable después sin migrar datos.
- No se eliminan presupuestos; un borrador que no sirve se deja o se envía y se marca rechazado.
- "Enviado" solo cambia el estado: no hay PDF ni correo.
- Descripción libre; sin inventario ni catálogo de repuestos ni descuentos.
- Moneda única (USD), sin símbolo configurable.
- Fuera de alcance: OT, PDF, envío, firma del cliente sobre el presupuesto, edición tras enviar (se crea otro presupuesto).
