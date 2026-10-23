# Feature Specification: Autenticación, talleres y usuarios

**Feature Branch**: `feat/002-autenticacion`

**Created**: 2026-10-22

**Status**: Draft

**Input**: User description: "Autenticación, talleres y usuarios. Hoy MotorSync solo funciona con tokens de desarrollo: hace falta que un taller real pueda registrarse, que su gente inicie sesión con su propia cuenta y que el administrador gestione quién entra y con qué rol. Actores: visitante (dueño de un taller que aún no tiene cuenta), administrador del taller, asesor de servicio. US1 registrar taller (nombre comercial y RUC) y cuenta del primer administrador (nombre, correo, contraseña) en una página pública, quedando con la sesión iniciada; US2 iniciar sesión con correo y contraseña, con mensaje de error que no revele si el correo existe, sin acceso para usuarios desactivados y con bloqueo temporal tras varios intentos fallidos seguidos; US3 sesión que dura mientras se trabaja, se cierra sola por inactividad y se puede cerrar manualmente, quedando inutilizable; US4 el administrador crea cuentas (asesor o administrador), cambia roles y desactiva o reactiva cuentas, nunca se borran, con auditoría de cambios de rol y de activación, protección del último administrador activo y cierre de sesiones al desactivar. Restricciones: correo único en todo MotorSync (el login no pide taller), RUC del taller único en MotorSync, contraseñas guardadas de forma irreversible y con longitud mínima, aislamiento total entre talleres, un asesor no gestiona usuarios, taller y rol salen siempre de la sesión. Fuera de alcance: recuperar contraseña por correo, verificación del correo, proveedores externos, dos factores, varios talleres por usuario, pagos o planes."

## Contexto y alcance

Hasta ahora MotorSync se usa con accesos de desarrollo: no hay forma de que un taller real se dé de alta ni de que su personal entre con cuentas propias. Esta feature agrega el alta pública del taller, el inicio y cierre de sesión, y la gestión de las cuentas del equipo por parte del administrador. Es el requisito previo para operar con talleres reales; todo lo construido en la feature 001 pasa a usar la sesión real para saber qué taller y qué rol tiene el usuario.

**Actores**

- **Visitante**: dueño o encargado de un taller que todavía no tiene cuenta. Solo puede registrar su taller e iniciar sesión.
- **Administrador del taller**: gestiona las cuentas de su taller (crear, cambiar rol, desactivar, reactivar, restablecer contraseña) y además tiene todas las capacidades del asesor.
- **Asesor de servicio**: trabaja con los datos de su taller; no puede ver ni gestionar cuentas de usuario. Como todo usuario, puede cambiar su propia contraseña.

**Fuera de alcance**: recuperación de contraseña por correo, verificación del correo, inicio de sesión con proveedores externos (Google, etc.), autenticación de dos factores, pertenencia de un usuario a varios talleres, pagos o planes de suscripción, eliminación de cuentas o de talleres, edición de los datos del taller después del registro y edición del nombre o del correo de una cuenta ya creada, y la recuperación de acceso por soporte de la plataforma (feature 003).

**Trabajo relacionado (feature 003, decidido por el humano el 2026-10-22, fuera del alcance de la 002)**: recuperación de acceso por soporte de la plataforma, pensada sobre todo para el administrador único que olvida su contraseña.

- Habrá un panel de plataforma para el equipo de MotorSync que muestra solo talleres (nombre, RUC, fecha de alta) y sus cuentas (nombre, correo, rol, estado). Nunca muestra clientes, vehículos ni datos de negocio.
- Las cuentas de soporte se crean con un procedimiento de operación, nunca desde la aplicación.
- En el inicio de sesión, "¿Olvidaste tu contraseña?" crea automáticamente un ticket de soporte que llega al panel. El soporte genera una contraseña temporal solo sobre un ticket abierto, y esa acción queda auditada en el taller afectado.
- Es el primer acceso entre talleres del sistema: la 003 necesitará su propio análisis frente al principio I de la constitución.

## Clarifications

### Session 2026-10-22

- Q: ¿Cuánto dura el periodo de inactividad de la sesión y existe una duración máxima aunque haya actividad? (FR-012) → A: 30 minutos de inactividad y sin duración máxima: mientras haya actividad, la sesión se renueva indefinidamente.
- Q: ¿Cómo obtiene la persona su contraseña inicial y quién puede cambiarla después? (FR-016) → A: El administrador crea la cuenta con una contraseña temporal que entrega a la persona; en su primer inicio de sesión la persona debe cambiarla antes de usar la aplicación. El administrador puede restablecer la contraseña de una cuenta de su taller con una nueva contraseña temporal, que vuelve a exigir el cambio y cierra las sesiones abiertas de esa cuenta; el restablecimiento queda en la auditoría. Entra al alcance "cambiar mi contraseña": todo usuario puede cambiar la suya dando la actual, y al hacerlo se cierran sus otras sesiones (la actual sigue). El dueño que se registra elige su contraseña y no tiene que cambiarla. Ninguna contraseña aparece en la auditoría ni en ninguna respuesta.
- Q: ¿Qué se le dice al visitante cuando el RUC o el correo ya están registrados? (US1-AC4, US1-AC5) → A: RUC explícito ("Este RUC ya tiene un taller registrado en MotorSync") y correo genérico, sin confirmar si existe ("No se pudo completar el registro con estos datos; si ya tiene una cuenta, inicie sesión"). El mismo criterio de no confirmar correos aplica cuando el administrador crea una cuenta con un correo ya usado, sin decir nunca de qué taller es.
- Q: ¿La contraseña temporal vence? → A: Sí, a las 72 horas desde que se crea o se restablece. Vencida ya no sirve para iniciar sesión y el administrador debe restablecerla.
- Q: ¿Se auditan el cambio de la propia contraseña y los bloqueos? → A: No. Solo se auditan cambio de rol, desactivación, reactivación y restablecimiento de contraseña.
- Q: ¿Cómo recupera el acceso un administrador único que olvidó su contraseña? → A: Por soporte de la plataforma, en la feature 003 (fuera del alcance de la 002); ver "Trabajo relacionado". En la 002 se mantienen: los fallos de "cambiar mi contraseña" cuentan para el bloqueo, restablecer quita el bloqueo, el administrador no puede restablecer su propia cuenta y US4-AC3 usa el mensaje genérico.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Registrar mi taller y mi cuenta de administrador (Priority: P1)

