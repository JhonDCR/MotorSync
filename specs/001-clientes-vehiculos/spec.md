# Feature Specification: Registro de clientes y vehículos con búsqueda por placa

**Feature Branch**: `feat/001-clientes-vehiculos`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "Registro de clientes y vehículos con búsqueda inmediata por placa, como base de todo el flujo del taller (check-in, presupuesto, OT). Corte vertical simplificado del RF-05 'Historial clínico por placa': en esta feature solo se registra y se busca; el historial de reparaciones vendrá después. Actores: asesor de servicio / recepcionista (usuario principal) y administrador del taller. US1 buscar vehículo por placa (también parcial); US2 registrar cliente (persona natural o empresa, cédula/RUC/pasaporte de Ecuador, nombre, teléfono, correo); US3 registrar vehículo asociado a un cliente (placa, marca, modelo, año, color, VIN opcional, carrocería, kilometraje inicial); US4 buscar clientes por documento o nombre, ver sus vehículos y editar datos. Restricciones: placa única por taller normalizada, documento único por taller, VIN de 17 caracteres y único por taller si se informa, aislamiento total entre talleres, búsqueda por placa/documento/VIN en menos de 200 ms, UI usable en tablet/teléfono, un vehículo pertenece a un cliente a la vez y el cambio de propietario queda registrado. Fuera de alcance: check-in/inspección 360°, historial de reparaciones, autenticación completa, importación masiva."

## Contexto y alcance

Esta feature es la base de datos maestra del taller: sin clientes y vehículos registrados no hay check-in, presupuesto ni orden de trabajo. Es un corte vertical simplificado del RF-05 "Historial clínico por placa": aquí solo se **registra, busca y edita**; el historial de reparaciones queda para una feature posterior.

**Actores**

- **Asesor de servicio / recepcionista** (usuario principal): atiende al cliente en la recepción, normalmente desde una tablet o un teléfono.
- **Administrador del taller**: tiene las mismas capacidades que el asesor. La única diferencia es que puede transferir un vehículo de propietario y cambiar placa, VIN o documento sin informar un motivo, que para el asesor es obligatorio (FR-019).

**Fuera de alcance**: check-in e inspección 360°, historial de reparaciones, autenticación y gestión de usuarios (se asume un usuario ya autenticado y asociado a un único taller), importación masiva de clientes o vehículos, y cualquier operación de eliminación o desactivación de clientes o vehículos (FR-021).

## Clarifications

### Session 2026-10-21
- Q: Si el administrador informa un motivo, ¿aplica también el largo de 10 a 500 caracteres? → A: Sí, la misma regla que para el asesor; solo cambia que para el administrador el motivo es opcional.

- Q: ¿Qué formato de placa se acepta? (FR-007) → A: Solo el formato oficial ecuatoriano: autos con 3 letras + 3 o 4 dígitos; motos con 2 letras + 3 dígitos + 1 letra. El formato de moto se exige cuando la carrocería es "moto" y el de auto para el resto. Cualquier otro formato se rechaza con un mensaje claro. La normalización no cambia (mayúsculas, sin espacios ni guiones).
- Q: ¿Quién puede transferir un vehículo de propietario y cambiar placa, VIN o documento? (FR-019) → A: Asesor y administrador. El asesor debe informar un motivo obligatorio, que queda en la auditoría; para el administrador el motivo es opcional y, si lo da, también se audita.
- Q: ¿Cómo se eliminan clientes y vehículos? (FR-021) → A: Fuera de alcance en esta feature: no existe ninguna operación de borrado ni de desactivación.
- Q: ¿El correo del cliente es obligatorio? (FR-006, FR-010) → A: Opcional para todos los clientes (personas naturales y empresas); si se informa, se valida el formato.
- Q: ¿La búsqueda por VIN acepta fragmentos? (FR-001) → A: No, solo el VIN completo de 17 caracteres.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Buscar vehículo por placa (Priority: P1)

El asesor digita la placa (completa o parcial) del vehículo que llega a la recepción y ve al instante los datos del vehículo y de su propietario actual, para atender al cliente sin hacerlo esperar.

**Why this priority**: es la acción más frecuente en la recepción y el punto de entrada de todo el flujo del taller (check-in, presupuesto, OT). Sin búsqueda rápida, el registro previo no aporta valor operativo.

