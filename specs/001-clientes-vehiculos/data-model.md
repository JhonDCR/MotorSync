# Data Model: Registro de clientes y vehículos (001-clientes-vehiculos)

PostgreSQL 16. Todo el DDL de este documento lo ejecutan las migraciones como `motorsync_migrator`. El bootstrap previo (roles y extensiones) está en [research.md](./research.md#r2-roles-de-base-de-datos-principio-i). Los nombres de tablas y columnas están en inglés (convención del repo); los términos de la spec se indican entre paréntesis.

## Resumen de entidades

| Entidad (spec) | Tabla | Tenant-scoped | RLS | Privilegios de `motorsync_app` |
|---|---|---|---|---|
| Taller | `tenants` | No (es el tenant) | No | Ninguno |
| Cliente | `clients` | Sí | `ENABLE` + `FORCE` | `SELECT, INSERT, UPDATE` |
| Vehículo | `vehicles` | Sí | `ENABLE` + `FORCE` | `SELECT, INSERT, UPDATE` |
| Registro de auditoría / Cambio de propietario | `audit_log` | Sí | `ENABLE` + `FORCE` | `SELECT, INSERT` |

Ningún rol de aplicación tiene `DELETE` ni `TRUNCATE` (FR-021, principio IV).

## Valores enumerados

| Campo | Valores (API y BD) | Etiqueta en UI |
|---|---|---|
| `client_type` | `natural`, `company` | Persona natural, Empresa |
| `document_type` | `cedula`, `ruc`, `passport` | Cédula, RUC, Pasaporte |
| `body_type` | `sedan`, `suv`, `pickup`, `motorcycle`, `other` | Sedán, SUV, Pickup, Moto, Otro |
| `actor_role` (token) | `asesor`, `admin` | Asesor, Administrador |
| `audit_log.action` | `vehicle.owner_changed`, `vehicle.plate_changed`, `vehicle.vin_changed`, `client.document_changed` | — |

## Reglas de validación (fuente: spec FR-002, FR-006 a FR-013, FR-019)

| Campo | Normalización | Regla | Error (`code`) |
|---|---|---|---|
| `plate` | Mayúsculas; se quitan espacios y guiones; cualquier otro carácter no alfanumérico → error | `motorcycle`: `^[A-Z]{2}[0-9]{3}[A-Z]$`; resto: `^[A-Z]{3}[0-9]{3,4}$` | `INVALID_PLATE` |
| `vin` (opcional) | Igual que la placa | `^[A-HJ-NPR-Z0-9]{17}$` | `INVALID_VIN` |
| `document_number` | Se quitan espacios y guiones; mayúsculas | Cédula, RUC o pasaporte según [research R7](./research.md#r7-validación-de-identificadores-de-ecuador) | `INVALID_CEDULA`, `INVALID_RUC`, `INVALID_PASSPORT` |
| `client_type` + `document_type` | — | `company` solo admite `ruc` | `INVALID_DOCUMENT_TYPE` |
| `first_names`, `last_names` | `trim` | Obligatorios si `natural`, de 1 a 100 caracteres | `VALIDATION_ERROR` |
| `business_name` | `trim` | Obligatorio si `company`, de 1 a 200 caracteres | `VALIDATION_ERROR` |
| `phone` | Se quitan espacios, guiones y paréntesis | `^\+?\d{7,15}$` | `INVALID_PHONE` |
| `email` (opcional) | `trim`, minúsculas | Formato de correo | `INVALID_EMAIL` |
| `brand`, `model`, `color` | `trim` | De 1 a 60 caracteres | `VALIDATION_ERROR` |
| `year` | — | Entero entre 1950 y el año UTC en curso + 1 | `INVALID_YEAR` |
| `initial_mileage` | — | Entero entre 0 y 9 999 999 | `INVALID_MILEAGE` |
| `reason` | `trim` | De 10 a 500 caracteres; obligatorio si el rol es `asesor` y la operación es una transferencia o un cambio de placa, VIN o documento | `REASON_REQUIRED` |

## DDL

### Funciones auxiliares (migración `CreateTenantsAndHelpers`)

```sql
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Tenant de la transacción actual. NULL si no se fijó, y entonces la política no deja ver ninguna fila.
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- unaccent() es STABLE; este envoltorio IMMUTABLE permite usarlo en columnas generadas e índices.
CREATE FUNCTION immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

GRANT EXECUTE ON FUNCTION app_current_tenant(), immutable_unaccent(text) TO motorsync_app;
```

### `clients` (Cliente), migración `CreateClients`

```sql
CREATE TABLE clients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
  client_type      text NOT NULL CHECK (client_type IN ('natural', 'company')),
  document_type    text NOT NULL CHECK (document_type IN ('cedula', 'ruc', 'passport')),
  document_number  text COLLATE "C" NOT NULL CHECK (document_number ~ '^[A-Z0-9]{5,20}$'),
  first_names      text,
  last_names       text,
  business_name    text,
  display_name     text GENERATED ALWAYS AS (
                     CASE WHEN client_type = 'company' THEN business_name
                          ELSE first_names || ' ' || last_names END) STORED,
  search_name      text GENERATED ALWAYS AS (
                     immutable_unaccent(lower(
                       CASE WHEN client_type = 'company' THEN business_name
                            ELSE first_names || ' ' || last_names END))) STORED,
  phone            text NOT NULL CHECK (phone ~ '^\+?[0-9]{7,15}$'),
  email            text,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NOT NULL,
  updated_by_name  text NOT NULL,
  CONSTRAINT clients_company_requires_ruc
    CHECK (client_type <> 'company' OR document_type = 'ruc'),
  CONSTRAINT clients_names_by_type CHECK (
    (client_type = 'natural' AND first_names IS NOT NULL AND last_names IS NOT NULL)
    OR (client_type = 'company' AND business_name IS NOT NULL)),
  CONSTRAINT clients_tenant_id_id_key UNIQUE (tenant_id, id)   -- destino de FK compuestas
);

CREATE INDEX clients_tenant_id_idx ON clients (tenant_id);
CREATE UNIQUE INDEX clients_tenant_document_key ON clients (tenant_id, document_number);  -- FR-009, búsqueda exacta y por prefijo
CREATE INDEX clients_tenant_document_trgm_idx ON clients USING gin (tenant_id, document_number gin_trgm_ops);
CREATE INDEX clients_tenant_search_name_trgm_idx ON clients USING gin (tenant_id, search_name gin_trgm_ops);

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
CREATE POLICY clients_tenant_isolation ON clients
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON clients TO motorsync_app;
```

### `vehicles` (Vehículo), migración `CreateVehicles`

```sql
CREATE TABLE vehicles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
  owner_client_id  uuid NOT NULL,
  plate            text COLLATE "C" NOT NULL,
  vin              text COLLATE "C" CHECK (vin IS NULL OR vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  brand            text NOT NULL,
  model            text NOT NULL,
  year             smallint NOT NULL CHECK (year >= 1950),           -- el tope (año + 1) lo valida la API
  color            text NOT NULL,
  body_type        text NOT NULL CHECK (body_type IN ('sedan', 'suv', 'pickup', 'motorcycle', 'other')),
  initial_mileage  integer NOT NULL CHECK (initial_mileage BETWEEN 0 AND 9999999),
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NOT NULL,
  updated_by_name  text NOT NULL,
  -- Defensa en profundidad de FR-007: la placa cumple el formato de su carrocería.
  CONSTRAINT vehicles_plate_format CHECK (
    (body_type = 'motorcycle' AND plate ~ '^[A-Z]{2}[0-9]{3}[A-Z]$')
    OR (body_type <> 'motorcycle' AND plate ~ '^[A-Z]{3}[0-9]{3,4}$')),
  -- FK compuesta: el propietario es siempre del mismo taller (las comprobaciones de FK ignoran RLS).
  CONSTRAINT vehicles_owner_same_tenant_fk
    FOREIGN KEY (tenant_id, owner_client_id) REFERENCES clients (tenant_id, id)
);

CREATE INDEX vehicles_tenant_id_idx ON vehicles (tenant_id);
CREATE UNIQUE INDEX vehicles_tenant_plate_key ON vehicles (tenant_id, plate);                       -- FR-012, exacta y prefijo
CREATE UNIQUE INDEX vehicles_tenant_vin_key ON vehicles (tenant_id, vin) WHERE vin IS NOT NULL;     -- FR-013, búsqueda por VIN
CREATE INDEX vehicles_tenant_plate_trgm_idx ON vehicles USING gin (tenant_id, plate gin_trgm_ops);  -- "contiene"
CREATE INDEX vehicles_tenant_owner_idx ON vehicles (tenant_id, owner_client_id);                    -- vehículos de un cliente

ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles FORCE ROW LEVEL SECURITY;
CREATE POLICY vehicles_tenant_isolation ON vehicles
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON vehicles TO motorsync_app;
```

### `audit_log` (Registro de auditoría), migración `CreateAuditLog`

```sql
CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
  actor_user_id  uuid NOT NULL,
  actor_name     text NOT NULL,
  actor_role     text NOT NULL CHECK (actor_role IN ('asesor', 'admin')),
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,
  before         jsonb,
  after          jsonb,
  reason         text CHECK (reason IS NULL OR length(reason) BETWEEN 10 AND 500),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  ip             text,
  channel        text NOT NULL DEFAULT 'web',
  -- Refuerza FR-019 en la base: un asesor siempre deja motivo.
  CONSTRAINT audit_log_asesor_reason CHECK (actor_role <> 'asesor' OR reason IS NOT NULL)
);

CREATE INDEX audit_log_tenant_id_idx ON audit_log (tenant_id);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id, occurred_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT ON audit_log TO motorsync_app;   -- append-only (principio IV)

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
```

> La restricción `audit_log_asesor_reason` aplica solo a las acciones de esta feature. Si una feature futura audita acciones de asesor sin motivo (por ejemplo, cambios de estado de OT), esa migración deberá relajarla o hacerla depender de `action`.

### Contenido de `before` y `after` por acción

| `action` | `entity_type` | `before` / `after` (claves JSON, camelCase) |
|---|---|---|
| `vehicle.owner_changed` | `vehicle` | `{ "ownerClientId", "ownerDisplayName", "ownerDocumentNumber" }` |
| `vehicle.plate_changed` | `vehicle` | `{ "plate" }` |
| `vehicle.vin_changed` | `vehicle` | `{ "vin" }` (puede ser `null`) |
| `client.document_changed` | `client` | `{ "documentType", "documentNumber" }` |

Un `PATCH` que cambia placa y VIN a la vez genera dos registros en la misma transacción, con el mismo `reason`.

## Relaciones

```text
tenants 1 ──< clients 1 ──< vehicles          (vehicles.(tenant_id, owner_client_id) → clients.(tenant_id, id))
tenants 1 ──< audit_log >── (clients | vehicles) por (entity_type, entity_id), sin FK: el log sobrevive a cualquier cambio
```

## Transiciones de estado

Clientes y vehículos no tienen estados: se crean y se editan, y nunca se eliminan (FR-021). La única transición es el **propietario actual** de un vehículo:

```text
owner = A ──(transferencia a B ≠ A, mismo taller, version vigente, motivo si es asesor)──> owner = B
          └─ en la misma transacción: UPDATE vehicles + INSERT audit_log(vehicle.owner_changed)
```

## Consultas de referencia (las implementa `implementer-backend`)

Búsqueda de vehículos (FR-001, FR-003). `$1` es el término normalizado (`[A-Z0-9]+`, al menos 2 caracteres):

```sql
SELECT v.*, c.display_name AS owner_display_name, c.document_type AS owner_document_type,
       c.document_number AS owner_document_number, c.phone AS owner_phone, c.email AS owner_email
FROM vehicles v
JOIN clients c ON c.tenant_id = v.tenant_id AND c.id = v.owner_client_id
WHERE v.tenant_id = app_current_tenant()
  AND (v.plate LIKE '%' || $1 || '%' OR v.vin = $1)
ORDER BY CASE WHEN v.plate = $1 OR v.vin = $1 THEN 0
              WHEN v.plate LIKE $1 || '%' THEN 1 ELSE 2 END,
         v.plate
LIMIT 21;
```

El filtro explícito `tenant_id = app_current_tenant()` es la primera barrera (principio I) y además permite usar los índices compuestos; RLS es la segunda barrera.

Búsqueda de clientes (FR-004). `$1` es el documento normalizado y `$2` el nombre como `immutable_unaccent(lower(trim(term)))`, con `%`, `_` y `\` escapados:

```sql
SELECT c.* FROM clients c
WHERE c.tenant_id = app_current_tenant()
  AND (c.document_number LIKE '%' || $1 || '%' OR c.search_name LIKE '%' || $2 || '%')
ORDER BY CASE WHEN c.document_number = $1 THEN 0
              WHEN c.document_number LIKE $1 || '%' THEN 1 ELSE 2 END,
         c.display_name
LIMIT 21;
```

Si el término normalizado como documento queda vacío (por ejemplo, `nunez`), se omite la condición sobre `document_number`.

## Volumen de referencia (SC-001)

10 talleres × (30 000 clientes + 50 000 vehículos) = 800 000 filas de negocio. Lo genera `backend/test/perf/seed-volume.sql`; ver [quickstart](./quickstart.md#5-rendimiento).
