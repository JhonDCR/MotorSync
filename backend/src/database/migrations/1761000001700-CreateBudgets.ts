import type { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = ['budget_counters', 'budgets', 'budget_lines'] as const;

/**
 * DDL of specs/005-presupuestos/data-model.md. motorsync_app never deletes budgets (D7); lines are
 * replaced (DELETE + INSERT) only while the budget is a draft, enforced by budget_lines_draft_only.
 */
export class CreateBudgets1761000001700 implements MigrationInterface {
  name = 'CreateBudgets1761000001700';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE budget_counters (
        tenant_id   uuid PRIMARY KEY DEFAULT app_current_tenant() REFERENCES tenants(id),
        last_number integer NOT NULL DEFAULT 0
      )
    `);
    await queryRunner.query(`
      CREATE TABLE budgets (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        number     integer NOT NULL CHECK (number > 0),
        checkin_id uuid NOT NULL,
        vehicle_id uuid NOT NULL,
        status     text NOT NULL DEFAULT 'borrador'
          CHECK (status IN ('borrador', 'enviado', 'aprobado', 'rechazado')),
        tax_rate   numeric(5,4) NOT NULL CHECK (tax_rate >= 0),
        subtotal   numeric(12,2) NOT NULL CHECK (subtotal >= 0),
        tax        numeric(12,2) NOT NULL CHECK (tax >= 0),
        total      numeric(12,2) NOT NULL CHECK (total >= 0),
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        sent_at    timestamptz,
        decided_at timestamptz,
        decided_by uuid,
        CONSTRAINT budgets_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT budgets_tenant_number_key UNIQUE (tenant_id, number),
        CONSTRAINT budgets_checkin_fk FOREIGN KEY (tenant_id, checkin_id)
          REFERENCES checkins (tenant_id, id),
        CONSTRAINT budgets_vehicle_fk FOREIGN KEY (tenant_id, vehicle_id)
          REFERENCES vehicles (tenant_id, id),
        CONSTRAINT budgets_created_by_fk FOREIGN KEY (tenant_id, created_by)
          REFERENCES users (tenant_id, id),
        CONSTRAINT budgets_decided_by_fk FOREIGN KEY (tenant_id, decided_by)
          REFERENCES users (tenant_id, id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE budget_lines (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        budget_id   uuid NOT NULL,
        position    smallint NOT NULL CHECK (position >= 0),
        kind        text NOT NULL CHECK (kind IN ('mano_obra', 'repuesto')),
        description text NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
        quantity    numeric(10,2) NOT NULL CHECK (quantity > 0),
        unit_price  numeric(12,2) NOT NULL CHECK (unit_price >= 0),
        line_total  numeric(12,2) NOT NULL CHECK (line_total >= 0),
        CONSTRAINT budget_lines_budget_fk FOREIGN KEY (tenant_id, budget_id)
          REFERENCES budgets (tenant_id, id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(
      'CREATE INDEX budgets_checkin_idx ON budgets (tenant_id, checkin_id, created_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX budgets_vehicle_idx ON budgets (tenant_id, vehicle_id, created_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX budget_lines_budget_idx ON budget_lines (tenant_id, budget_id, position)',
    );

    // D7: second barrier for FR-005, independent of the status check in the service.
    await queryRunner.query(`
      CREATE FUNCTION budget_lines_draft_only() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE
        line           budget_lines;
        current_status text;
      BEGIN
        IF TG_OP = 'DELETE' THEN line := OLD; ELSE line := NEW; END IF;
        SELECT b.status INTO current_status FROM budgets b
         WHERE b.tenant_id = line.tenant_id AND b.id = line.budget_id;
        IF current_status IS DISTINCT FROM 'borrador' THEN
          RAISE EXCEPTION 'budget_lines_draft_only: el presupuesto no está en borrador'
            USING ERRCODE = 'check_violation';
        END IF;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await queryRunner.query(`
      CREATE TRIGGER budget_lines_draft_only
        BEFORE INSERT OR DELETE ON budget_lines
        FOR EACH ROW EXECUTE FUNCTION budget_lines_draft_only()
    `);

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
      'GRANT SELECT, INSERT, UPDATE ON budget_counters TO motorsync_app',
    );
    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE ON budgets TO motorsync_app',
    );
    await queryRunner.query(
      'GRANT SELECT, INSERT, DELETE ON budget_lines TO motorsync_app',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE budget_lines');
    await queryRunner.query('DROP FUNCTION budget_lines_draft_only()');
    await queryRunner.query('DROP TABLE budgets');
    await queryRunner.query('DROP TABLE budget_counters');
  }
}