**Independent Test**: con clientes y vehículos precargados en dos talleres, un asesor del taller A busca por placa completa, parcial y con formato "sucio" (minúsculas, guiones, espacios) y obtiene solo resultados de su taller, con los datos del vehículo y del propietario.

**Acceptance Scenarios**:

1. **US1-AC1**: **Given** el taller tiene registrado el vehículo de placa `PBA1234`, **When** el asesor busca `PBA1234`, **Then** el sistema muestra ese vehículo como primer resultado, con placa, marca, modelo, año, color, tipo de carrocería, kilometraje y nombre, documento, teléfono y correo del propietario actual.
2. **US1-AC2**: **Given** el vehículo `PBA1234` está registrado, **When** el asesor busca `pba-1234`, `PBA 1234` o ` pba1234 `, **Then** el sistema normaliza la entrada (mayúsculas, sin espacios ni guiones) y muestra el mismo vehículo que en US1-AC1.
3. **US1-AC3**: **Given** el taller tiene los vehículos `PBA1234`, `PBA1299` y `GYE0123`, **When** el asesor busca el fragmento `BA12`, **Then** el sistema muestra `PBA1234` y `PBA1299` y no muestra `GYE0123`.
4. **US1-AC4**: **Given** hay varias coincidencias para un fragmento, **When** se muestran los resultados, **Then** aparecen primero la coincidencia exacta, luego las que empiezan por el fragmento y al final las que lo contienen, con un máximo de 20 resultados e indicación de que hay más si se supera ese límite.
5. **US1-AC5**: **Given** el asesor escribió menos de 2 caracteres válidos, **When** intenta buscar, **Then** el sistema no ejecuta la búsqueda y le indica que escriba al menos 2 caracteres.
6. **US1-AC6**: **Given** no existe ningún vehículo con esa placa en el taller, **When** el asesor busca una placa completa, **Then** el sistema indica "No se encontró ningún vehículo" y ofrece la acción de registrar un vehículo nuevo con la placa ya precargada (normalizada).
7. **US1-AC7**: **Given** el vehículo tiene VIN registrado, **When** el asesor busca por el VIN completo de 17 caracteres, **Then** el sistema muestra ese vehículo y su propietario.
8. **US1-AC8 (multi-tenant)**: **Given** la placa `PBA1234` está registrada solo en el taller B, **When** un asesor del taller A busca `PBA1234` o el fragmento `BA12`, **Then** el sistema responde "No se encontró ningún vehículo", exactamente igual que si la placa no existiera en ningún taller.
9. **US1-AC9 (multi-tenant)**: **Given** un vehículo pertenece al taller B, **When** un usuario del taller A intenta abrir su ficha usando su identificador directo, **Then** el sistema responde "no encontrado" (no "acceso denegado") y no revela ningún dato del vehículo ni de su propietario.
10. **US1-AC10 (rendimiento)**: **Given** un taller con el volumen de referencia (ver SC-001), **When** se buscan placas, documentos o VIN, **Then** el 95 % de las búsquedas devuelve resultados en menos de 200 ms medidos en el servidor.

---

### User Story 2 - Registrar cliente (Priority: P1)

El asesor registra un cliente nuevo, persona natural o empresa, con su documento de identidad ecuatoriano (cédula, RUC o pasaporte), nombre, teléfono y correo, para tener sus datos de contacto y facturación.

**Why this priority**: un vehículo siempre pertenece a un cliente; sin clientes no se pueden registrar vehículos (US3).

**Independent Test**: el asesor registra una persona natural con cédula, una empresa con RUC y un extranjero con pasaporte; intenta registrar documentos inválidos y duplicados y recibe los errores esperados; un taller distinto puede registrar el mismo documento.

**Acceptance Scenarios**:

