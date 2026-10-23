# MotorSync Constitution

Reglas no negociables del proyecto. Todo `plan.md` debe pasar el "Constitution Check" contra este documento antes de implementar, y el agente `reviewer` lo usa como checklist en cada cambio.

## Core Principles

### I. Aislamiento multi-tenant (NON-NEGOTIABLE)

- Toda tabla de negocio tiene una columna `tenant_id uuid NOT NULL`, indexada y con FK a `tenants`.
- Toda tabla de negocio tiene Row-Level Security habilitada (`ENABLE` + `FORCE ROW LEVEL SECURITY`) con una política que compara `tenant_id` con `current_setting('app.tenant_id')`.
- El backend fija el tenant por transacción (`SET LOCAL app.tenant_id`) a partir del token autenticado o, en las rutas de autenticación (inicio de sesión, renovación de sesión, registro), de la credencial verificada en el servidor. Nunca lo toma del body, de la query ni de un header enviado por el cliente.
- Una lectura que cruce talleres solo se admite en funciones de base de datos acotadas a la autenticación: buscan por igualdad de un secreto o de un identificador único, devuelven las columnas mínimas y no usan un rol con `BYPASSRLS`. Cualquier otro acceso entre talleres requiere una enmienda.
- La aplicación se conecta con un rol sin `BYPASSRLS`. Las migraciones usan un rol separado.
- Cada módulo con datos de negocio tiene al menos una prueba que demuestra que el tenant A no puede leer ni modificar datos del tenant B.

**Razón:** una fuga de datos entre talleres destruye la confianza en el SaaS. El filtro en la aplicación es la primera barrera y RLS la segunda, para que un olvido no exponga datos.

### II. Test-First (NON-NEGOTIABLE)

- No se escribe código de producción sin una prueba que falle primero (Red → Green → Refactor).
- Las pruebas se derivan de los criterios de aceptación de `spec.md`. Cada criterio tiene al menos una prueba que lo referencia por su ID.
- Una prueba en rojo se arregla cambiando el código de producción, no la prueba. Modificar una prueba requiere justificarlo en el PR y que un humano lo apruebe.
- Backend: unitarias y e2e con Vitest; los e2e corren contra PostgreSQL real (contenedor), no contra mocks de la base. Frontend: unitarias de componentes y servicios con Vitest (jsdom), sin navegador ni modo watch.

**Razón:** las pruebas son la especificación ejecutable y el principal mecanismo de retroalimentación para los agentes de IA. Si se pueden editar para que pasen, dejan de proteger.

### III. Especificación y contratos primero

- Ninguna feature se implementa sin `spec.md`, `plan.md` y `tasks.md` en `specs/<feature>/`, aprobados por un humano.
- Los contratos de API (OpenAPI en `specs/<feature>/contracts/`) se definen en el plan, antes de implementar. Frontend y backend trabajan en paralelo contra el contrato.
- Un cambio de contrato pasa primero por la spec y después por el código.
- Las specs se escriben en términos de negocio (qué y por qué). El stack y el cómo van en `plan.md`.

**Razón:** con dos desarrolladores y varios agentes trabajando en paralelo, el contrato es la única fuente de verdad que evita integraciones rotas.

### IV. Auditoría inmutable

- Estos eventos se registran en `audit_log`: cambio de precio en un presupuesto aprobado, salida manual de inventario, anulación de OT, cambio de estado de OT, aceptación o rechazo de presupuesto por el cliente, cambios de rol de usuarios, desactivación y reactivación de cuentas de usuario, restablecimiento de contraseñas por un administrador, transferencia de un vehículo a otro propietario, y modificación de identificadores (placa, VIN, documento del cliente).
- Cada registro guarda `tenant_id`, actor y su rol, acción, entidad, id, valores antes y después (JSON), fecha y hora (UTC), IP o canal, y el motivo cuando la acción lo exige.
- `audit_log` es append-only: el rol de aplicación solo tiene `INSERT` y `SELECT`. No existe endpoint para editar ni borrar registros.
- La auditoría se escribe en la misma transacción que el cambio auditado.

**Razón:** las principales pérdidas del taller (fuga de inventario, reclamos, presupuestos discutidos) se resuelven con evidencia que nadie pueda alterar después.

### V. Simplicidad y tipado estricto

- TypeScript con `strict: true` en backend y frontend. `any` está prohibido salvo en límites con librerías externas, y con un comentario que lo justifique.
- Los DTOs se validan en el borde (class-validator en NestJS). No se confía en datos del cliente.
- YAGNI: no se agrega una abstracción, librería o servicio que la spec actual no necesite. Toda complejidad extra se justifica en la tabla "Complexity Tracking" del plan.
- Dinero en `numeric(12,2)` (nunca `float`) y fechas en `timestamptz` (UTC).

**Razón:** el código lo escriben en buena parte agentes. El tipado estricto y la simplicidad hacen que sus errores salten en compilación y en revisión, no en producción.

## Restricciones técnicas

- **Stack:** Angular (PWA) en `frontend/`, NestJS en `backend/`, PostgreSQL 16, en un monorepo.
- **Rendimiento:** la búsqueda por placa, cédula/RUC o VIN responde en menos de 200 ms (p95) con índices dedicados por `(tenant_id, columna)`.
- **Móvil en bahía:** las pantallas operativas (check-in, tablero de técnicos) son usables en tablets y teléfonos de gama media, con objetivos táctiles de al menos 44 px. Las imágenes se comprimen en el cliente antes de subir.
- **Identificadores:** las placas y los VIN se guardan normalizados (mayúsculas, sin espacios ni guiones), con unicidad por tenant.
- **Secretos:** nunca en el repositorio. Se usa `.env` local y GitHub Secrets en CI.

## Flujo de desarrollo y arnés de agentes

- `main` está protegida: todo entra por Pull Request con 1 aprobación humana y CI en verde. No hay push directo ni force push.
- Ramas cortas (`feat/`, `fix/`, `chore/`, `ci/`, `docs/`) y Conventional Commits. Cada PR referencia su issue (`Closes #N`).
- Ciclo por feature: `spec → clarify → plan → tasks → issues → test rojo → código → reviewer → PR → CI → merge`.
- Roles de agentes (`.claude/agents/`): `spec-writer` solo escribe en `specs/`; `tester` solo escribe pruebas; los `implementer-*` no modifican pruebas; `reviewer` es de solo lectura. Estas restricciones se imponen con hooks deterministas (`.claude/hooks/`), no solo con instrucciones.
- Hay dos puntos de control humano obligatorios: aprobar spec y plan antes de implementar, y aprobar el merge del PR.

## Governance

- Esta constitución prevalece sobre cualquier otra guía, prompt o costumbre. `CLAUDE.md` y los prompts de los agentes deben ser coherentes con ella.
- Una enmienda requiere un PR propio (`docs: amend constitution …`) aprobado por ambos integrantes, con la versión incrementada según SemVer: MAJOR si elimina o redefine un principio, MINOR si agrega uno o lo amplía, PATCH si solo aclara redacción.
- Todo PR se revisa contra esta constitución. Una violación se justifica en el plan ("Complexity Tracking") o bloquea el merge.

**Version**: 1.2.0 | **Ratified**: 2026-10-21 | **Last Amended**: 2026-10-23
