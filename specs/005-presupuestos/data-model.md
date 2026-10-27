# Data Model: Presupuestos

Todas: `tenant_id uuid NOT NULL REFERENCES tenants(id)`, índice por `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, política `tenant_isolation USING/WITH CHECK (tenant_id = app_current_tenant())`.

## budget_counters
`tenant_id uuid PK`, `last_number integer NOT NULL DEFAULT 0`. App: `SELECT, INSERT, UPDATE`.

## budgets (App: `SELECT, INSERT, UPDATE`)
| Columna | Tipo | Regla |
|---|---|---|
| id | uuid PK | UNIQUE (tenant_id, id) |
| number | integer | UNIQUE (tenant_id, number) |
| checkin_id | uuid | FK (tenant_id, checkin_id) → checkins |
| vehicle_id | uuid | FK (tenant_id, vehicle_id) → vehicles (copiado del check-in) |
| status | text CHECK IN ('borrador','enviado','aprobado','rechazado') DEFAULT 'borrador' | |
| tax_rate | numeric(5,4) NOT NULL | 0.1500 al crear |
| subtotal, tax, total | numeric(12,2) NOT NULL CHECK (≥ 0) | recalculados en servidor |
| created_by | uuid FK → users | |
| created_at, updated_at | timestamptz DEFAULT now() | |
| sent_at | timestamptz NULL | |
| decided_at, decided_by | timestamptz / uuid NULL | aprobado o rechazado |

Índices: `(tenant_id, checkin_id, created_at DESC)`, `(tenant_id, vehicle_id, created_at DESC)`.

## budget_lines (App: `SELECT, INSERT, DELETE`)
| Columna | Tipo |
|---|---|
| id | uuid PK |
| tenant_id, budget_id | FK (tenant_id, budget_id) → budgets ON DELETE CASCADE |
| position | smallint (orden) |
| kind | text CHECK IN ('mano_obra','repuesto') |
| description | text CHECK (1..200) |
| quantity | numeric(10,2) CHECK (> 0) |
| unit_price | numeric(12,2) CHECK (≥ 0) |
| line_total | numeric(12,2) |

Trigger `budget_lines_draft_only` (BEFORE INSERT/DELETE): error si el presupuesto no está en `borrador`.
