import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DDL from specs/003-soporte-plataforma/data-model.md, "Migración
 * `1761000001100-CreateSupportTickets`", verbatim (research R5, R6, R8).
 *
 * support_tickets and support_ticket_events contain emails and accounts of every workshop, so
 * motorsync_app has no privilege on them: the app only reaches them through the SECURITY DEFINER
 * functions of migration 1761000001200. RLS is ENABLE without FORCE, with policies only for
 * motorsync_support.
 */
export class CreateSupportTickets1761000001100 implements MigrationInterface {
  name = 'CreateSupportTickets1761000001100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE support_tickets (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        number              bigint GENERATED ALWAYS AS IDENTITY,
        tenant_id           uuid NOT NULL REFERENCES tenants(id),
        user_id             uuid NOT NULL,
        email               text COLLATE "C" NOT NULL CHECK (email = lower(btrim(email))),
        status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'discarded')),
        created_at          timestamptz NOT NULL DEFAULT now(),
        last_requested_at   timestamptz NOT NULL DEFAULT now(),
        request_count       integer NOT NULL DEFAULT 1 CHECK (request_count >= 1),
        verification_note   text CHECK (verification_note IS NULL
                                        OR length(btrim(verification_note)) BETWEEN 1 AND 1000),
        resolved_by         uuid REFERENCES support_accounts(id),
        resolved_at         timestamptz,
        discard_reason      text CHECK (discard_reason IS NULL
                                        OR length(btrim(discard_reason)) BETWEEN 1 AND 500),
        discarded_by        uuid REFERENCES support_accounts(id),
        discarded_at        timestamptz,
        CONSTRAINT support_tickets_number_key UNIQUE (number),
        -- The ticket cannot point to an account of a workshop other than its own.
        CONSTRAINT support_tickets_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
        -- FR-014: every state with exactly its closing data.
        CONSTRAINT support_tickets_state_coherent CHECK (
          (status = 'open'      AND verification_note IS NULL AND resolved_by IS NULL AND resolved_at IS NULL
                                AND discard_reason IS NULL AND discarded_by IS NULL AND discarded_at IS NULL)
       OR (status = 'resolved'  AND verification_note IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
                                AND discard_reason IS NULL AND discarded_by IS NULL AND discarded_at IS NULL)
       OR (status = 'discarded' AND verification_note IS NULL AND resolved_by IS NULL AND resolved_at IS NULL
                                AND discard_reason IS NOT NULL AND discarded_by IS NOT NULL AND discarded_at IS NOT NULL))
      )
    `);
    // FR-002, SC-008: at most one open ticket per account, also under simultaneous requests.
    await queryRunner.query(
      "CREATE UNIQUE INDEX support_tickets_one_open_per_user ON support_tickets (user_id) WHERE status = 'open'",
    );
    await queryRunner.query(
      "CREATE INDEX support_tickets_open_inbox_idx ON support_tickets (created_at) WHERE status = 'open'",
    );
    await queryRunner.query(
      'CREATE INDEX support_tickets_tenant_id_idx ON support_tickets (tenant_id)',
    );

    await queryRunner.query(`
      CREATE TABLE support_ticket_events (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ticket_id           uuid NOT NULL REFERENCES support_tickets(id),
        support_account_id  uuid NOT NULL REFERENCES support_accounts(id),
        action              text NOT NULL CHECK (action IN ('discarded', 'temporary_password_generated')),
        from_status         text NOT NULL CHECK (from_status = 'open'),
        to_status           text NOT NULL CHECK (to_status IN ('resolved', 'discarded')),
        occurred_at         timestamptz NOT NULL DEFAULT now(),
        ip                  text
      )
    `);
    await queryRunner.query(
      'CREATE INDEX support_ticket_events_ticket_idx ON support_ticket_events (ticket_id, occurred_at)',
    );

    // R8: global technical table; only the hash of the IP, never emails.
    await queryRunner.query(`
      CREATE TABLE help_request_throttle (
        origin_hash        text COLLATE "C" PRIMARY KEY CHECK (origin_hash ~ '^[0-9a-f]{64}$'),
        window_started_at  timestamptz NOT NULL DEFAULT now(),
        request_count      integer NOT NULL CHECK (request_count BETWEEN 1 AND 21),
        updated_at         timestamptz NOT NULL DEFAULT now()
      )
    `);

    // FR-014, FR-015, SC-010: a closed ticket does not change; no ticket is ever deleted.
    await queryRunner.query(`
      CREATE FUNCTION support_tickets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'support_tickets rows are never deleted';
        END IF;
        IF OLD.status <> 'open' THEN
          RAISE EXCEPTION 'closed support tickets are immutable';
        END IF;
        RETURN NEW;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TRIGGER support_tickets_guard BEFORE UPDATE OR DELETE ON support_tickets
        FOR EACH ROW EXECUTE FUNCTION support_tickets_guard()
    `);

    // US2-AC8: append-only history (reuses the function of feature 001).
    await queryRunner.query(`
      CREATE TRIGGER support_ticket_events_no_update_delete BEFORE UPDATE OR DELETE ON support_ticket_events
        FOR EACH ROW EXECUTE FUNCTION audit_log_immutable()
    `);

    // R6: only the motorsync_support functions reach these tables.
    await queryRunner.query('ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE support_ticket_events ENABLE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY support_tickets_support ON support_tickets TO motorsync_support
        USING (true) WITH CHECK (true)
    `);
    await queryRunner.query(`
      CREATE POLICY support_ticket_events_support ON support_ticket_events TO motorsync_support
        USING (true) WITH CHECK (true)
    `);
    await queryRunner.query(
      'REVOKE ALL ON support_tickets, support_ticket_events, help_request_throttle FROM PUBLIC',
    );
    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE ON support_tickets TO motorsync_support',
    );
    await queryRunner.query(
      'GRANT SELECT, INSERT ON support_ticket_events TO motorsync_support',
    );
    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON help_request_throttle TO motorsync_support',
    );
    // motorsync_app has no privilege on the three.

    // R1: bounded read of workshops and accounts for the panel functions.
    await queryRunner.query(
      'CREATE POLICY tenants_support_lookup ON tenants FOR SELECT TO motorsync_support USING (true)',
    );
    await queryRunner.query(
      'CREATE POLICY users_support_lookup ON users FOR SELECT TO motorsync_support USING (true)',
    );
    await queryRunner.query(
      'GRANT SELECT (id, name, ruc, created_at) ON tenants TO motorsync_support',
    );
    await queryRunner.query(
      'GRANT SELECT (id, tenant_id, name, email, role, status) ON users TO motorsync_support',
    );
    await queryRunner.query(
      'GRANT EXECUTE ON FUNCTION app_current_tenant(), immutable_unaccent(text) TO motorsync_support',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER IF EXISTS support_tickets_guard ON support_tickets');
    await queryRunner.query('DROP FUNCTION IF EXISTS support_tickets_guard()');
    // support_ticket_events references support_tickets: drop it first.
    await queryRunner.query('DROP TABLE support_ticket_events');
    await queryRunner.query('DROP TABLE support_tickets');
    await queryRunner.query('DROP TABLE help_request_throttle');
    await queryRunner.query('DROP POLICY tenants_support_lookup ON tenants');
    await queryRunner.query('DROP POLICY users_support_lookup ON users');
    await queryRunner.query(
      'REVOKE SELECT (id, name, ruc, created_at) ON tenants FROM motorsync_support',
    );
    await queryRunner.query(
      'REVOKE SELECT (id, tenant_id, name, email, role, status) ON users FROM motorsync_support',
    );
    await queryRunner.query(
      'REVOKE EXECUTE ON FUNCTION app_current_tenant(), immutable_unaccent(text) FROM motorsync_support',
    );
  }
}