El dueño de un taller entra a una página pública, informa el nombre comercial y el RUC de su taller, y su nombre, correo y contraseña. Al terminar, el taller existe, él es su primer administrador y ya tiene la sesión iniciada, sin depender de nadie de MotorSync.

**Why this priority**: sin talleres registrados no hay usuarios ni datos; es la puerta de entrada de cualquier cliente real del SaaS.

**Independent Test**: un visitante registra el taller "Taller Andrade" con un RUC válido y queda dentro de MotorSync como administrador; un segundo intento con el mismo RUC o el mismo correo se rechaza; un registro con datos inválidos no crea nada.

**Acceptance Scenarios**:

1. **US1-AC1**: **Given** un visitante sin sesión en la página pública de registro, **When** informa nombre comercial, RUC válido, su nombre, un correo válido y una contraseña elegida por él que cumple FR-005, **Then** el sistema crea el taller y una cuenta activa con rol administrador asociada a ese taller, inicia su sesión y lo lleva a la pantalla inicial del taller, sin pedirle que cambie la contraseña (no es temporal).
2. **US1-AC2**: **Given** el visitante escribe el correo ` Ana.Perez@Taller.EC `, **When** completa el registro, **Then** la cuenta queda con el correo `ana.perez@taller.ec` (sin espacios al inicio ni al final y en minúsculas) y puede iniciar sesión escribiéndolo con cualquier combinación de mayúsculas y minúsculas.
3. **US1-AC3**: **Given** el visitante informa un RUC que no tiene 13 dígitos, no termina en `001` o no supera la validación de su tipo (persona natural, sociedad privada o entidad pública), **When** intenta registrarse, **Then** el sistema rechaza el registro, indica "RUC inválido" junto al campo y no crea ni el taller ni la cuenta.
4. **US1-AC4**: **Given** ya existe en MotorSync un taller con el RUC `1790012345001`, **When** un visitante intenta registrar otro taller con ese RUC (con o sin espacios o guiones), **Then** el sistema rechaza el registro con el mensaje "Este RUC ya tiene un taller registrado en MotorSync" junto al campo RUC, sin revelar ningún otro dato de ese taller, y no crea ni el taller ni la cuenta.
5. **US1-AC5**: **Given** ya existe en MotorSync una cuenta con el correo `ana.perez@taller.ec`, en cualquier taller y activa o desactivada, **When** un visitante intenta registrarse con `ANA.PEREZ@taller.ec` y un RUC libre, **Then** el sistema rechaza el registro con el mensaje genérico "No se pudo completar el registro con estos datos; si ya tiene una cuenta, inicie sesión", que no señala el campo correo ni confirma que el correo exista, y no crea ni el taller ni la cuenta. Si el RUC y el correo están ambos en uso, se muestra el mensaje del RUC (US1-AC4).
6. **US1-AC6**: **Given** el visitante informa una contraseña más corta que el mínimo de FR-005, o deja vacío cualquier campo obligatorio (nombre comercial, RUC, nombre, correo, contraseña), o un correo con formato inválido, **When** intenta registrarse, **Then** el sistema no crea nada y marca cada campo con error.
7. **US1-AC7 (atomicidad)**: **Given** el registro falla en cualquier paso (por ejemplo, el correo resulta duplicado después de validar el RUC), **When** termina la operación, **Then** no queda un taller sin administrador ni una cuenta sin taller: se crean ambos o ninguno.
8. **US1-AC8 (concurrencia)**: **Given** dos visitantes envían a la vez un registro con el mismo RUC, o con el mismo correo, **When** el sistema los procesa, **Then** exactamente uno se completa y el otro recibe el rechazo por duplicado de US1-AC4 o US1-AC5.
9. **US1-AC9 (identidad desde la sesión)**: **Given** el formulario de registro, **When** el visitante envía además un identificador de taller existente o un rol distinto (por ejemplo, manipulando la petición), **Then** el sistema ignora esos datos: crea siempre un taller nuevo y la cuenta siempre con rol administrador de ese taller nuevo.
10. **US1-AC10 (multi-tenant)**: **Given** el taller A ya existe con sus clientes y vehículos, **When** se registra el taller B y su administrador inicia sesión, **Then** el administrador de B no ve ningún cliente, vehículo, cuenta ni registro de auditoría del taller A.

---

### User Story 2 - Iniciar sesión con correo y contraseña (Priority: P1)

Un usuario (administrador o asesor) entra con su correo y su contraseña, sin elegir taller: el sistema sabe a qué taller pertenece y con qué rol, y le muestra solo los datos de ese taller.

**Why this priority**: sin inicio de sesión ningún usuario creado en US1 o US4 puede volver a entrar; junto con US1 forma el mínimo viable.

**Independent Test**: con usuarios en los talleres A y B, cada uno entra con su correo y contraseña y ve solo los datos de su taller; las credenciales incorrectas, el correo inexistente y la cuenta desactivada se rechazan con el mismo mensaje; tras el número de intentos fallidos de FR-009 el acceso queda bloqueado temporalmente.

**Acceptance Scenarios**:

