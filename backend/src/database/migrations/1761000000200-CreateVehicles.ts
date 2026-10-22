import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DDL from specs/001-clientes-vehiculos/data-model.md, "`vehicles` (Vehículo)", verbatim.
 * The composite FK targets clients_tenant_id_id_key (UNIQUE (tenant_id, id), CreateClients).
 */
export class CreateVehicles1761000000200 implements MigrationInterface {
  name = 'CreateVehicles1761000000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE vehicles (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL DEFAULT app_current_tenant() REFERENCES tenants(id),
        owner_client_id  uuid NOT NULL,
        plate            text COLLATE "C" NOT NULL,
        vin              text COLLATE "C" CHECK (vin IS NULL OR vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
        brand            text NOT NULL,
        model            text NOT NULL,
        year             smallint NOT NULL CHECK (year >= 1950),
        color            text NOT NULL,
        body_type        text NOT NULL CHECK (body_type IN ('sedan', 'suv', 'pickup', 'motorcycle', 'other')),
        initial_mileage  integer NOT NULL CHECK (initial_mileage BETWEEN 0 AND 9999999),
        version          integer NOT NULL DEFAULT 1,
        created_at       timestamptz NOT NULL DEFAULT now(),
        created_by       uuid NOT NULL,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        updated_by       uuid NOT NULL,
        updated_by_name  text NOT NULL,
        CONSTRAINT vehicles_plate_format CHECK (
          (body_type = 'motorcycle' AND plate ~ '^[A-Z]{2}[0-9]{3}[A-Z]$')
          OR (body_type <> 'motorcycle' AND plate ~ '^[A-Z]{3}[0-9]{3,4}$')),
        CONSTRAINT vehicles_owner_same_tenant_fk
          FOREIGN KEY (tenant_id, owner_client_id) REFERENCES clients (tenant_id, id)
      )
    `);

    await queryRunner.query(
      'CREATE INDEX vehicles_tenant_id_idx ON vehicles (tenant_id)',
    );
    // FR-012, exact and prefix search.
    await queryRunner.query(
      'CREATE UNIQUE INDEX vehicles_tenant_plate_key ON vehicles (tenant_id, plate)',
    );
    // FR-013, search by VIN.
    await queryRunner.query(
      'CREATE UNIQUE INDEX vehicles_tenant_vin_key ON vehicles (tenant_id, vin) WHERE vin IS NOT NULL',
    );
    // "Contains" search.
    await queryRunner.query(
      'CREATE INDEX vehicles_tenant_plate_trgm_idx ON vehicles USING gin (tenant_id, plate gin_trgm_ops)',
    );
    // Vehicles of a client.
    await queryRunner.query(
      'CREATE INDEX vehicles_tenant_owner_idx ON vehicles (tenant_id, owner_client_id)',
    );

    await queryRunner.query('ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE vehicles FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY vehicles_tenant_isolation ON vehicles
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())
    `);

    await queryRunner.query(
      'GRANT SELECT, INSERT, UPDATE ON vehicles TO motorsync_app',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops its indexes and its policy as well.
    await queryRunner.query('DROP TABLE vehicles');
  }
}
