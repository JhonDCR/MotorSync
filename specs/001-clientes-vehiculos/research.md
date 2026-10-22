# Research: Registro de clientes y vehículos (001-clientes-vehiculos)

Fase 0 del plan. Cada decisión sigue el formato Decision / Rationale / Alternatives considered. Todas las incógnitas del Technical Context quedan resueltas aquí.

---

## R1. Capa de acceso a datos compatible con RLS por transacción

**Decision**: TypeORM 0.3.x con `@nestjs/typeorm` y el driver `pg`. Cada request autenticado abre un `QueryRunner`, inicia la transacción, ejecuta `SELECT set_config('app.tenant_id', $1, true)` (equivalente a `SET LOCAL`) y guarda el `EntityManager` de esa transacción en un `AsyncLocalStorage` (módulo nativo `node:async_hooks`). Los servicios toman siempre el manager del contexto, nunca el `DataSource` global. Las búsquedas usan `manager.query()` con SQL parametrizado; las escrituras simples usan el repositorio del manager. `synchronize` está siempre en `false`; las migraciones son clases TypeScript con SQL explícito (`queryRunner.query(...)`) versionadas en `backend/src/database/migrations/`.

**Rationale**:
- Integración oficial con Nest (módulo, inyección del `DataSource`), mantenida y documentada.
- `QueryRunner` da control explícito de la conexión y la transacción. Es justo lo que pide el principio I: `set_config(..., true)` y todas las consultas del request en la misma conexión y la misma transacción.
- Las migraciones admiten SQL crudo sin fricción, necesario para `ENABLE/FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, `GRANT/REVOKE`, extensiones, columnas generadas e índices GIN.
- La auditoría puede escribirse con el mismo manager, así queda en la misma transacción (principio IV) sin mecanismos extra.
- Recomendación del leader; no aparece una razón fuerte para descartarla.

**Alternatives considered**:
- **Prisma**: el `SET LOCAL` exige transacciones interactivas o extensiones de cliente por request, y un `$transaction` con callback por cada request penaliza el pool. Las políticas RLS y las columnas generadas con funciones propias quedan fuera de su DSL (se escriben como SQL en migraciones "custom", pero el esquema Prisma deja de ser la fuente de verdad). Además añade un paso de generación de cliente al build y al CI. Se descarta.
- **Kysely**: query builder tipado, excelente para SQL crudo y transacciones explícitas, con migraciones en TS. No tiene integración oficial con Nest (habría que escribir el provider) y los tipos de las tablas se mantienen a mano o con un generador. Es técnicamente válido y sería la segunda opción. Se descarta para no sumar integración propia cuando TypeORM cubre el caso.
- **`pg` sin capa**: máximo control y cero magia, pero obliga a escribir mapeo, migraciones y runner propios. Es YAGNI al revés: más código propio que mantener.

**Notas de compatibilidad (ESM + Vitest)**:
- El backend es ESM (`"type": "module"`, `module: nodenext`). TypeORM 0.3 se publica como CommonJS, pero se importa desde ESM con `import { DataSource } from 'typeorm'` gracias a la interoperabilidad de Node. Las entidades y migraciones se registran **por referencia a la clase** (arrays importados), no por globs de rutas, para evitar los problemas de carga dinámica de TypeORM en ESM.
- Las columnas declaran siempre `type` explícito en `@Column`, para no depender de `emitDecoratorMetadata` al transpilar con Vitest.
- Las migraciones se ejecutan con un runner propio mínimo (`backend/src/database/migrate.ts`) que crea el `DataSource` con el rol de migraciones y llama a `runMigrations()`. En desarrollo y CI se ejecuta tras `npm run build` (`node dist/src/database/migrate.js`), y en las e2e desde el `globalSetup` de Vitest. Así no hace falta `ts-node`.

---

## R2. Roles de base de datos (principio I)

**Decision**: tres roles con responsabilidades separadas.

| Rol | Uso | Atributos |
|---|---|---|
| `POSTGRES_USER` (superusuario del contenedor) | Solo el script de bootstrap: crea roles, base y extensiones. | El que trae la imagen; nunca lo usa la aplicación. |
| `motorsync_migrator` | Ejecuta migraciones; es dueño del esquema y de las tablas. | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE`. |
| `motorsync_app` | Conexión de la API en runtime. | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOINHERIT`; no es dueño de ninguna tabla. |

- El bootstrap (`backend/db/bootstrap.sql`, ejecutado por `npm run db:bootstrap`, que usa `DATABASE_ADMIN_URL`) es idempotente: crea los roles si no existen, fija sus contraseñas desde variables de entorno, crea las extensiones `pg_trgm`, `unaccent` y `btree_gin`, da `CONNECT` y `USAGE` y entrega el esquema `public` a `motorsync_migrator`.
- Las migraciones (como `motorsync_migrator`) conceden a `motorsync_app` solo `SELECT, INSERT, UPDATE` en las tablas de negocio y `SELECT, INSERT` en `audit_log`. Ningún rol de aplicación tiene `DELETE` ni `TRUNCATE`: coherente con FR-021 (sin borrado) y con el carácter append-only de la auditoría.
- `FORCE ROW LEVEL SECURITY` en todas las tablas de negocio hace que la política se aplique incluso al dueño (`motorsync_migrator`), como defensa adicional.
- **Local**: `docker compose up -d`, luego `npm run db:bootstrap` y `npm run db:migrate`. Las contraseñas de los roles vienen de `.env` (`DB_APP_PASSWORD`, `DB_MIGRATOR_PASSWORD`), que se añaden a `.env.example` con valores de desarrollo.
- **CI**: el service `postgres:16-alpine` ya existente actúa como admin. Se añaden los pasos `npm run db:bootstrap` y `npm run db:migrate` antes de `test:e2e`, y las variables `DATABASE_ADMIN_URL`, `DATABASE_MIGRATOR_URL` y `DATABASE_URL` (rol app). Las contraseñas de CI son de una base efímera, como la `motorsync_ci` actual. `JWT_SECRET` se genera en el propio job (`openssl rand -hex 32`), así no se versiona ningún secreto.
- Las pruebas e2e preparan y limpian datos con una conexión de `motorsync_migrator` (fixtures: `INSERT` de tenants y `TRUNCATE` entre suites). La API bajo prueba usa siempre `motorsync_app`.

**Rationale**: cumple literalmente el principio I (app sin `BYPASSRLS`, migraciones con rol separado) y deja al superusuario fuera del camino de la aplicación.

**Alternatives considered**: scripts en `docker-entrypoint-initdb.d` (solo corren con el volumen vacío y no sirven para CI con services); crear los roles dentro de una migración (exige que el migrador tenga `CREATEROLE`, lo que amplía sus privilegios).

---

## R3. Contexto de tenant y autenticación mínima

**Decision**: JWT HS256 verificado por un guard global, con `@nestjs/jwt`.

- Claims: `sub` (id de usuario, uuid), `tenant_id` (uuid), `role` (`asesor` | `admin`), `name` (nombre para mostrar, usado en auditoría y en "última modificación por") y `exp`.
- El secreto viene de `JWT_SECRET` (mínimo 32 caracteres). La API no arranca si falta. Solo se acepta `alg: HS256`.
- `JwtAuthGuard` (global) rechaza con 401 cualquier request sin token válido. El `TenantTransactionInterceptor` lee `tenant_id`, `sub` y `role` **solo** del token verificado y abre la transacción con `set_config('app.tenant_id', tenant_id, true)`.
- El `ValidationPipe` global usa `whitelist: true, forbidNonWhitelisted: true`: un `tenant_id` en el body provoca 400. Las cabeceras como `X-Tenant-Id` se ignoran (hay una prueba que lo demuestra).
- **Desarrollo y pruebas**: `npm run token:dev -- --tenant <uuid> --role asesor|admin [--name "Ana"]` imprime un token firmado con `JWT_SECRET`. Las e2e usan un helper `issueTestToken()` que hace lo mismo. No hay login, ni endpoint de emisión, ni tabla de usuarios: la autenticación real es una feature posterior.
- **Frontend**: un `HttpInterceptor` añade `Authorization: Bearer <token>`. El token de desarrollo se pega una vez en una pantalla mínima `/dev-token` y se guarda en `localStorage`; esa pantalla solo existe en la configuración de desarrollo.

**Rationale**: es el mecanismo más pequeño que cumple el principio I (tenant derivado de un token autenticado y nunca de datos del cliente) y que se sustituirá sin cambiar los módulos de negocio, porque estos solo dependen del contexto (tenant, usuario, rol).

**Alternatives considered**: cabecera `X-Tenant-Id` en desarrollo (prohibido por la constitución, aunque sea temporal); RS256 con JWKS (sin emisor real todavía, es YAGNI); Passport (`@nestjs/passport` añade una capa que no hace falta para un único esquema bearer).

---

## R4. Búsqueda por placa, documento, VIN y nombre (< 200 ms p95)

**Decision**:
- **Columnas normalizadas** (`plate`, `vin`, `document_number`) con `COLLATE "C"`: la comparación es binaria y el índice B-tree estándar sirve para igualdad y para prefijo (`LIKE 'ABC%'`) sin `text_pattern_ops`.
- **Unicidad e igualdad**: índices únicos B-tree `(tenant_id, plate)`, `(tenant_id, document_number)` y un único parcial `(tenant_id, vin) WHERE vin IS NOT NULL`. Además cumplen la regla de la constitución de índices dedicados por `(tenant_id, columna)`.
- **Búsqueda parcial ("contiene")** para placa, documento y nombre: índices GIN con `btree_gin` + `pg_trgm`, como `(tenant_id, plate gin_trgm_ops)`. Incluir `tenant_id` en el GIN hace que incluso con 2 caracteres (cuando `pg_trgm` no puede extraer trigramas útiles) el índice limite la búsqueda a las filas del taller (≤ 50 000) en lugar de recorrer la tabla completa de todos los talleres.
- **Nombre sin tildes**: columna generada `search_name = public.immutable_unaccent(lower(display_name))`, con un índice GIN `(tenant_id, search_name gin_trgm_ops)`. La función `immutable_unaccent` envuelve `unaccent('public.unaccent', $1)` y se declara `IMMUTABLE`, porque `unaccent()` es `STABLE` y no se puede usar en columnas generadas ni índices. El término de búsqueda pasa por la misma función.
- **Orden de relevancia** (FR-003): `ORDER BY CASE WHEN plate = $q THEN 0 WHEN plate LIKE $q || '%' THEN 1 ELSE 2 END, plate LIMIT 21`. Si vuelven 21 filas, se devuelven 20 con `hasMore: true`.
- **VIN**: solo igualdad con el VIN completo (clarify). Si el término normalizado tiene la forma de VIN (17 caracteres válidos), la consulta añade `OR vin = $q`.
- El escape de `%`, `_` y `\` no es necesario: la normalización deja solo `[A-Z0-9]` en placa, VIN y documento, y en el nombre se escapan antes de usar `LIKE`.

**Rationale**: `pg_trgm` es la única opción indexada para "contiene" (US1-AC3 exige que `BA12` encuentre `PBA1234`); el prefijo B-tree solo no basta. `btree_gin`, `pg_trgm` y `unaccent` vienen con PostgreSQL 16 y son extensiones *trusted*, sin dependencias externas.

**Alternatives considered**:
- Solo B-tree con `text_pattern_ops`: resuelve exacto y prefijo, pero no "contiene". Se descarta.
- Full-text search (`tsvector`): pensado para palabras, no sirve para fragmentos de placa. Se descarta.
- Normalizar el nombre en la aplicación (quitar diacríticos con `String.normalize('NFD')`): duplica la regla entre capas y puede desalinearse del término de búsqueda. Se prefiere la columna generada.
- Motor externo (Elasticsearch, Meilisearch): prohibido por YAGNI.

**Cómo se prueba el rendimiento** (FR-005, SC-001, US1-AC10):
- `backend/test/perf/seed-volume.sql` genera con `generate_series` 10 talleres con 30 000 clientes y 50 000 vehículos cada uno (placas, documentos y VIN válidos y únicos, y nombres con tildes). Tarda segundos.
- `backend/test/perf/search.perf-spec.ts` (config `vitest.config.perf.ts`, script `npm run test:perf`) levanta la app en proceso y ejecuta 300 búsquedas por tipo (placa exacta, placa parcial de 2 a 4 caracteres, documento, VIN y nombre) con tokens de distintos talleres. Mide cada request con `performance.now()`, una cota superior del tiempo de servidor porque incluye la pila HTTP en proceso, y falla si el p95 de placa, documento o VIN es ≥ 200 ms. El nombre se reporta, pero no bloquea, porque la spec no le fija umbral.
- Se ejecuta en CI como paso propio del job `backend`, después de `test:e2e`.
- Una prueba adicional ejecuta `EXPLAIN (FORMAT JSON)` de las consultas de búsqueda sobre la base sembrada y verifica que no aparece `Seq Scan` sobre `vehicles` ni `clients`.

---

## R5. Concurrencia de ediciones (US4-AC12) y duplicados simultáneos

**Decision**:
- Columna `version integer NOT NULL DEFAULT 1` en `clients` y `vehicles`. `PATCH` y las transferencias reciben `version` en el body y ejecutan `UPDATE ... SET ..., version = version + 1 WHERE id = $1 AND version = $2 RETURNING *`.
- Si no se actualiza ninguna fila, se distingue: si el registro no es visible → 404; si existe con otra versión → `409 VERSION_CONFLICT`, con el recurso actual en el cuerpo del error para que el frontend lo muestre.
- **Duplicados simultáneos** (SC-006): los índices únicos son la garantía. El error PostgreSQL `23505` se traduce, según el nombre del índice, a `409 PLATE_ALREADY_EXISTS`, `DOCUMENT_ALREADY_EXISTS` o `VIN_ALREADY_EXISTS`, con el `existingId` del registro del **mismo taller** (consultado bajo RLS después del conflicto). Como el índice incluye `tenant_id`, nunca hay conflicto con otro taller, así que el error no revela nada (FR-024).
- **Reintentos por red**: no se añaden claves de idempotencia. Si se reintenta el alta, el segundo intento recibe 409 con `existingId` y el frontend ofrece abrir el registro existente.

**Rationale**: el bloqueo optimista es el mecanismo más simple que da un 409 claro, sin bloqueos largos y sin estado en el servidor.

**Alternatives considered**: `@VersionColumn` de TypeORM (verifica tarde, en el `save`, y no permite devolver el recurso actual con la misma claridad); `ETag` / `If-Match` (más REST, pero añade manejo de cabeceras en ambos lados sin beneficio para esta spec); `SELECT ... FOR UPDATE` (bloqueo pesimista: innecesario para ediciones humanas poco frecuentes).

---

## R6. Auditoría e historial de propietarios

**Decision**:
- Tabla única `audit_log` (append-only: el rol app solo tiene `INSERT, SELECT`; con RLS). Columnas: `tenant_id`, `actor_user_id`, `actor_name`, `actor_role`, `action`, `entity_type`, `entity_id`, `before` (jsonb), `after` (jsonb), `reason`, `occurred_at` (timestamptz, `now()`), `ip`, `channel`.
- Acciones de esta feature: `vehicle.owner_changed`, `vehicle.plate_changed`, `vehicle.vin_changed` y `client.document_changed`.
- `AuditService.record(entry)` escribe con el `EntityManager` de la transacción del request, así el cambio y su auditoría se confirman o se revierten juntos (US4-AC9).
- **Historial de propietarios** (US4-AC10): se obtiene de `audit_log` filtrando `entity_type='vehicle' AND entity_id=$1 AND action='vehicle.owner_changed' ORDER BY occurred_at DESC`, con el índice `(tenant_id, entity_type, entity_id, occurred_at DESC)`. `before` y `after` guardan `ownerClientId`, `ownerDisplayName` y `ownerDocumentNumber` como foto del momento. No se crea una tabla aparte.
- Un trigger `BEFORE UPDATE OR DELETE` en `audit_log` lanza una excepción: defensa en profundidad además de los `GRANT`.

**Rationale**: una sola fuente de verdad, inmutable por permisos. El historial no puede divergir de la auditoría porque es la auditoría.

**Alternatives considered**: tabla `vehicle_ownership_history` además de `audit_log` (duplica datos y abre la puerta a inconsistencias); auditoría por triggers genéricos (no conoce actor, rol, motivo ni IP sin pasar más `set_config`, y audita también lo que la spec no pide).

---

## R7. Validación de identificadores de Ecuador

**Decision**: funciones puras sin dependencias, con la misma tabla de vectores de prueba en backend (`backend/src/common/identifiers/`) y frontend (`frontend/src/app/shared/identifiers/`).

- **Normalización**: mayúsculas, sin espacios ni guiones. En el alta y la edición, cualquier otro carácter no alfanumérico produce error (FR-002); en la búsqueda se descarta.
- **Placa** (FR-007): carrocería `motorcycle` → `^[A-Z]{2}[0-9]{3}[A-Z]$`; resto → `^[A-Z]{3}[0-9]{3,4}$`. Solo se valida la forma (no la provincia).
- **VIN**: `^[A-HJ-NPR-Z0-9]{17}$` (sin I, O ni Q). No se valida el dígito de control de la posición 9, porque la spec no lo pide y muchos VIN no norteamericanos no lo usan.
- **Cédula**: `^\d{10}$`; provincia 01–24 o 30; tercer dígito 0–5; dígito verificador módulo 10 (coeficientes 2,1,2,1,2,1,2,1,2, restando 9 a los productos mayores que 9).
- **RUC**: `^\d{13}$`, terminado en `001`, provincia 01–24 o 30, y según el tercer dígito:
  - 0–5 (persona natural): los 10 primeros dígitos son una cédula válida.
  - 9 (sociedad privada) o 6 (entidad pública): se valida la estructura (provincia, tercer dígito y sufijo) **sin** dígito verificador módulo 11. El SRI ha emitido RUC de sociedades válidos que no cumplen el módulo 11, y rechazarlos bloquearía clientes reales. Aprobado por el humano el 2026-10-21 (P1 del plan).
- **Pasaporte**: `^[A-Z0-9]{5,20}$`.
- **Teléfono**: se quitan espacios, guiones y paréntesis; `^\+?\d{7,15}$`.
- **Correo**: validador estándar de `class-validator` (`IsEmail`) en el backend y `Validators.email` en el frontend.

**Rationale**: las reglas son pequeñas y estables. Una librería externa no aporta lo suficiente (YAGNI). Duplicar la lógica en frontend y backend es aceptable porque ambas capas se prueban con los mismos vectores y el backend es la autoridad.

**Alternatives considered**: paquete compartido en el monorepo (añade configuración de workspaces y build para unas 150 líneas; se reconsiderará si crece); librerías npm de validación de cédula (mantenimiento incierto y no cubren placas).

---

## R8. Frontend contra el contrato con mocks

**Decision**:
- Los tipos del contrato se escriben a mano en `frontend/src/app/core/api/api.models.ts`, reflejando `contracts/openapi.yaml`.
- Un `mockApiInterceptor` (`frontend/src/app/core/api/mock-api.interceptor.ts`) con datos en memoria implementa los endpoints del contrato, incluidos los errores 400, 404, 409 y 422. Se activa con el token de inyección `USE_MOCK_API`, que está en `true` en la configuración `mock` de `angular.json` (`ng serve --configuration mock`) y en `false` en el resto.
- Las pruebas unitarias de servicios usan `HttpTestingController`. Las de componentes simulan los servicios.
- Contra el backend real, el dev server usa `proxy.conf.json` (`/api` → `http://localhost:3000`).