1. **US2-AC1**: **Given** existe la cuenta activa `ana.perez@taller.ec` del taller A con rol asesor, **When** inicia sesión con su correo y su contraseña correcta, **Then** el sistema inicia la sesión con el taller A y el rol asesor, y la lleva a la pantalla inicial del taller.
2. **US2-AC2**: **Given** la misma cuenta, **When** escribe el correo como ` ANA.Perez@taller.ec ` y la contraseña correcta, **Then** el inicio de sesión funciona igual que en US2-AC1. La contraseña, en cambio, sí distingue mayúsculas y minúsculas y no se recorta.
3. **US2-AC3 (sin revelar el correo)**: **Given** cualquiera de estos casos: el correo no existe en MotorSync, la contraseña es incorrecta, o la cuenta está desactivada, **When** se intenta iniciar sesión, **Then** el sistema responde con el mismo mensaje "Correo o contraseña incorrectos" y en un tiempo de respuesta que no permite distinguir un caso de otro.
4. **US2-AC4 (cuenta desactivada)**: **Given** la cuenta `luis@taller.ec` está desactivada, **When** inicia sesión con su contraseña correcta, **Then** el sistema no inicia ninguna sesión y responde como en US2-AC3.
5. **US2-AC5 (bloqueo temporal)**: **Given** se han producido 5 intentos fallidos seguidos para el mismo correo, **When** se hace un nuevo intento durante los 15 minutos siguientes al quinto fallo, aunque la contraseña sea correcta, **Then** el sistema no inicia la sesión y responde "Demasiados intentos fallidos. Intente de nuevo en unos minutos".
6. **US2-AC6 (fin del bloqueo)**: **Given** una cuenta bloqueada según US2-AC5, **When** pasan 15 minutos desde el quinto fallo y el usuario inicia sesión con su contraseña correcta, **Then** la sesión se inicia y el contador de intentos fallidos vuelve a cero.
7. **US2-AC7 (reinicio del contador)**: **Given** una cuenta con 4 intentos fallidos seguidos, **When** el usuario inicia sesión correctamente, **Then** el contador vuelve a cero, y un fallo posterior cuenta como el primero.
8. **US2-AC8 (bloqueo sin revelar el correo)**: **Given** un correo que no existe en MotorSync, **When** se hacen 5 intentos fallidos seguidos con él y luego un sexto, **Then** el sexto recibe la misma respuesta de bloqueo que US2-AC5, de modo que el bloqueo tampoco revela si el correo existe.
9. **US2-AC9 (intentos concurrentes)**: **Given** una cuenta con 0 intentos fallidos, **When** llegan a la vez 10 intentos con contraseña incorrecta para ese correo, **Then** todos se cuentan: la cuenta queda bloqueada y ningún intento posterior dentro del bloqueo inicia sesión, aunque sea correcto.
10. **US2-AC10 (identidad desde la sesión)**: **Given** el formulario de inicio de sesión, **When** se envía además un identificador de taller o un rol, **Then** el sistema los ignora: el taller y el rol de la sesión son siempre los de la cuenta.
11. **US2-AC11 (multi-tenant)**: **Given** Ana inició sesión en el taller A, **When** intenta abrir un cliente, vehículo o cuenta del taller B usando su identificador directo, **Then** el sistema responde "no encontrado", igual que si no existiera.
12. **US2-AC12 (sin sesión)**: **Given** una persona sin sesión iniciada, **When** intenta abrir cualquier pantalla o dato del taller distinto de la página de registro y la de inicio de sesión, **Then** el sistema no muestra ningún dato y la lleva a iniciar sesión.

---

### User Story 3 - Mantener la sesión y cerrarla (Priority: P1)

La sesión del usuario se mantiene mientras trabaja, se cierra sola tras un periodo de inactividad y el usuario puede cerrarla cuando quiera, por ejemplo en el equipo compartido de la recepción. Una sesión cerrada no la puede seguir usando nadie.

**Why this priority**: la recepción suele tener equipos compartidos; una sesión abierta olvidada expone los datos de clientes del taller.

**Independent Test**: un usuario trabaja de forma continua sin que se le pida volver a entrar; tras el tiempo de inactividad de FR-012 cualquier acción lo devuelve al inicio de sesión; al cerrar sesión, repetir una petición con la sesión anterior es rechazado.

**Acceptance Scenarios**:

1. **US3-AC1 (sesión activa)**: **Given** un usuario con sesión iniciada que realiza alguna acción al menos una vez dentro de cada periodo de inactividad de FR-012, **When** sigue trabajando durante cualquier tiempo (por ejemplo, una jornada de 12 horas con acciones al menos cada 29 minutos), **Then** no se le pide volver a iniciar sesión: cada acción renueva el periodo de 30 minutos y no hay una duración máxima de la sesión.
2. **US3-AC2 (cierre por inactividad)**: **Given** un usuario con sesión iniciada, **When** pasan más de 30 minutos desde su última acción sin ninguna otra y luego intenta cualquier acción, **Then** el sistema rechaza la acción, no muestra datos y lo lleva a iniciar sesión con el mensaje "Su sesión expiró por inactividad".
3. **US3-AC3 (cierre manual)**: **Given** un usuario con sesión iniciada, **When** elige "Cerrar sesión", **Then** la sesión termina, la pantalla deja de mostrar datos del taller y vuelve a la página de inicio de sesión.
4. **US3-AC4 (sesión cerrada inutilizable)**: **Given** un usuario cerró su sesión (US3-AC3) o esta expiró (US3-AC2), **When** alguien reutiliza esa misma sesión (por ejemplo, con el botón "atrás" del navegador o repitiendo una petición anterior), **Then** el sistema la rechaza igual que a una persona sin sesión.
5. **US3-AC5 (sesiones independientes)**: **Given** el mismo usuario tiene sesión iniciada en la tablet de la recepción y en su teléfono, **When** cierra sesión en la tablet, **Then** la sesión de la tablet queda inutilizable y la del teléfono sigue activa.
6. **US3-AC6 (cerrar sesión repetido)**: **Given** una sesión ya cerrada, **When** se pide cerrarla de nuevo, **Then** el sistema responde como un cierre correcto, sin error y sin efectos adicionales.
7. **US3-AC7 (multi-tenant)**: **Given** un usuario del taller A cierra su sesión, **When** se consultan las sesiones de los usuarios del taller B, **Then** ninguna se ve afectada; y ninguna acción sobre sesiones puede cerrar ni usar sesiones de otro taller.

---

### User Story 4 - Gestionar las cuentas del equipo (Priority: P2)

El administrador ve las cuentas de su taller, crea cuentas nuevas para su equipo (asesor o administrador) con una contraseña temporal, cambia el rol de una cuenta, la desactiva o reactiva y restablece su contraseña, para controlar quién entra y qué puede hacer. Las cuentas nunca se borran, y los cambios de rol, de activación y los restablecimientos de contraseña quedan en la auditoría.

**Why this priority**: con US1–US3 un taller ya puede trabajar con un solo administrador; la gestión del equipo es necesaria para talleres con más personal, pero llega después.