1. **US2-AC1**: **Given** el asesor está en el formulario de nuevo cliente, **When** registra una persona natural con tipo de documento cédula, número de cédula válido, nombres, apellidos y teléfono, **Then** el cliente queda registrado en su taller y el sistema muestra su ficha.
2. **US2-AC2**: **Given** el asesor registra una empresa, **When** informa RUC válido, razón social y teléfono, **Then** el cliente queda registrado como empresa. El sistema no permite registrar una empresa con tipo de documento cédula o pasaporte.
3. **US2-AC3**: **Given** el asesor registra una persona natural extranjera, **When** informa tipo pasaporte con un número alfanumérico de 5 a 20 caracteres, **Then** el cliente queda registrado sin validación de dígito verificador.
4. **US2-AC4**: **Given** el asesor informa una cédula que no tiene 10 dígitos o cuyo dígito verificador no es válido, **When** intenta guardar, **Then** el sistema rechaza el registro e indica "Cédula inválida" junto al campo.
5. **US2-AC5**: **Given** el asesor informa un RUC que no tiene 13 dígitos, no termina en `001` o no supera la validación de su tipo, **When** intenta guardar, **Then** el sistema rechaza el registro e indica "RUC inválido" junto al campo.
6. **US2-AC6**: **Given** ya existe en el taller un cliente con el documento `1712345675`, **When** el asesor intenta registrar otro cliente con ese documento (con o sin espacios o guiones), **Then** el sistema rechaza el registro, indica que el documento ya está registrado y ofrece abrir la ficha del cliente existente.
7. **US2-AC7**: **Given** el asesor informa un correo con formato inválido o un teléfono con menos de 7 o más de 15 dígitos, **When** intenta guardar, **Then** el sistema rechaza el registro e indica el campo con error.
8. **US2-AC8**: **Given** faltan campos obligatorios (tipo de cliente, tipo y número de documento, nombre o razón social, teléfono), **When** el asesor intenta guardar, **Then** el sistema no guarda y marca cada campo faltante.
9. **US2-AC9 (multi-tenant)**: **Given** el documento `1712345675` ya está registrado en el taller B, **When** un asesor del taller A registra un cliente con ese documento, **Then** el registro se guarda en el taller A sin error y sin revelar que el documento existe en otro taller.
10. **US2-AC10 (multi-tenant)**: **Given** un asesor del taller A registra un cliente, **When** un usuario del taller B busca ese documento o nombre, **Then** no obtiene ningún resultado. El taller del cliente lo determina siempre la sesión del usuario, nunca un dato enviado en el formulario.

---

### User Story 3 - Registrar vehículo de un cliente (Priority: P1)

El asesor registra un vehículo asociado a un cliente existente, con placa, marca, modelo, año, color, VIN opcional, tipo de carrocería y kilometraje inicial, para tenerlo listo para su ingreso al taller.

**Why this priority**: junto con US1 y US2 forma el mínimo viable: sin vehículos registrados la búsqueda por placa no devuelve nada.

**Independent Test**: con un cliente ya registrado, el asesor registra un vehículo con y sin VIN, comprueba que la placa se guarda normalizada, que los duplicados (placa o VIN) se rechazan dentro del taller y que otro taller puede registrar la misma placa.

**Acceptance Scenarios**:

