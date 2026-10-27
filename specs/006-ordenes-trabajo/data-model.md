# Data Model: Órdenes de trabajo

Todas: `tenant_id uuid NOT NULL REFERENCES tenants(id)`, índice por `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, política `tenant_isolation USING/WITH CHECK (tenant_id = app_current_tenant())`.

## work_order_counters
`tenant_id uuid PK`, `last_number integer NOT NULL DEFAULT 0`. App: `SELECT, INSERT, UPDATE`.

## work_orders (App: `SELECT, INSERT, UPDATE`)
| Columna | Tipo | Regla |
|---|---|---|
| id | uuid PK | UNIQUE (tenant_id, id) |
| number | integer | UNIQUE (tenant_id, number) |
| budget_id | uuid | FK (tenant_id, budget_id) → budgets; UNIQUE (tenant_id, budget_id) |
| checkin_id | uuid | FK (tenant_id, checkin_id) → checkins |
| vehicle_id | uuid | FK (tenant_id, vehicle_id) → vehicles |
| status | text CHECK IN ('abierta','en_proceso','terminada','entregada','cancelada') DEFAULT 'abierta' | |
| assignee_id | uuid | FK (tenant_id, assignee_id) → users |
| created_by | uuid FK → users | |
| created_at, updated_at | timestamptz DEFAULT now() | |

Índices: único parcial `(tenant_id, checkin_id) WHERE status NOT IN ('entregada','cancelada')`; `(tenant_id, status, created_at DESC)`; `(tenant_id, vehicle_id, created_at DESC)`.

## work_order_items (App: `SELECT, INSERT`)
`id`, FK `(tenant_id, work_order_id)`, `position smallint`, `kind text CHECK IN ('mano_obra','repuesto')`, `description text CHECK (1..200)`, `quantity numeric(10,2) CHECK (> 0)`.

## work_order_status_changes (App: `SELECT, INSERT`)
`id`, FK `(tenant_id, work_order_id)`, `status text` (mismo CHECK), `changed_by uuid`, `changed_at timestamptz DEFAULT now()`, `reason text NULL CHECK (status <> 'cancelada' OR reason IS NOT NULL)`.

## work_order_notes (App: `SELECT, INSERT`)
`id`, FK `(tenant_id, work_order_id)`, `body text CHECK (1..1000)`, `created_by uuid`, `created_at timestamptz DEFAULT now()`.