**Independent Test**: el administrador del taller A crea una cuenta de asesor, la persona entra con ella, el administrador le cambia el rol, le restablece la contraseña, la desactiva (sus sesiones abiertas dejan de funcionar) y la reactiva; se verifican los registros de auditoría, la protección del último administrador y que nada de esto es posible sobre cuentas del taller B ni para un asesor.

**Acceptance Scenarios**:

1. **US4-AC1 (listado)**: **Given** el administrador del taller A, **When** abre la gestión de usuarios, **Then** ve todas las cuentas de su taller (activas y desactivadas) con nombre, correo, rol y estado, y ninguna cuenta de otro taller. Nunca se muestra ninguna contraseña.
2. **US4-AC2 (crear cuenta)**: **Given** el administrador del taller A, **When** crea una cuenta con nombre, correo válido, rol asesor o administrador y una contraseña temporal que cumple FR-005, **Then** la cuenta queda activa en el taller A con ese rol y con la contraseña marcada como temporal; el administrador entrega esa contraseña a la persona por su cuenta, y la persona puede iniciar sesión según US2 pero debe cambiarla antes de usar la aplicación (US5-AC1).
3. **US4-AC3 (correo duplicado)**: **Given** ya existe una cuenta con el correo `luis@taller.ec`, en el taller A o en cualquier otro taller, activa o desactivada, **When** el administrador del taller A crea otra cuenta con ` Luis@Taller.ec `, **Then** el sistema no crea la cuenta y responde con el mismo mensaje en todos los casos, "No se pudo crear la cuenta con este correo. Si la persona ya tiene una cuenta en su taller, búsquela en la lista; si no, use otro correo", sin confirmar si el correo existe, sin decir a qué taller pertenece y sin revelar ningún otro dato de esa cuenta.
4. **US4-AC4 (validaciones)**: **Given** el formulario de nueva cuenta, **When** falta el nombre, el correo o el rol, el correo tiene formato inválido, la contraseña temporal no cumple FR-005 o el rol no es asesor ni administrador, **Then** el sistema no crea la cuenta y marca cada campo con error.
5. **US4-AC5 (cambiar rol)**: **Given** la cuenta activa de Luis tiene rol asesor, **When** el administrador le cambia el rol a administrador, **Then** Luis tiene el rol administrador a más tardar en su siguiente acción, sin tener que volver a iniciar sesión, y lo mismo aplica al cambio de administrador a asesor (desde su siguiente acción ya no puede gestionar usuarios).
6. **US4-AC6 (desactivar)**: **Given** Luis tiene sesiones abiertas en dos equipos, **When** el administrador desactiva su cuenta, **Then** la cuenta queda desactivada, ambas sesiones dejan de funcionar en su siguiente acción (como en US3-AC4) y Luis no puede volver a iniciar sesión (US2-AC4).
7. **US4-AC7 (reactivar)**: **Given** la cuenta de Luis está desactivada, **When** el administrador la reactiva, **Then** la cuenta vuelve a estar activa con el mismo rol que tenía y Luis puede iniciar sesión con su contraseña de siempre. Ninguna sesión anterior a la desactivación vuelve a funcionar.
8. **US4-AC8 (sin borrado)**: **Given** cualquier cuenta del taller, **When** el administrador la consulta o la gestiona, **Then** no existe ninguna acción para eliminarla, y cualquier intento de borrado por otra vía se rechaza sin modificar datos.
9. **US4-AC9 (último administrador)**: **Given** Ana es la única cuenta activa con rol administrador del taller A, **When** alguien intenta cambiarle el rol a asesor o desactivarla (incluida ella misma), **Then** el sistema rechaza la operación con el mensaje "El taller debe tener al menos un administrador activo", no cambia nada y no crea registro de auditoría.
10. **US4-AC10 (último administrador, concurrencia)**: **Given** el taller A tiene exactamente dos administradores activos, Ana y Pedro, **When** a la vez Ana desactiva (o quita el rol) a Pedro y Pedro desactiva (o quita el rol) a Ana, **Then** como máximo una de las dos operaciones se completa y el taller conserva al menos un administrador activo.
11. **US4-AC11 (autogestión)**: **Given** el taller A tiene al menos dos administradores activos, **When** Ana se quita a sí misma el rol de administrador o se desactiva, **Then** la operación se completa y se audita como cualquier otra; si se desactivó, sus sesiones se cierran como en US4-AC6.
12. **US4-AC12 (auditoría de rol)**: **Given** el administrador cambió el rol de Luis de asesor a administrador, **When** se consulta el registro de auditoría del taller, **Then** existe exactamente un registro con el taller, el actor y su rol, la acción "cambio de rol", la cuenta afectada, el rol anterior y el nuevo, la fecha y hora en UTC y la IP o canal de origen.
13. **US4-AC13 (auditoría de activación)**: **Given** el administrador desactivó y luego reactivó la cuenta de Luis, **When** se consulta el registro de auditoría, **Then** existen exactamente dos registros ("desactivación de cuenta" y "reactivación de cuenta") con el taller, el actor y su rol, la cuenta afectada, el estado anterior y el nuevo, la fecha y hora en UTC y la IP o canal.
14. **US4-AC14 (auditoría atómica)**: **Given** un cambio de rol, una desactivación, una reactivación o un restablecimiento de contraseña, **When** la operación falla por cualquier motivo (incluido US4-AC9), **Then** ni la cuenta cambia, ni se cierran sesiones, ni se crea registro de auditoría: todo ocurre junto o no ocurre nada.
15. **US4-AC15 (sin cambio real)**: **Given** Luis ya tiene rol asesor (o ya está desactivado), **When** el administrador le asigna rol asesor (o lo desactiva) otra vez, **Then** el sistema responde sin error, no modifica nada y no crea registro de auditoría.
16. **US4-AC16 (asesor sin permisos)**: **Given** un usuario con rol asesor, **When** intenta ver la lista de cuentas, crear una cuenta, cambiar un rol, desactivar, reactivar o restablecer la contraseña de una cuenta (incluida la suya), por la interfaz o por cualquier otra vía, **Then** el sistema rechaza la operación con "No tiene permisos para gestionar usuarios", no modifica nada y no crea registro de auditoría. La interfaz del asesor no muestra la opción de gestión de usuarios.
17. **US4-AC17 (multi-tenant, lectura)**: **Given** las cuentas de Luis (taller A) y de Marta (taller B), **When** el administrador del taller A lista las cuentas o abre la de Marta con su identificador directo, **Then** no ve a Marta y la apertura directa responde "no encontrado".
18. **US4-AC18 (multi-tenant, escritura)**: **Given** la cuenta de Marta pertenece al taller B, **When** el administrador del taller A intenta cambiarle el rol, desactivarla, reactivarla o restablecer su contraseña usando su identificador, **Then** el sistema responde "no encontrado", no cambia nada, no cierra sesiones de Marta y no crea registros de auditoría en ninguno de los dos talleres.
19. **US4-AC19 (identidad desde la sesión)**: **Given** el administrador del taller A crea una cuenta, **When** la petición incluye además el identificador del taller B, **Then** el sistema ignora ese dato y crea la cuenta en el taller A. Igualmente, el rol del actor para decidir si puede gestionar usuarios sale siempre de su sesión, nunca de un dato enviado por el cliente.
20. **US4-AC20 (multi-tenant, auditoría)**: **Given** los talleres A y B tienen registros de auditoría de cuentas, **When** el administrador del taller A los consulta, **Then** solo ve los de su taller.
21. **US4-AC21 (restablecer contraseña)**: **Given** Luis, del taller A, olvidó su contraseña y tiene sesiones abiertas en dos equipos, **When** el administrador del taller A le restablece la contraseña con una nueva contraseña temporal que cumple FR-005, **Then** la contraseña anterior deja de servir, la nueva queda marcada como temporal, ambas sesiones de Luis dejan de funcionar en su siguiente acción (como en US3-AC4), y Luis puede iniciar sesión con la temporal pero debe cambiarla antes de usar la aplicación (US5-AC1). Si Luis estaba bloqueado por intentos fallidos (US2-AC5), el bloqueo y el contador se reinician.
22. **US4-AC22 (restablecer, cuenta desactivada)**: **Given** la cuenta de Luis está desactivada, **When** el administrador le restablece la contraseña, **Then** la contraseña temporal queda guardada pero la cuenta sigue desactivada y no puede iniciar sesión hasta que se reactive (US4-AC7).
23. **US4-AC23 (restablecer la propia cuenta)**: **Given** el administrador Ana, **When** intenta restablecer la contraseña de su propia cuenta desde la gestión de usuarios, **Then** el sistema rechaza la operación con el mensaje "Para su propia cuenta use Cambiar mi contraseña", no modifica nada y no crea registro de auditoría.
24. **US4-AC24 (auditoría de restablecimiento)**: **Given** el administrador restableció la contraseña de Luis, **When** se consulta el registro de auditoría del taller, **Then** existe exactamente un registro con el taller, el actor y su rol, la acción "restablecimiento de contraseña", la cuenta afectada, el valor antes y después de "contraseña temporal" (por ejemplo, no → sí), el número de sesiones cerradas, la fecha y hora en UTC y la IP o canal. Ni el registro ni ninguna respuesta contienen la contraseña anterior ni la nueva, en ninguna forma.