1. **US3-AC1**: **Given** existe el cliente "Ana Pérez" en el taller, **When** el asesor registra un vehículo para ella con placa, marca, modelo, año, color, tipo de carrocería y kilometraje inicial, **Then** el vehículo queda registrado con Ana Pérez como propietaria actual y aparece al buscar su placa (US1).
2. **US3-AC2**: **Given** el asesor escribe la placa `pba-1234`, **When** guarda el vehículo, **Then** la placa queda registrada y se muestra como `PBA1234`.
3. **US3-AC3**: **Given** ya existe en el taller un vehículo con placa `PBA1234`, **When** el asesor intenta registrar otro con `PBA-1234` o `pba 1234`, **Then** el sistema rechaza el registro, indica que la placa ya está registrada y ofrece abrir la ficha del vehículo existente.
4. **US3-AC4**: **Given** el asesor informa un VIN, **When** este no tiene exactamente 17 caracteres alfanuméricos o contiene las letras I, O o Q, **Then** el sistema rechaza el registro e indica "VIN inválido". El VIN se guarda en mayúsculas sin espacios ni guiones.
5. **US3-AC5**: **Given** ya existe en el taller un vehículo con el VIN `1HGCM82633A004352`, **When** el asesor registra otro vehículo con ese VIN, **Then** el sistema rechaza el registro e indica que el VIN ya está registrado.
6. **US3-AC6**: **Given** el asesor no informa VIN, **When** guarda el vehículo, **Then** el registro se acepta, y varios vehículos sin VIN pueden coexistir en el taller.
7. **US3-AC7**: **Given** el asesor informa un año anterior a 1950 o posterior al año en curso más uno, o un kilometraje negativo, no entero o mayor que 9 999 999, **When** intenta guardar, **Then** el sistema rechaza el registro e indica el campo con error.
8. **US3-AC8**: **Given** el formulario de vehículo, **When** el asesor elige el tipo de carrocería, **Then** solo puede elegir entre sedán, SUV, pickup, moto u otro.
9. **US3-AC9**: **Given** el asesor llegó desde una búsqueda sin resultados (US1-AC6), **When** se abre el formulario de vehículo, **Then** la placa viene precargada y el asesor puede elegir un cliente existente o registrar uno nuevo (US2) sin perder lo ya escrito.
10. **US3-AC10 (multi-tenant)**: **Given** la placa `PBA1234` está registrada en el taller B, **When** un asesor del taller A registra un vehículo con esa placa, **Then** el registro se guarda en el taller A sin error y sin revelar que la placa existe en otro taller.
11. **US3-AC11 (multi-tenant)**: **Given** un cliente pertenece al taller B, **When** un usuario del taller A intenta registrar un vehículo asociado a ese cliente (por ejemplo, enviando su identificador), **Then** el sistema rechaza la operación como "cliente no encontrado" y no crea el vehículo.
12. **US3-AC12 (formato de placa, auto)**: **Given** el asesor registra un vehículo con carrocería sedán, SUV, pickup u otro, **When** la placa normalizada tiene 3 letras seguidas de 3 o 4 dígitos (por ejemplo `PBA123` o `PBA1234`), **Then** la placa se acepta. **When** la placa normalizada no cumple ese formato (por ejemplo `PB1234`, `PBA12`, `PBA12345`, `1234PBA` o `AB123C`), **Then** el sistema rechaza el registro con el mensaje "Placa inválida: para autos use 3 letras y 3 o 4 dígitos (ej. PBA1234)".
13. **US3-AC13 (formato de placa, moto)**: **Given** el asesor registra un vehículo con carrocería moto, **When** la placa normalizada tiene 2 letras, 3 dígitos y 1 letra (por ejemplo `AB123C`), **Then** la placa se acepta. **When** no cumple ese formato (por ejemplo `PBA1234` o `AB1234`), **Then** el sistema rechaza el registro con el mensaje "Placa inválida: para motos use 2 letras, 3 dígitos y 1 letra (ej. AB123C)".
14. **US3-AC14 (formato de placa y carrocería)**: **Given** el formato de placa depende de la carrocería, **When** el asesor cambia la carrocería después de escribir la placa, **Then** el sistema vuelve a validar la placa con el formato de la nueva carrocería antes de guardar. Una placa con caracteres distintos de letras, dígitos, espacios o guiones se rechaza como "Placa inválida" en lugar de limpiarse en silencio.

---

### User Story 4 - Buscar clientes, ver sus vehículos y editar datos (Priority: P2)

El asesor busca clientes por documento o por nombre, ve la lista de vehículos de cada cliente y corrige los datos del cliente o del vehículo cuando cambian, incluido el cambio de propietario de un vehículo.

**Why this priority**: es necesario para mantener la información al día, pero la operación diaria de recepción ya funciona con US1–US3.

**Independent Test**: el asesor busca un cliente por documento y por fragmento de nombre, abre su ficha, ve sus vehículos, edita su teléfono, edita el color de un vehículo y transfiere un vehículo a otro cliente; se verifica el registro de auditoría del cambio de propietario y que nada de esto es posible sobre datos de otro taller.

**Acceptance Scenarios**:

