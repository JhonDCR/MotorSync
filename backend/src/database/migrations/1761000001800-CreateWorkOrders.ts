import type { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = [
  'work_order_counters',
  'work_orders',
  'work_order_items',
  'work_order_status_changes',
  'work_order_notes',
] as const;

const STATUSES = `'abierta', 'en_proceso', 'terminada', 'entregada', 'cancelada'`;

/**
 * DDL of specs/006-ordenes-trabajo/data-model.md. Items, history and notes are append-only for
 * motorsync_app (SELECT, INSERT); work orders are never deleted.
 */
export class CreateWorkOrders1761000001800 implements MigrationInterface {
  name = 'CreateWorkOrders1761000001800';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE work_order_counters (
        tenant_id   uuid PRIMARY KEY DEFAULT app_current_tenant() REFERENCES tenants(id),
        last_number integer NOT NULL DEFAULT 0
      )
    `);
    await queryRunner.query(`
      CREATE TABLE work_orders (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        number      integer NOT NULL CHECK (number > 0),
        budget_id   uuid NOT NULL,
        checkin_id  uuid NOT NULL,
        vehicle_id  uuid NOT NULL,
        status      text NOT NULL DEFAULT 'abierta' CHECK (status IN (${STATUSES})),
        assignee_id uuid NOT NULL,
        created_by  uuid NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT work_orders_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT work_orders_tenant_number_key UNIQUE (tenant_id, number),
        CONSTRAINT work_orders_tenant_budget_key UNIQUE (tenant_id, budget_id),
        CONSTRAINT work_orders_budget_fk FOREIGN KEY (tenant_id, budget_id)
          REFERENCES budgets (tenant_id, id),
        CONSTRAINT work_orders_checkin_fk FOREIGN KEY (tenant_id, checkin_id)
          REFERENCES checkins (tenant_id, id),
        CONSTRAINT work_orders_vehicle_fk FOREIGN KEY (tenant_id, vehicle_id)
          REFERENCES vehicles (tenant_id, id),
        CONSTRAINT work_orders_assignee_fk FOREIGN KEY (tenant_id, assignee_id)
          REFERENCES users (tenant_id, id),
        CONSTRAINT work_orders_created_by_fk FOREIGN KEY (tenant_id, created_by)
          REFERENCES users (tenant_id, id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE work_order_items (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        work_order_id uuid NOT NULL,
        position      smallint NOT NULL CHECK (position > 0),
        kind          text NOT NULL CHECK (kind IN ('mano_obra', 'repuesto')),
        description   text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
        quantity      numeric(10,2) NOT NULL CHECK (quantity > 0),
        CONSTRAINT work_order_items_wo_fk FOREIGN KEY (tenant_id, work_order_id)
          REFERENCES work_orders (tenant_id, id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE work_order_status_changes (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        work_order_id uuid NOT NULL,
        status        text NOT NULL CHECK (status IN (${STATUSES})),
        changed_by    uuid NOT NULL,
        changed_at    timestamptz NOT NULL DEFAULT now(),
        reason        text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
        CONSTRAINT work_order_status_changes_reason CHECK (status <> 'cancelada' OR reason IS NOT NULL),
        CONSTRAINT work_order_status_changes_wo_fk FOREIGN KEY (tenant_id, work_order_id)
          REFERENCES work_orders (tenant_id, id),
        CONSTRAINT work_order_status_changes_user_fk FOREIGN KEY (tenant_id, changed_by)
          REFERENCES users (tenant_id, id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE work_order_notes (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        work_order_id uuid NOT NULL,
        body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 1000),
        created_by    uuid NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT work_order_notes_wo_fk FOREIGN KEY (tenant_id, work_order_id)
          REFERENCES work_orders (tenant_id, id),
        CONSTRAINT work_order_notes_user_fk FOREIGN KEY (tenant_id, created_by)
          REFERENCES users (tenant_id, id)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX work_orders_active_checkin_key ON work_orders (tenant_id, checkin_id)
        WHERE status NOT IN ('entregada', 'cancelada')
    `);
    await queryRunner.query(
      'CREATE INDEX work_orders_status_idx ON work_orders (tenant_id, status, created_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX work_orders_vehicle_idx ON work_orders (tenant_id, vehicle_id, created_at DESC)',
    );
    for (const table of TABLES.slice(2)) {
      await queryRunner.query(
        `CREATE INDEX ${table}_wo_idx ON ${table} (tenant_id, work_order_id)`,
      );
    }

    for (const table of TABLES) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${table}_tenant_isolation ON ${table}
          USING (tenant_id = app_current_tenant())
          WITH CHECK (tenant_id = app_current_tenant())
      `);
    }
    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE ON work_order_counters, work_orders TO motorsync_app',
    );
    await queryRunner.query(
      'GRANT SELECT, INSERT ON work_order_items, work_order_status_changes, work_order_notes TO motorsync_app',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [...TABLES].reverse()) {
      await queryRunner.query(`DROP TABLE ${table}`);
    }
  }
}