---

### User Story 5 - Cambiar mi contraseña (Priority: P2)

Todo usuario puede cambiar su propia contraseña dando la actual. Quien entra con una contraseña temporal (cuenta nueva o restablecida por el administrador) está obligado a cambiarla antes de usar la aplicación, para que solo él conozca su contraseña.

**Why this priority**: es lo que hace seguras las contraseñas temporales de US4; sin el cambio obligatorio, el administrador conocería la contraseña de todo su equipo.

**Independent Test**: una persona con contraseña temporal inicia sesión, comprueba que no puede hacer nada salvo cambiarla, la cambia y trabaja normalmente; otro usuario cambia su contraseña desde un equipo y su sesión en otro equipo deja de funcionar; una contraseña actual incorrecta se rechaza.

**Acceptance Scenarios**:

1. **US5-AC1 (cambio obligatorio)**: **Given** Luis inicia sesión con una contraseña temporal (US4-AC2 o US4-AC21), **When** intenta abrir cualquier pantalla o hacer cualquier acción distinta de cambiar su contraseña o cerrar sesión, **Then** el sistema la rechaza, no muestra datos del taller y lo lleva a la pantalla de cambio de contraseña con el mensaje "Debe cambiar su contraseña antes de continuar".
2. **US5-AC2 (cambio de la temporal)**: **Given** Luis está en el cambio obligatorio de US5-AC1, **When** informa su contraseña temporal como actual y una nueva contraseña que cumple FR-005, es distinta de la temporal y coincide con su confirmación, **Then** la contraseña deja de ser temporal, la temporal deja de servir y Luis sigue en su sesión actual con acceso normal según su rol.
3. **US5-AC3 (cambio voluntario)**: **Given** Ana tiene sesión iniciada en la tablet de la recepción y en su teléfono, **When** en la tablet cambia su contraseña informando la actual correcta y una nueva válida, **Then** la contraseña anterior deja de servir, la sesión de la tablet sigue activa y la del teléfono deja de funcionar en su siguiente acción (como en US3-AC4).
4. **US5-AC4 (contraseña actual incorrecta)**: **Given** un usuario con sesión iniciada, **When** intenta cambiar su contraseña con una contraseña actual incorrecta, **Then** el sistema rechaza el cambio con "La contraseña actual no es correcta", no modifica nada y no cierra ninguna sesión. Estos fallos cuentan para el bloqueo de FR-009: tras 5 seguidos, el cambio de contraseña y el inicio de sesión con ese correo quedan bloqueados 15 minutos, sin cerrar la sesión en curso.
5. **US5-AC5 (validaciones)**: **Given** un usuario que cambia su contraseña, **When** la nueva no cumple FR-005, es igual a la actual o no coincide con su confirmación, **Then** el sistema rechaza el cambio, indica el campo con error y no modifica nada.
6. **US5-AC6 (dueño registrado)**: **Given** el dueño que registró su taller en US1 eligió su contraseña, **When** inicia sesión, **Then** no se le exige cambiarla; puede cambiarla voluntariamente como en US5-AC3.
7. **US5-AC7 (contraseñas nunca visibles)**: **Given** cualquier cambio o restablecimiento de contraseña, **When** se revisan las respuestas del sistema, las pantallas y los registros de auditoría, **Then** ninguna contiene la contraseña actual, la anterior ni la nueva.
8. **US5-AC8 (solo la propia)**: **Given** un usuario de cualquier rol, **When** intenta cambiar con este flujo la contraseña de otra cuenta (de su taller o de otro), por ejemplo enviando su identificador, **Then** el sistema ignora ese identificador y solo puede cambiar la contraseña de la cuenta de su sesión.
9. **US5-AC9 (contraseña temporal vencida)**: **Given** el administrador creó o restableció la contraseña temporal de Luis hace más de 72 horas y Luis no la cambió, **When** Luis inicia sesión con esa contraseña temporal correcta, **Then** el sistema no inicia la sesión y responde "Su contraseña temporal venció. Pida al administrador de su taller que la restablezca"; el intento no cuenta como fallido para el bloqueo. Con una contraseña incorrecta la respuesta sigue siendo la genérica de US2-AC3. **When** el administrador la restablece (US4-AC21), **Then** la nueva temporal vale otras 72 horas.