1. **US4-AC1**: **Given** el cliente con documento `1712345675` está registrado, **When** el asesor busca `1712345675` (o `171234567-5`), **Then** el sistema muestra ese cliente como primer resultado.
2. **US4-AC2**: **Given** existen los clientes "José Andrés Núñez" y "Maria Nunez", **When** el asesor busca `nunez`, **Then** el sistema muestra ambos: la búsqueda por nombre no distingue mayúsculas ni tildes y encuentra el fragmento en cualquier parte del nombre o razón social.
3. **US4-AC3**: **Given** el asesor abre la ficha de un cliente, **When** se carga, **Then** muestra sus datos de contacto y la lista de los vehículos de los que es propietario actual (placa, marca, modelo, año), y desde cada vehículo se puede abrir su ficha.
4. **US4-AC4**: **Given** el asesor edita el teléfono, el correo o el nombre de un cliente con valores válidos, **When** guarda, **Then** los cambios quedan registrados y la ficha muestra quién hizo la última modificación y cuándo.
5. **US4-AC5**: **Given** el asesor edita un cliente o un vehículo, **When** el nuevo documento, placa o VIN ya pertenece a otro registro del taller o es inválido, **Then** el sistema rechaza el cambio con las mismas reglas y mensajes que en el registro (US2-AC4 a US2-AC7, US3-AC3 a US3-AC5, US3-AC7, US3-AC12 a US3-AC14).
6. **US4-AC6**: **Given** el asesor edita marca, modelo, año, color, tipo de carrocería o kilometraje de un vehículo con valores válidos, **When** guarda, **Then** los cambios quedan registrados.
7. **US4-AC7 (cambio de propietario)**: **Given** el vehículo `PBA1234` pertenece a "Ana Pérez", **When** un asesor lo transfiere a "Carlos Ruiz", cliente del mismo taller, informa un motivo válido (FR-019) y confirma la acción, **Then** el vehículo pasa a tener a Carlos Ruiz como único propietario actual, deja de aparecer en la ficha de Ana Pérez y aparece en la de Carlos Ruiz.
8. **US4-AC8 (auditoría)**: **Given** se completó el cambio de propietario de US4-AC7, **When** se consulta el registro de auditoría, **Then** existe exactamente un registro con el taller, el usuario que lo hizo, la acción "cambio de propietario", el vehículo, el propietario anterior y el nuevo, el motivo informado, la fecha y hora en UTC y el canal o IP de origen.
9. **US4-AC9 (auditoría)**: **Given** el cambio de propietario falla por cualquier motivo (por ejemplo, el cliente destino no existe), **When** termina la operación, **Then** ni el propietario del vehículo cambia ni se crea registro de auditoría: ambos ocurren juntos o no ocurre ninguno.
10. **US4-AC10 (auditoría)**: **Given** un vehículo cambió de propietario una o más veces, **When** el asesor abre su ficha, **Then** ve el historial de propietarios (propietario anterior, nuevo, fecha, usuario que lo hizo y motivo, si existe), del más reciente al más antiguo. Ningún usuario puede editar ni borrar ese historial.
11. **US4-AC11 (auditoría)**: **Given** un usuario modifica la placa o el VIN de un vehículo, o el documento de un cliente, cumpliendo FR-019, **When** guarda, **Then** se crea un registro de auditoría con los valores anterior y nuevo, el usuario, el motivo (si se informó), la fecha y hora en UTC y el canal o IP. La edición de campos no identificadores (por ejemplo teléfono o color) no pide motivo.
12. **US4-AC12 (concurrencia)**: **Given** dos usuarios abrieron la misma ficha y el primero ya guardó cambios, **When** el segundo intenta guardar sobre la versión antigua, **Then** el sistema rechaza el guardado, le avisa que el registro cambió y le muestra los datos actuales para que repita su edición.
13. **US4-AC13 (multi-tenant)**: **Given** un cliente o vehículo pertenece al taller B, **When** un usuario del taller A intenta editarlo, transferirlo o transferir un vehículo propio a un cliente del taller B, **Then** el sistema responde "no encontrado", no modifica nada y no crea registros de auditoría en ninguno de los dos talleres.
14. **US4-AC14 (multi-tenant)**: **Given** el taller A y el taller B tienen registros de auditoría, **When** un usuario del taller A consulta el historial de propietarios de sus vehículos, **Then** solo ve registros de su taller.
15. **US4-AC15 (motivo obligatorio para el asesor)**: **Given** un usuario con rol asesor, **When** intenta transferir un vehículo o cambiar la placa, el VIN o el documento sin motivo, o con un motivo de menos de 10 o más de 500 caracteres (sin contar espacios al inicio y al final), **Then** el sistema rechaza la operación indicando "El motivo es obligatorio (entre 10 y 500 caracteres)", no modifica nada y no crea registro de auditoría.
16. **US4-AC16 (motivo opcional para el administrador)**: **Given** un usuario con rol administrador, **When** transfiere un vehículo o cambia la placa, el VIN o el documento sin motivo, **Then** la operación se completa y el registro de auditoría queda con el motivo vacío. **When** sí informa un motivo de 10 a 500 caracteres, **Then** el motivo queda en el registro de auditoría. **When** informa un motivo de menos de 10 o más de 500 caracteres, **Then** la operación se rechaza con el mismo mensaje que para el asesor y no se crea registro de auditoría.
17. **US4-AC17 (sin eliminación)**: **Given** la ficha de un cliente o de un vehículo, **When** el usuario la consulta o la edita, cualquiera que sea su rol, **Then** no existe ninguna acción para eliminarlo ni desactivarlo, y cualquier intento de borrado por otra vía es rechazado sin modificar datos.

