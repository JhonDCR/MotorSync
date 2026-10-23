import { DataSource, type DataSourceOptions } from 'typeorm';
import { AuditLog } from '../audit/audit-log.entity.js';
import { Client } from '../clients/client.entity.js';
import { requireEnv } from '../config/env.js';
import { Vehicle } from '../vehicles/vehicle.entity.js';
import { CreateTenantsAndHelpers1761000000000 } from './migrations/1761000000000-CreateTenantsAndHelpers.js';
import { CreateClients1761000000100 } from './migrations/1761000000100-CreateClients.js';
import { CreateVehicles1761000000200 } from './migrations/1761000000200-CreateVehicles.js';
import { CreateAuditLog1761000000300 } from './migrations/1761000000300-CreateAuditLog.js';
import { AddTenantRuc1761000000400 } from './migrations/1761000000400-AddTenantRuc.js';
import { CreateUsers1761000000500 } from './migrations/1761000000500-CreateUsers.js';
import { CreateSessions1761000000600 } from './migrations/1761000000600-CreateSessions.js';
import { CreateLoginAttempts1761000000700 } from './migrations/1761000000700-CreateLoginAttempts.js';
import { CreateAuthFunctions1761000000800 } from './migrations/1761000000800-CreateAuthFunctions.js';
import { FixLoginFailurePruneLocking1761000000850 } from './migrations/1761000000850-FixLoginFailurePruneLocking.js';

// Registered by class reference, never by glob: TypeORM's path loading does not work in ESM.
export const ENTITIES: (new () => object)[] = [Client, Vehicle, AuditLog];
export const MIGRATIONS: (new () => object)[] = [
  CreateTenantsAndHelpers1761000000000,
  CreateClients1761000000100,
  CreateVehicles1761000000200,
  CreateAuditLog1761000000300,
  AddTenantRuc1761000000400,
  CreateUsers1761000000500,
  CreateSessions1761000000600,
  CreateLoginAttempts1761000000700,
  CreateAuthFunctions1761000000800,
  FixLoginFailurePruneLocking1761000000850,
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