---

### Edge Cases

- **Correo con mayúsculas o espacios** (` Ana@Taller.EC `): se normaliza (sin espacios al inicio y al final, en minúsculas) al registrar, al crear cuentas y al iniciar sesión; la unicidad se evalúa siempre sobre el correo normalizado (US1-AC2, US2-AC2, US4-AC3).
- **Contraseña con espacios al inicio o al final**: se respeta tal como se escribe; no se recorta ni se normaliza (US2-AC2).
- **Registro duplicado** (mismo RUC o mismo correo, incluso escrito distinto): se rechaza y no se crea nada, con mensaje explícito para el RUC y genérico para el correo (US1-AC4, US1-AC5); con envíos simultáneos solo uno prospera (US1-AC8).
- **Doble clic en "Registrar"** o reintento por red inestable: no se crean dos talleres; el segundo envío recibe el rechazo por duplicado o el resultado del primero.
- **Persona que ya administra un taller y quiere registrar otro**: no puede usar el mismo correo (FR-003); varios talleres por usuario está fuera de alcance.
- **Intentos de inicio de sesión concurrentes** contra el mismo correo: todos cuentan para el bloqueo (US2-AC9).
- **Bloqueo y cuenta desactivada**: una cuenta desactivada recibe siempre la respuesta genérica (US2-AC3) o la de bloqueo (US2-AC5), nunca un mensaje que diga que está desactivada.
- **Último administrador**: no puede quitarse el rol ni desactivarse, tampoco por sí mismo (US4-AC9); con dos administradores que se desactivan a la vez, el taller conserva al menos uno (US4-AC10).
- **Administrador que se quita el rol a sí mismo** teniendo otros administradores: se permite; desde su siguiente acción ya no ve la gestión de usuarios (US4-AC5, US4-AC11).
- **Usuario desactivado o con rol cambiado en mitad de una operación**: la operación en curso se evalúa con el estado y el rol vigentes al momento de procesarla; la siguiente ya usa el nuevo estado.
- **Sesión expirada con un formulario a medio llenar**: el usuario vuelve a iniciar sesión; no se garantiza conservar lo escrito (ver Assumptions).
- **Acceso con una sesión de un taller a una ruta con el identificador de otro taller**: responde "no encontrado" (US2-AC11, US4-AC17).
- **Contraseña temporal olvidada antes del primer ingreso**: el administrador la restablece con otra temporal (US4-AC21).
- **Contraseña temporal vencida** (más de 72 horas sin cambiarla): ya no permite iniciar sesión (US5-AC9) y el administrador debe restablecerla. Si vence mientras la persona está en la pantalla de cambio obligatorio, el cambio se rechaza con el mismo mensaje y su sesión se cierra.
- **Administrador único que olvidó su contraseña**: no puede recuperarla en esta feature; la recuperación por soporte de la plataforma llega con la feature 003 (ver "Trabajo relacionado").
- **Usuario con contraseña temporal que cierra la ventana sin cambiarla**: en su siguiente inicio de sesión se le vuelve a exigir el cambio (US5-AC1).
- **Restablecimiento mientras el usuario está cambiando su contraseña**: las dos operaciones se aplican una tras otra, nunca mezcladas. Si el restablecimiento se aplica primero, el cambio se rechaza porque la contraseña actual ya no es válida (US5-AC4); si se aplica después, la cuenta queda con la temporal y sin sesiones (US4-AC21).
- **Cambio de contraseña con la nueva igual a la actual**: se rechaza (US5-AC5).
- **Cuenta creada con un correo equivocado**: como no se borran cuentas ni se edita el correo en esta feature, el administrador la desactiva y crea otra con el correo correcto.

## Requirements *(mandatory)*

### Functional Requirements

**Registro del taller**

- **FR-001**: El sistema MUST ofrecer una página pública, sin sesión, para registrar un taller (nombre comercial y RUC) junto con su primera cuenta (nombre, correo y contraseña), que queda con rol administrador y con la sesión iniciada.
- **FR-002**: El sistema MUST validar el RUC del taller con las mismas reglas que el RUC de clientes de la feature 001 (13 dígitos, terminado en `001` y validación según su tipo) y garantizar que el RUC normalizado (sin espacios ni guiones) es único en todo MotorSync.
- **FR-003**: El sistema MUST garantizar que el correo normalizado (sin espacios al inicio y al final, en minúsculas) es único en todo MotorSync, incluidas las cuentas desactivadas, y validar su formato estándar.
- **FR-004**: El registro del taller y de su primer administrador MUST ser atómico: se crean ambos o ninguno, también ante envíos simultáneos con el mismo RUC o correo.

**Contraseñas**