---

### Edge Cases

- **Placa con formato no estándar** (provisional, diplomática, extranjera): se rechaza al registrar o editar (US3-AC12, US3-AC13). El vehículo no puede registrarse hasta tener placa con formato oficial.
- **Cambio de carrocería de moto a otra (o al revés) sin cambiar la placa**: la placa se valida con el formato de la nueva carrocería; si no lo cumple, el cambio se rechaza (US3-AC14).
- **Búsqueda con caracteres no alfanuméricos** (`PBA*12`, `%`): en la búsqueda se descartan al normalizar (a diferencia del registro, donde se rechazan); si después quedan menos de 2 caracteres aplica US1-AC5. La búsqueda parcial no exige el formato oficial.
- **Registro simultáneo de la misma placa, documento o VIN** por dos asesores del mismo taller: solo uno se guarda y el otro recibe el error de duplicado (US2-AC6, US3-AC3, US3-AC5), nunca quedan dos registros.
- **Transferir un vehículo a su propietario actual**: el sistema lo rechaza con el mensaje "El vehículo ya pertenece a este cliente" y no crea registro de auditoría.
- **Persona natural con cédula y con RUC** (RUC = cédula + `001`): se tratan como documentos distintos; el sistema advierte de un posible duplicado al registrar uno cuando ya existe el otro, pero permite continuar.
- **Cliente sin vehículos**: su ficha muestra "Este cliente no tiene vehículos registrados" y ofrece registrar uno.
- **Nombres con tildes, ñ o diéresis**: se guardan tal como se escriben y se encuentran con o sin tildes (US4-AC2).
- **Conexión inestable en la recepción**: si un guardado falla por red, el formulario conserva lo escrito y el asesor puede reintentar sin crear duplicados.
- **Cliente registrado por error o duplicado con otro documento**: como no hay eliminación (FR-021), se corrige editando sus datos; sus vehículos pueden transferirse al cliente correcto.

## Requirements *(mandatory)*

### Functional Requirements

**Búsqueda**

- **FR-001**: El sistema MUST permitir buscar vehículos por placa completa o parcial (mínimo 2 caracteres tras normalizar) y por VIN completo, devolviendo los datos del vehículo y de su propietario actual.
- **FR-002**: El sistema MUST normalizar placas y VIN en el registro, en la edición y en la búsqueda: mayúsculas, sin espacios ni guiones. En el registro y la edición, cualquier otro carácter no alfanumérico hace que el valor se rechace; en la búsqueda se descarta.
- **FR-003**: El sistema MUST ordenar los resultados por relevancia (coincidencia exacta, luego prefijo, luego contenido) y limitarlos a 20, indicando cuando hay más.
- **FR-004**: El sistema MUST permitir buscar clientes por documento (completo o parcial, normalizado sin espacios ni guiones) y por nombre o razón social (fragmento, sin distinguir mayúsculas ni tildes).
- **FR-005**: Las búsquedas por placa, documento y VIN MUST responder en menos de 200 ms en el 95 % de los casos con el volumen de referencia (SC-001).

**Clientes**

