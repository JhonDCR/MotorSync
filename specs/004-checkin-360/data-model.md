# Data Model: Check-in 360°

Todas las tablas: `tenant_id uuid NOT NULL REFERENCES tenants(id)`, índice por `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, política `tenant_isolation USING/WITH CHECK (tenant_id = app_current_tenant())`. `motorsync_app`: `SELECT, INSERT` (y `UPDATE` solo en `checkin_counters`).

## checkin_counters
| Columna | Tipo |
|---|---|
| tenant_id | uuid PK |
| last_number | integer NOT NULL DEFAULT 0 |

## checkins
| Columna | Tipo | Regla |
|---|---|---|
| id | uuid PK | |
| tenant_id | uuid | UNIQUE (tenant_id, id) |
| number | integer | UNIQUE (tenant_id, number) — FR-005 |
| vehicle_id | uuid | FK (tenant_id, vehicle_id) → vehicles |
| owner_client_id | uuid | FK (tenant_id, owner_client_id) → clients; propietario vigente al crear |
| created_by | uuid | FK → users; de la sesión |
| created_at | timestamptz DEFAULT now() | |
| mileage | integer CHECK (≥ 0) | FR-004 en servicio |
| fuel_level | text CHECK IN ('vacio','1/4','1/2','3/4','lleno') | |
| reason | text CHECK (1..1000) | |
| inventory | text[] NOT NULL DEFAULT '{}' | ≤ 30 ítems, ≤ 100 c/u (DTO) |
| signature_image_id | uuid NOT NULL | FK (tenant_id, id) → checkin_images |

Índice: `(tenant_id, vehicle_id, created_at DESC)`.

## checkin_damages
| Columna | Tipo |
|---|---|
| id | uuid PK |
| tenant_id, checkin_id | FK (tenant_id, checkin_id) → checkins |
| view | text CHECK IN ('frente','atras','izquierda','derecha','arriba') |
| type | text CHECK IN ('rayon','golpe','abolladura','rotura','faltante','otro') |
| note | text NULL CHECK (≤ 500) |
| photo_image_id | uuid NULL, FK (tenant_id, id) → checkin_images |

## checkin_images
| Columna | Tipo |
|---|---|
| id | uuid PK |
| tenant_id | uuid, UNIQUE (tenant_id, id) |
| checkin_id | uuid (FK diferible a checkins) |
| kind | text CHECK IN ('signature','damage') |
| mime | text CHECK IN ('image/jpeg','image/png') |
| data | bytea CHECK (octet_length ≤ 1048576) |

Inserción en una transacción: imágenes → check-in → daños (FK `checkin_id` `DEFERRABLE INITIALLY DEFERRED`).