- **FR-005**: Las contraseñas MUST tener entre 8 y 128 caracteres. El sistema MUST distinguir mayúsculas y minúsculas y no recortarlas ni transformarlas.
- **FR-006**: Las contraseñas MUST guardarse de forma irreversible, de modo que nadie (ni el personal de MotorSync ni el administrador del taller) pueda conocerlas a partir de lo guardado. Ninguna pantalla, respuesta, registro de auditoría ni registro técnico MUST mostrar una contraseña, ni actual, ni anterior, ni nueva, ni temporal.
- **FR-026**: Una contraseña definida por el administrador (al crear la cuenta o al restablecerla) MUST quedar marcada como temporal. Mientras la contraseña de una sesión sea temporal, el sistema MUST rechazar toda acción salvo cambiar la propia contraseña y cerrar sesión. La contraseña que elige el dueño al registrar su taller no es temporal. Una contraseña temporal MUST vencer a las 72 horas desde que se creó o se restableció: vencida, no permite iniciar sesión ni completar el cambio obligatorio (US5-AC9) y solo un nuevo restablecimiento la reemplaza.
- **FR-027**: Todo usuario MUST poder cambiar su propia contraseña informando la actual y una nueva que cumpla FR-005, distinta de la actual y confirmada. Al cambiarla, la contraseña deja de ser temporal y el sistema MUST cerrar todas las demás sesiones de esa cuenta en la misma operación; la sesión desde la que se cambió sigue activa. Los fallos por contraseña actual incorrecta cuentan para el bloqueo de FR-009, sin cerrar la sesión en curso.
- **FR-028**: El administrador MUST poder restablecer la contraseña de cualquier otra cuenta de su taller (activa o desactivada) con una nueva contraseña temporal que cumpla FR-005. El restablecimiento MUST, en la misma operación, invalidar la contraseña anterior, cerrar todas las sesiones de esa cuenta, reiniciar su contador de intentos fallidos y su bloqueo, y crear el registro de auditoría de FR-021. Un administrador MUST NOT restablecer su propia contraseña por esta vía (usa FR-027).

**Inicio de sesión**

- **FR-007**: El sistema MUST permitir iniciar sesión con correo y contraseña, sin pedir el taller; el taller y el rol de la sesión son los de la cuenta.
- **FR-008**: Ante correo inexistente, contraseña incorrecta o cuenta desactivada, el sistema MUST responder con el mismo mensaje genérico y un tiempo de respuesta indistinguible.
- **FR-009**: Tras 5 intentos fallidos seguidos para un mismo correo (exista o no), el sistema MUST rechazar todo intento para ese correo durante 15 minutos, incluso con la contraseña correcta. Un inicio de sesión correcto reinicia el contador. Los intentos simultáneos MUST contarse todos.
- **FR-010**: Una persona sin sesión válida MUST poder acceder solo a la página de registro y a la de inicio de sesión.

**Sesión**

- **FR-011**: Cada inicio de sesión MUST crear una sesión independiente; un mismo usuario puede tener varias sesiones abiertas en distintos equipos.
- **FR-012**: Una sesión MUST cerrarse automáticamente tras 30 minutos sin actividad. Cada acción del usuario renueva ese periodo y la sesión no tiene duración máxima: mientras haya actividad, se mantiene indefinidamente.
- **FR-013**: El usuario MUST poder cerrar su sesión en cualquier momento. Una sesión cerrada (por el usuario, por desactivación de la cuenta, por cambio o por restablecimiento de contraseña) o expirada MUST quedar inutilizable de inmediato para cualquier petición posterior.
- **FR-014**: El taller y el rol de cada acción MUST salir siempre de la sesión y de la cuenta vigente, nunca de datos enviados por el cliente (formularios, parámetros o encabezados). Un cambio de rol o de estado de la cuenta MUST aplicarse a más tardar en la siguiente acción de sus sesiones abiertas.

**Gestión de cuentas**

- **FR-015**: Solo un usuario con rol administrador MUST poder ver la lista de cuentas de su taller, crear cuentas, cambiar roles, desactivar y reactivar cuentas y restablecer contraseñas de otras cuentas de su taller. Los roles disponibles son administrador y asesor.
- **FR-016**: Al crear una cuenta, el administrador MUST informar nombre, correo, rol y una contraseña temporal que cumpla FR-005. El sistema no envía la contraseña a la persona: el administrador se la entrega por su cuenta.
- **FR-017**: El sistema MUST NOT ofrecer ninguna operación para eliminar cuentas ni talleres.
- **FR-018**: Cada taller MUST tener en todo momento al menos una cuenta activa con rol administrador; el sistema MUST rechazar cualquier cambio de rol o desactivación que lo deje sin ninguna, también ante operaciones simultáneas.
- **FR-019**: Al desactivar una cuenta, el sistema MUST cerrar todas sus sesiones abiertas en la misma operación. Reactivarla no revive sesiones anteriores.
- **FR-020**: El sistema MUST registrar en cada cuenta quién la creó, quién la modificó por última vez y cuándo (UTC).

**Auditoría**

- **FR-021**: El sistema MUST registrar en el registro de auditoría inmutable, en la misma operación que el cambio, cada cambio de rol, cada desactivación, cada reactivación y cada restablecimiento de contraseña de una cuenta, con taller, actor y su rol, acción, cuenta afectada, valores antes y después (en el restablecimiento: el indicador de contraseña temporal y el número de sesiones cerradas, nunca la contraseña), fecha y hora UTC e IP o canal. El cambio de la propia contraseña (FR-027) no se registra en la auditoría. Una operación que no cambia nada (US4-AC15) o que se rechaza no crea registro. Ningún usuario puede editar ni borrar esos registros.

**Aislamiento multi-tenant**

- **FR-022**: Toda cuenta, sesión y registro de auditoría MUST pertenecer a un único taller. Ninguna consulta o gestión de cuentas MUST poder leer, modificar ni afectar cuentas o sesiones de otro taller; el acceso a una cuenta de otro taller MUST responder igual que una inexistente ("no encontrado").
- **FR-023**: El rechazo por RUC ya en uso en el registro público MUST ser explícito ("Este RUC ya tiene un taller registrado en MotorSync") sin revelar ningún otro dato del taller. El rechazo por correo ya en uso, tanto en el registro público como al crear una cuenta, MUST usar un mensaje genérico que no confirme que el correo exista ni diga a qué taller pertenece (US1-AC5, US4-AC3).
- **FR-024**: Todas las capacidades de la feature 001 MUST funcionar con la sesión real de esta feature, tomando de ella el taller y el rol.

**Uso en recepción**

