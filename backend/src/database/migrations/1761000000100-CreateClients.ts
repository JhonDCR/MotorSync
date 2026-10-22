import type { MigrationInterface, QueryRunner } from 'typeorm';

/** DDL from specs/001-clientes-vehiculos/data-model.md, "`clients` (Cliente)", verbatim. */
export class CreateClients1761000000100 implements MigrationInterface {
  name = 'CreateClients1761000000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // String.raw keeps the backslash of the phone regex ('^\+?[0-9]{7,15}$') intact.
    await queryRunner.query(String.raw`
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
        CONSTRAINT clients_tenant_id_id_key UNIQUE (tenant_id, id)
      )
    `);

    await queryRunner.query('CREATE INDEX clients_tenant_id_idx ON clients (tenant_id)');
    // FR-009, exact and prefix search.
    await queryRunner.query(
      'CREATE UNIQUE INDEX clients_tenant_document_key ON clients (tenant_id, document_number)',
    );
    await queryRunner.query(
      'CREATE INDEX clients_tenant_document_trgm_idx ON clients USING gin (tenant_id, document_number gin_trgm_ops)',
    );
    await queryRunner.query(
      'CREATE INDEX clients_tenant_search_name_trgm_idx ON clients USING gin (tenant_id, search_name gin_trgm_ops)',
    );

    await queryRunner.query('ALTER TABLE clients ENABLE ROW LEVEL SECURITY');
    await queryRunner.query('ALTER TABLE clients FORCE ROW LEVEL SECURITY');
    await queryRunner.query(`
      CREATE POLICY clients_tenant_isolation ON clients
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())
    `);

    await queryRunner.query('GRANT SELECT, INSERT, UPDATE ON clients TO motorsync_app');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drops its indexes and its policy as well.
    await queryRunner.query('DROP TABLE clients');
  }
}