**Rationale**: permite que el frontend avance en paralelo (principio III) sin añadir dependencias (MSW, json-server).

**Alternatives considered**: MSW (otra dependencia y un service worker en desarrollo); generar tipos con `openapi-typescript` (otra dependencia y un paso de build; se reconsiderará cuando haya más contratos).

---

## R9. Usabilidad en recepción (FR-025, FR-026)

**Decision**: componentes standalone con SCSS propio, sin librería de UI. Diseño mobile-first desde 360 px, con objetivos táctiles de al menos 44 × 44 px (variable SCSS común), `inputmode`/`autocapitalize` adecuados (placa en mayúsculas) y búsqueda mientras se escribe (`debounceTime(250)` + `switchMap` para cancelar la petición anterior). La búsqueda por placa es la ruta inicial (`/`).

**Rationale**: con tres o cuatro pantallas no hace falta una librería de componentes (YAGNI) y así se controla el tamaño del bundle (presupuesto inicial de 500 kB).

**Alternatives considered**: Angular Material (tamaño, estilos y una dependencia que la spec no necesita); Ionic (orientado a apps nativas, fuera de alcance).

---

## Hallazgo durante la implementación (T032, 2026-10-21): RLS impide usar los índices trigram

Con `FORCE ROW LEVEL SECURITY`, el planner de PostgreSQL no lleva un `LIKE '%…%'` a la condición del índice GIN trigram, porque el operador `~~` (`textlike`) no es `LEAKPROOF` y no puede evaluarse antes que la política. El índice solo se usa por `tenant_id` y el `LIKE` queda como filtro, así que la búsqueda recorre todos los registros del taller.

