import type { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = ['checkin_counters', 'checkin_images', 'checkins', 'checkin_damages'] as const;

/**
 * DDL of specs/004-checkin-360/data-model.md. Check-ins are immutable (US2-AC3): motorsync_app only
 * gets SELECT and INSERT, plus UPDATE on checkin_counters for the per-tenant number (FR-005).
 */
export class CreateCheckins1761000001600 implements MigrationInterface {
  name = 'CreateCheckins1761000001600';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Target of the composite FK checkins_vehicle_fk (vehicles only had its id as key).
    await queryRunner.query(
      'ALTER TABLE vehicles ADD CONSTRAINT vehicles_tenant_id_id_key UNIQUE (tenant_id, id)',
    );
    await queryRunner.query(`
      CREATE TABLE checkin_counters (
        tenant_id   uuid PRIMARY KEY DEFAULT app_current_tenant() REFERENCES tenants(id),
        last_number integer NOT NULL DEFAULT 0
      )
    `);
    await queryRunner.query(`
      CREATE TABLE checkin_images (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        checkin_id uuid NOT NULL,
        kind       text NOT NULL CHECK (kind IN ('signature', 'damage')),
        mime       text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png')),
        data       bytea NOT NULL CHECK (octet_length(data) <= 1048576),
        CONSTRAINT checkin_images_tenant_id_id_key UNIQUE (tenant_id, id)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE checkins (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        number             integer NOT NULL CHECK (number > 0),
        vehicle_id         uuid NOT NULL,
        owner_client_id    uuid NOT NULL,
        created_by         uuid NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT now(),
        mileage            integer NOT NULL CHECK (mileage >= 0),
        fuel_level         text NOT NULL CHECK (fuel_level IN ('vacio', '1/4', '1/2', '3/4', 'lleno')),
        reason             text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
        inventory          text[] NOT NULL DEFAULT '{}',
        signature_image_id uuid NOT NULL,
        CONSTRAINT checkins_tenant_id_id_key UNIQUE (tenant_id, id),
        CONSTRAINT checkins_tenant_number_key UNIQUE (tenant_id, number),
        CONSTRAINT checkins_vehicle_fk FOREIGN KEY (tenant_id, vehicle_id)
          REFERENCES vehicles (tenant_id, id),
        CONSTRAINT checkins_owner_fk FOREIGN KEY (tenant_id, owner_client_id)
          REFERENCES clients (tenant_id, id),
        CONSTRAINT checkins_created_by_fk FOREIGN KEY (tenant_id, created_by)
          REFERENCES users (tenant_id, id),
        CONSTRAINT checkins_signature_fk FOREIGN KEY (tenant_id, signature_image_id)
          REFERENCES checkin_images (tenant_id, id)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE checkin_images ADD CONSTRAINT checkin_images_checkin_fk
        FOREIGN KEY (tenant_id, checkin_id) REFERENCES checkins (tenant_id, id)
        DEFERRABLE INITIALLY DEFERRED
    `);
    await queryRunner.query(`
      CREATE TABLE checkin_damages (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        checkin_id     uuid NOT NULL,
        view           text NOT NULL
          CHECK (view IN ('frente', 'atras', 'izquierda', 'derecha', 'arriba')),
        type           text NOT NULL
          CHECK (type IN ('rayon', 'golpe', 'abolladura', 'rotura', 'faltante', 'otro')),
        note           text CHECK (note IS NULL OR length(note) <= 500),
        photo_image_id uuid,
        CONSTRAINT checkin_damages_checkin_fk FOREIGN KEY (tenant_id, checkin_id)
          REFERENCES checkins (tenant_id, id),
        CONSTRAINT checkin_damages_photo_fk FOREIGN KEY (tenant_id, photo_image_id)
          REFERENCES checkin_images (tenant_id, id)
      )
    `);

    await queryRunner.query(
      'CREATE INDEX checkins_vehicle_idx ON checkins (tenant_id, vehicle_id, created_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX checkin_images_checkin_idx ON checkin_images (tenant_id, checkin_id)',
    );
    await queryRunner.query(
      'CREATE INDEX checkin_damages_checkin_idx ON checkin_damages (tenant_id, checkin_id)',
    );

    for (const table of TABLES) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${table}_tenant_isolation ON ${table}
          USING (tenant_id = app_current_tenant())
          WITH CHECK (tenant_id = app_current_tenant())
      `);
      await queryRunner.query(`GRANT SELECT, INSERT ON ${table} TO motorsync_app`);
    }
    await queryRunner.query('GRANT UPDATE (last_number) ON checkin_counters TO motorsync_app');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE checkin_damages');
    await queryRunner.query('ALTER TABLE checkin_images DROP CONSTRAINT checkin_images_checkin_fk');
    await queryRunner.query('DROP TABLE checkins');
    await queryRunner.query('DROP TABLE checkin_images');
    await queryRunner.query('DROP TABLE checkin_counters');
    await queryRunner.query('ALTER TABLE vehicles DROP CONSTRAINT vehicles_tenant_id_id_key');
  }
}
