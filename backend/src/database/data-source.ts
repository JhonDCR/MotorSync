import { DataSource } from 'typeorm';
import { requireEnv } from '../config/env.js';
import { CreateTenantsAndHelpers1761000000000 } from './migrations/1761000000000-CreateTenantsAndHelpers.js';

// Registered by class reference, never by glob: TypeORM's path loading does not work in ESM.
export const ENTITIES: (new () => object)[] = [];
export const MIGRATIONS: (new () => object)[] = [CreateTenantsAndHelpers1761000000000];

/** Runtime connection of the API as motorsync_app (no BYPASSRLS). */
export function createAppDataSource(url: string = requireEnv('DATABASE_URL')): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    synchronize: false,
    migrationsRun: false,
    entities: ENTITIES,
  });
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