- Medición (implementer-backend, 10 talleres × 20 000 clientes): como superusuario, unos 0,8 ms usando `clients_tenant_search_name_trgm_idx`; como `motorsync_app` con RLS, de 11 a 18 ms recorriendo el taller.
- No depende de cómo se escriba la consulta ni de los parámetros (pasa también con literales).
- **Riesgo para el PR2 (US1-AC10 / SC-001, < 200 ms p95):** la búsqueda de vehículos por placa parcial usa el mismo patrón. T059/T060 deben medirlo con el volumen de SC-001 antes de decidir.
- Opciones si no alcanza, todas con aprobación humana porque tocan seguridad: (a) aceptar el recorrido por taller si el p95 cumple; (b) una función `SECURITY DEFINER` de búsqueda que filtre explícitamente por `app_current_tenant()`; (c) un wrapper `LEAKPROOF` de `LIKE`, que exige superusuario y cuyo análisis de fuga recae sobre nosotros.

**Medición y decisión (T059, 2026-10-21):** con el volumen de SC-001 (10 talleres × 30 000 clientes y 50 000 vehículos), 300 búsquedas por tipo como `motorsync_app`:

| Tipo | p50 | p95 | p99 |
|---|---|---|---|
| Placa exacta | 15 ms | 20 ms | 22 ms |
| Placa parcial (2–4) | 16 ms | 20 ms | 25 ms |
| Documento | 12 ms | 13 ms | 15 ms |
| VIN | 13 ms | 15 ms | 16 ms |
| Nombre | 12 ms | 14 ms | 15 ms |

Sin `Seq Scan`: los planes usan los índices compuestos, pero solo filtran por `tenant_id`, y el `LIKE` se evalúa sobre las filas del taller. El p95 queda unas 10 veces por debajo del umbral, así que se adopta la **opción (a)**: aceptar el recorrido por taller, sin cambios de seguridad. `npm run test:perf` corre en CI para detectar si eso deja de cumplirse al crecer los datos o cambiar las consultas.