- **FR-006**: El sistema MUST permitir registrar clientes de tipo persona natural (nombres y apellidos; documento cédula, RUC o pasaporte) o empresa (razón social; documento RUC), con teléfono obligatorio y correo opcional.
- **FR-007**: El sistema MUST aceptar solo placas con el formato oficial ecuatoriano, evaluado sobre la placa normalizada: si la carrocería es moto, 2 letras + 3 dígitos + 1 letra; para cualquier otra carrocería, 3 letras + 3 o 4 dígitos. Cualquier otro formato MUST rechazarse con un mensaje que indique el formato esperado según la carrocería.
- **FR-008**: El sistema MUST validar la cédula (10 dígitos, código de provincia válido y dígito verificador) y el RUC (13 dígitos, terminado en `001` y con la validación correspondiente a su tipo: persona natural, sociedad privada o entidad pública). El pasaporte se valida solo como alfanumérico de 5 a 20 caracteres.
- **FR-009**: El sistema MUST garantizar que el número de documento normalizado es único dentro de cada taller.
- **FR-010**: El correo MUST ser opcional para todos los clientes (personas naturales y empresas). El sistema MUST validar su formato estándar cuando se informe y el teléfono (7 a 15 dígitos, con `+` inicial opcional).

**Vehículos**

- **FR-011**: El sistema MUST permitir registrar vehículos asociados a un cliente existente del mismo taller, con placa, marca, modelo, año (1950 a año en curso + 1), color, tipo de carrocería (sedán, SUV, pickup, moto, otro), kilometraje inicial (entero de 0 a 9 999 999) y VIN opcional.
- **FR-012**: El sistema MUST garantizar que la placa normalizada es única dentro de cada taller.
- **FR-013**: El sistema MUST validar el VIN, cuando se informe, como 17 caracteres alfanuméricos sin I, O ni Q, y garantizar que es único dentro de cada taller.
- **FR-014**: Cada vehículo MUST tener exactamente un propietario actual en todo momento.

**Edición y cambio de propietario**

- **FR-015**: El sistema MUST permitir editar los datos de clientes y vehículos aplicando las mismas validaciones y reglas de unicidad que en el registro.
- **FR-016**: El sistema MUST detectar ediciones concurrentes sobre el mismo registro y rechazar la que se basa en una versión desactualizada.
- **FR-017**: El sistema MUST registrar en cada cliente y vehículo quién lo creó, quién lo modificó por última vez y cuándo (UTC).
- **FR-018**: El sistema MUST permitir transferir un vehículo a otro cliente del mismo taller, con confirmación explícita del usuario.
- **FR-019**: La transferencia de propietario y la modificación de identificadores (placa, VIN, documento) MUST estar permitidas a asesores y administradores. Para el asesor, un motivo de 10 a 500 caracteres (sin contar espacios al inicio y al final) es obligatorio. Para el administrador el motivo es opcional, pero si lo informa debe cumplir la misma regla de 10 a 500 caracteres. El rol se toma siempre de la sesión del usuario.
- **FR-021**: El sistema MUST NOT ofrecer ninguna operación de eliminación ni de desactivación de clientes o vehículos en esta feature (fuera de alcance).

**Auditoría**

- **FR-020**: El sistema MUST registrar en el registro de auditoría inmutable, en la misma operación que el cambio, cada cambio de propietario de un vehículo y cada modificación de placa, VIN o documento. Cada registro guarda taller, actor y su rol, acción, entidad e identificador, valores antes y después, motivo (obligatorio si el actor es asesor y opcional si es administrador), fecha y hora UTC e IP o canal. Ningún usuario puede editar ni borrar esos registros.

**Aislamiento multi-tenant**

- **FR-022**: Todo cliente, vehículo y registro de auditoría MUST pertenecer a un único taller, determinado siempre por la sesión del usuario autenticado y nunca por datos enviados por el cliente.
- **FR-023**: Ninguna búsqueda, consulta, registro, edición o transferencia MUST poder leer, modificar ni relacionar datos de otro taller. El acceso a un registro de otro taller MUST responder igual que un registro inexistente ("no encontrado").
- **FR-024**: Los mensajes de error por duplicado MUST referirse solo a registros del propio taller y nunca revelar la existencia de datos en otros talleres.

**Uso en recepción**

- **FR-025**: Las pantallas de búsqueda, registro y edición MUST poder usarse completas en teléfonos (desde 360 px de ancho) y tablets, en vertical y horizontal, con objetivos táctiles de al menos 44 px y sin desplazamiento horizontal.
- **FR-026**: La búsqueda por placa MUST ser accesible desde la pantalla inicial del asesor en un solo toque y mostrar resultados mientras se escribe.

