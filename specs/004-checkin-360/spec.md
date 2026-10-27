# Feature Specification: Check-in 360° de recepción del vehículo

**Feature Branch**: `feat/004-checkin-360`
**Created**: 2026-10-26
**Status**: Draft (modo ligero, sin ronda de clarify)
**Input**: "El asesor registra la recepción de un vehículo ya existente: kilometraje, combustible, motivo de ingreso, inventario de objetos y daños marcados en las vistas del vehículo (frente, atrás, izquierda, derecha, arriba) con tipo, nota y foto opcional. Firma el cliente y queda un check-in por ingreso, que usarán presupuestos y OT. Listar y ver los check-ins de un vehículo. Multi-tenant y roles de la 002."

## Actores

- **Asesor** y **administrador del taller** (roles de la 002): ambos registran y consultan check-ins de su taller.
- **Cliente**: firma la recepción en el dispositivo del asesor (no tiene cuenta).

## User Scenarios & Testing

### User Story 1 - Registrar la recepción de un vehículo (Priority: P1)

En la bahía, el asesor busca el vehículo (001), registra kilometraje, nivel de combustible, motivo de ingreso, los objetos que quedan dentro y los daños visibles marcados sobre cada vista, con foto opcional; el cliente firma y el check-in queda guardado como evidencia del estado en que se recibió el vehículo.

**Why this priority**: es la evidencia que protege al taller ante reclamos y el punto de partida de presupuestos y OT.

**Independent Test**: el asesor del taller A crea un check-in completo para un vehículo del taller A y luego lo ve tal cual lo guardó.

**Acceptance Scenarios**:

1. **US1-AC1 (camino feliz)**: **Given** el vehículo `PBA1234` del taller A, **When** el asesor registra kilometraje 85 000, combustible 1/2, motivo "ruido al frenar", inventario ["gata", "llanta de emergencia"], un daño `rayón` en la vista `izquierda` con nota y foto, y la firma del cliente, **Then** se crea un check-in del taller A con número correlativo, fecha y hora, el asesor como autor y el propietario vigente del vehículo, y el detalle muestra exactamente esos datos.
2. **US1-AC2 (validaciones)**: **Given** el formulario de check-in, **When** falta la firma, el motivo o el kilometraje, el kilometraje es negativo, el combustible no es uno de los niveles permitidos, o un daño tiene una vista o un tipo fuera de las listas, **Then** no se crea nada y se indica cada campo con error.
3. **US1-AC3 (kilometraje menor)**: **Given** el último check-in del vehículo registró 85 000 km, **When** se registra uno nuevo con 80 000 km, **Then** se rechaza indicando el último kilometraje registrado.
4. **US1-AC4 (foto inválida)**: **Given** un daño con una foto que no es JPEG/PNG o supera 1 MB, **When** se guarda, **Then** se rechaza el check-in completo con un error en esa foto.
5. **US1-AC5 (aislamiento)**: **Given** un asesor del taller A, **When** intenta crear un check-in para un vehículo del taller B, **Then** recibe "no encontrado", igual que con un vehículo inexistente, y no se crea nada en ningún taller.

### User Story 2 - Consultar los check-ins de un vehículo (Priority: P2)

El asesor ve la lista de recepciones de un vehículo (más reciente primero) y abre cualquiera para ver sus datos, daños, fotos y firma.

**Why this priority**: permite resolver reclamos y comparar el estado del vehículo entre ingresos.

**Independent Test**: con dos check-ins del vehículo, la lista muestra ambos ordenados y el detalle de cada uno coincide con lo registrado.

**Acceptance Scenarios**:

1. **US2-AC1 (lista y detalle)**: **Given** el vehículo con dos check-ins, **When** el asesor abre su historial, **Then** ve ambos, del más reciente al más antiguo, con número, fecha, kilometraje, motivo, autor y cantidad de daños; al abrir uno ve todos sus datos, las fotos y la firma.
2. **US2-AC2 (aislamiento)**: **Given** check-ins del taller B, **When** un usuario del taller A pide la lista de un vehículo de B o el detalle o una foto de un check-in de B, **Then** recibe "no encontrado"; la lista de un vehículo de A nunca incluye check-ins de B.
3. **US2-AC3 (inmutable)**: **Given** un check-in guardado, **When** cualquier usuario intenta modificarlo o borrarlo, **Then** no existe forma de hacerlo; un error en la recepción se corrige registrando un check-in nuevo.

### Edge Cases

- Vehículo sin check-ins previos: no se valida kilometraje mínimo; el historial muestra un estado vacío.
- Check-in sin daños o sin inventario: válido (listas vacías).
- Sesión expirada o rol no permitido: se aplica lo definido en la 002.

## Requirements

### Functional Requirements

- **FR-001**: Un check-in pertenece a un taller y a un vehículo del mismo taller, y guarda el propietario vigente del vehículo en ese momento.
- **FR-002**: Datos obligatorios: kilometraje (entero ≥ 0), combustible (`vacio`, `1/4`, `1/2`, `3/4`, `lleno`), motivo (1 a 1000 caracteres) y firma del cliente. Inventario: lista de hasta 30 objetos de texto (hasta 100 caracteres cada uno).
- **FR-003**: Cada daño tiene vista (`frente`, `atras`, `izquierda`, `derecha`, `arriba`), tipo (`rayon`, `golpe`, `abolladura`, `rotura`, `faltante`, `otro`), nota opcional (hasta 500 caracteres) y una foto opcional (JPEG o PNG, máximo 1 MB). Máximo 20 daños por check-in.
- **FR-004**: El kilometraje no puede ser menor que el del último check-in del mismo vehículo.
- **FR-005**: Número correlativo por taller, fecha y hora del servidor y autor (usuario de la sesión).
- **FR-006**: El check-in se guarda completo o no se guarda (incluidas fotos y firma).
- **FR-007**: Un check-in no se modifica ni se borra.
- **FR-008**: Taller y autor salen siempre de la sesión; nadie ve ni crea check-ins de otro taller.
- **FR-009**: Asesor y administrador tienen los mismos permisos sobre check-ins.

### Key Entities

- **Check-in**: recepción de un vehículo: número, fecha, autor, vehículo, propietario vigente, kilometraje, combustible, motivo, inventario y firma.
- **Daño**: marca sobre una vista del vehículo con tipo, nota y foto opcional.

## Success Criteria

- **SC-001**: Un asesor registra un check-in con 3 daños en menos de 5 minutos desde un teléfono o tablet.
- **SC-002**: El 100 % de las pruebas de aislamiento entre talleres pasa.
- **SC-003**: Cada check-in guardado se puede consultar después con sus fotos y su firma idénticos a lo registrado.

## Assumptions

- Un "ingreso" = un check-in; no se impide registrar dos el mismo día (no hay aún OT para cerrar ingresos). Presupuestos y OT los referenciarán en features futuras.
- Solo vehículos existentes (001); el alta de vehículo nuevo se hace antes con la 001.
- La firma es una imagen capturada a mano en pantalla; no tiene valor de firma electrónica legal.
- Crear un check-in no está en la lista de eventos auditables de la constitución (IV) y el check-in es inmutable y guarda su autor; por eso no se escribe en `audit_log`. No se agrega auditoría.
- Fuera de alcance: edición, anulación, PDF o envío al cliente, firma del asesor, fotos generales del vehículo, varias fotos por daño, modo sin conexión.
