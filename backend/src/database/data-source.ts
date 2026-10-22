import { DataSource, type DataSourceOptions } from 'typeorm';
import { Client } from '../clients/client.entity.js';
import { requireEnv } from '../config/env.js';
import { Vehicle } from '../vehicles/vehicle.entity.js';
import { CreateTenantsAndHelpers1761000000000 } from './migrations/1761000000000-CreateTenantsAndHelpers.js';
import { CreateClients1761000000100 } from './migrations/1761000000100-CreateClients.js';
import { CreateVehicles1761000000200 } from './migrations/1761000000200-CreateVehicles.js';

// Registered by class reference, never by glob: TypeORM's path loading does not work in ESM.
export const ENTITIES: (new () => object)[] = [Client, Vehicle];
export const MIGRATIONS: (new () => object)[] = [
  CreateTenantsAndHelpers1761000000000,
  CreateClients1761000000100,
  CreateVehicles1761000000200,
];

/** Options of the runtime connection of the API as motorsync_app (no BYPASSRLS). */
export function appDataSourceOptions(
  url: string = requireEnv('DATABASE_URL'),
): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    entities: ENTITIES,
  };
}

/** Runtime connection of the API as motorsync_app (no BYPASSRLS). */
export function createAppDataSource(
  url: string = requireEnv('DATABASE_URL'),
): DataSource {
  return new DataSource(appDataSourceOptions(url));
}

/** Migration connection as motorsync_migrator (owner of the schema and the tables). */
export function createMigratorDataSource(
  url: string = requireEnv('DATABASE_MIGRATOR_URL'),
): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    entities: ENTITIES,
    migrations: MIGRATIONS,
    migrationsTransactionMode: 'all',
  });
}