- **FR-025**: Las pantallas de registro, inicio de sesión, cambio de contraseña y gestión de usuarios MUST poder usarse completas en teléfonos (desde 360 px de ancho) y tablets, con objetivos táctiles de al menos 44 px y sin desplazamiento horizontal. La acción "Cerrar sesión" MUST estar accesible desde cualquier pantalla del taller en un máximo de dos toques.

### Key Entities *(include if feature involves data)*

- **Taller (tenant)**: el negocio cliente del SaaS. Atributos: nombre comercial, RUC normalizado (único en MotorSync), fecha de registro. Todo lo demás le pertenece.
- **Cuenta de usuario**: persona que trabaja en un taller. Atributos: taller (exactamente uno), nombre, correo normalizado (único en MotorSync), contraseña guardada de forma irreversible, indicador de contraseña temporal (debe cambiarla al entrar) y su vencimiento (72 horas), rol (administrador o asesor), estado (activa o desactivada), datos de creación y última modificación.
- **Intentos fallidos**: contador de intentos fallidos seguidos y fin del bloqueo, llevados **por correo** (exista o no una cuenta con ese correo, FR-009). No pertenece a ningún taller ni guarda el correo en claro.
- **Sesión**: acceso abierto de una cuenta desde un equipo. Atributos: cuenta, taller, momento de inicio, última actividad, estado (activa, cerrada por el usuario, expirada, cerrada por desactivación, cerrada por cambio o restablecimiento de contraseña).
- **Registro de auditoría**: evidencia inmutable de cambios de rol, de activación y de restablecimientos de contraseña de cuentas (además de los eventos de la feature 001), con taller, actor y su rol, acción, cuenta afectada, valores antes y después, fecha UTC e IP o canal.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Un visitante registra su taller y queda dentro de MotorSync en menos de 3 minutos, desde un teléfono o una tablet.
- **SC-002**: Un usuario registrado inicia sesión en menos de 15 segundos desde que abre la página de inicio de sesión.
- **SC-003**: 0 casos en las pruebas en que la respuesta al inicio de sesión (mensaje o tiempo) permita distinguir un correo existente de uno inexistente o de una cuenta desactivada.
- **SC-004**: 0 casos en las pruebas en que una sesión cerrada, expirada o de una cuenta desactivada consiga ejecutar una acción.
- **SC-005**: 0 casos en las pruebas de aislamiento en que un usuario de un taller vea, modifique o afecte cuentas, sesiones o auditoría de otro taller.
- **SC-006**: El 100 % de los cambios de rol, desactivaciones, reactivaciones y restablecimientos de contraseña tiene exactamente un registro de auditoría con todos sus campos, y 0 registros de auditoría o respuestas contienen una contraseña.
- **SC-009**: 0 casos en las pruebas en que una sesión con contraseña temporal consiga ejecutar una acción distinta de cambiar la contraseña o cerrar sesión.
- **SC-007**: 0 talleres sin administrador activo y 0 correos o RUC duplicados en MotorSync, incluso con operaciones simultáneas.
- **SC-008**: El 90 % de los administradores crea una cuenta para un miembro de su equipo en su primer intento, sin ayuda.

## Assumptions

- Los roles de esta feature son solo administrador y asesor; otros roles (por ejemplo, técnico) llegarán con las features que los necesiten.
- Una cuenta pertenece a exactamente un taller durante toda su vida; no se transfiere entre talleres.
- El correo se normaliza recortando espacios al inicio y al final y pasándolo a minúsculas; no se aplican otras transformaciones (por ejemplo, puntos o sufijos `+` se respetan).
- El RUC del taller se valida con las mismas reglas que el RUC de clientes de la feature 001. El RUC del taller y el RUC de un cliente son independientes: un taller puede tener como cliente a una empresa con su mismo RUC.
- El bloqueo se aplica por correo (5 intentos fallidos seguidos, 15 minutos), es un valor por defecto razonable que el humano puede ajustar y no se registra en el registro de auditoría. El bloqueo por correo puede ser usado por un tercero para impedir temporalmente el acceso de un usuario; se acepta ese riesgo en esta feature a cambio de no revelar qué correos existen.
- El nombre comercial del taller tiene entre 2 y 120 caracteres y el nombre de la persona entre 2 y 120 caracteres.
- La contraseña mínima de 8 caracteres no exige combinaciones de mayúsculas, números o símbolos.
- La creación de cuentas se registra como metadato de creación en la propia cuenta (FR-020), no en el registro de auditoría. Al registro de auditoría van el cambio de rol, la desactivación, la reactivación y el restablecimiento de contraseña por el administrador.
- **Para el Constitution Check del plan**: el principio IV de la constitución 1.1.0 solo lista "cambios de rol de usuarios"; la desactivación, la reactivación y el restablecimiento de contraseña son eventos auditables que todavía no lista. El plan debe justificarlos como ampliación compatible con el principio o proponer la enmienda MINOR 1.2.0 correspondiente; lo decide el humano en la revisión del plan. Esta spec no modifica la constitución.
- Los inicios de sesión, los fallos, los bloqueos y el cambio de la propia contraseña no se registran en el registro de auditoría en esta feature.
- La contraseña temporal vence a las 72 horas (clarify, sesión 2026-10-22); el plazo no se renueva por intentos de inicio de sesión.
- Si el único administrador activo olvida su contraseña, el taller no puede recuperar el acceso de administrador en esta feature hasta que llegue la feature 003 (soporte de la plataforma); se acepta ese riesgo temporal.
- Editar el nombre o el correo de una cuenta y editar los datos del taller quedan fuera de alcance. Cambiar la propia contraseña y el restablecimiento por el administrador entran al alcance (clarify, sesión 2026-10-22); la recuperación de contraseña por correo sigue fuera de alcance.
- Unicidad global del correo: aunque los mensajes sean genéricos (FR-023), quien intenta registrar o crear una cuenta con un correo puede deducir que está en uso por el rechazo mismo; es inevitable con correo único en MotorSync y se acepta.
- Si la sesión expira con un formulario a medio llenar, no se garantiza conservar lo escrito.
- El acceso de desarrollo usado en la feature 001 deja de aceptarse fuera del entorno de desarrollo una vez que esta feature esté disponible.
- El registro público no tiene protección adicional contra registros automatizados (por ejemplo, desafíos anti-robots) en esta feature.