### Key Entities *(include if feature involves data)*

- **Taller (tenant)**: el negocio cliente del SaaS. Todos los demás datos le pertenecen; ya existe y lo determina la sesión.
- **Cliente**: persona natural o empresa propietaria de vehículos. Atributos: tipo (natural/empresa), tipo de documento (cédula, RUC, pasaporte), número de documento normalizado (único por taller), nombres y apellidos o razón social, teléfono, correo opcional, datos de creación y última modificación.
- **Vehículo**: vehículo atendido por el taller. Atributos: placa normalizada (única por taller), marca, modelo, año, color, tipo de carrocería, kilometraje inicial, VIN opcional normalizado (único por taller si existe), propietario actual (un cliente del mismo taller), datos de creación y última modificación.
- **Cambio de propietario**: hecho histórico que vincula un vehículo con su propietario anterior y el nuevo, la fecha, el usuario que lo hizo y el motivo (obligatorio si fue un asesor). Alimenta el historial de propietarios de la ficha del vehículo.
- **Registro de auditoría**: evidencia inmutable de acciones sensibles (cambio de propietario, modificación de identificadores), con taller, actor y su rol, acción, entidad, valores antes y después, motivo, fecha UTC e IP o canal.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Con un volumen de referencia de 50 000 vehículos y 30 000 clientes por taller (y al menos 10 talleres con ese volumen en el mismo sistema), el 95 % de las búsquedas por placa, documento o VIN devuelve resultados en menos de 200 ms medidos en el servidor.
- **SC-002**: Un asesor encuentra un vehículo registrado a partir de su placa en menos de 5 segundos desde la pantalla inicial, en un teléfono de gama media.
- **SC-003**: Un asesor registra un cliente nuevo y su vehículo en menos de 2 minutos en una tablet.
- **SC-004**: 0 casos en las pruebas de aislamiento en que un usuario de un taller lea, modifique o detecte la existencia de datos de otro taller.
- **SC-005**: El 100 % de los cambios de propietario y de las modificaciones de placa, VIN o documento tiene exactamente un registro de auditoría con todos sus campos.
- **SC-006**: 0 placas, documentos o VIN duplicados dentro de un mismo taller, incluso con registros simultáneos.
- **SC-007**: El 90 % de los asesores completa la búsqueda y el registro en su primer intento, sin ayuda, en una prueba de uso con tablet o teléfono.

## Assumptions

- Existe un usuario autenticado asociado a un único taller y con un rol (asesor o administrador); la autenticación y la gestión de usuarios están fuera de alcance.
- El taller opera en Ecuador; los documentos válidos son cédula, RUC y pasaporte.
- Una persona natural puede identificarse con cédula, RUC o pasaporte; una empresa solo con RUC.
- El teléfono es obligatorio. El correo es opcional para todos los clientes (confirmado en clarify) y se valida si se informa.
- El documento, la placa y el VIN se comparan siempre normalizados (sin espacios ni guiones; placa y VIN en mayúsculas).
- La búsqueda por VIN es solo por VIN completo (confirmado en clarify); la búsqueda parcial aplica a placa, documento y nombre.
- La validación de placa revisa solo la forma (letras y dígitos en el orden oficial), no si la letra inicial corresponde a una provincia existente.
- El mínimo de 10 caracteres del motivo del asesor busca evitar motivos vacíos de contenido ("x", "ok"); el humano puede ajustarlo.
- Marca, modelo y color se capturan como texto libre en esta feature; un catálogo de marcas y modelos queda para una feature posterior.
- El kilometraje registrado es el inicial; su actualización en cada ingreso pertenece al check-in.
- La creación de clientes y vehículos y la edición de campos no identificadores se registran como metadatos de creación y modificación en el propio registro, no en el registro de auditoría; solo el cambio de propietario y la modificación de identificadores van al registro de auditoría.
- El cambio de propietario de un vehículo (y la modificación de placa, VIN o documento) es un evento auditable que la constitución (principio IV) todavía no lista. El plan tendrá que tratarlo en el Constitution Check, ya sea como una ampliación compatible con el principio o proponiendo la enmienda MINOR correspondiente. El motivo es un campo adicional a los que exige el principio IV.
- La pantalla es de uso en línea; el trabajo sin conexión queda fuera de alcance de esta feature.
