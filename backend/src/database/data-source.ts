import { DataSource, type DataSourceOptions } from 'typeorm';
import { AuditLog } from '../audit/audit-log.entity.js';
import { Client } from '../clients/client.entity.js';
import { requireEnv } from '../config/env.js';
import { User } from '../users/user.entity.js';
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
import { AddLastAdminTrigger1761000000900 } from './migrations/1761000000900-AddLastAdminTrigger.js';
import { CreateSupportAccounts1761000001000 } from './migrations/1761000001000-CreateSupportAccounts.js';
import { CreateSupportTickets1761000001100 } from './migrations/1761000001100-CreateSupportTickets.js';
import { CreateSupportFunctions1761000001200 } from './migrations/1761000001200-CreateSupportFunctions.js';
import { AllowSupportAuditActor1761000001300 } from './migrations/1761000001300-AllowSupportAuditActor.js';
import { CreateSupportPasswordFunctions1761000001400 } from './migrations/1761000001400-CreateSupportPasswordFunctions.js';
import { CreateSupportAccessLog1761000001500 } from './migrations/1761000001500-CreateSupportAccessLog.js';
import { CreateCheckins1761000001600 } from './migrations/1761000001600-CreateCheckins.js';
import { CreateBudgets1761000001700 } from './migrations/1761000001700-CreateBudgets.js';

// Registered by class reference, never by glob: TypeORM's path loading does not work in ESM.
export const ENTITIES: (new () => object)[] = [Client, Vehicle, AuditLog, User];
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
  AddLastAdminTrigger1761000000900,
  CreateSupportAccounts1761000001000,
  CreateSupportTickets1761000001100,
  CreateSupportFunctions1761000001200,
  AllowSupportAuditActor1761000001300,
  CreateSupportPasswordFunctions1761000001400,
  CreateSupportAccessLog1761000001500,
  CreateCheckins1761000001600,
  CreateBudgets1761000001700,
];

/**
 * Connections of the API pool: pg's default, made explicit. A request holds ONE connection for its
 * whole transaction; work committed apart runs after releasing it (after-release.ts, T049).
 */
export const APP_POOL_SIZE = 10;
/**
 * Upper bound to open a connection or to wait for a free one in the pool (pg
 * connectionTimeoutMillis): an exhausted pool fails the request instead of waiting forever.
 */
export const APP_CONNECT_TIMEOUT_MS = 10_000;

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
    connectTimeoutMS: APP_CONNECT_TIMEOUT_MS,
    extra: { max: APP_POOL_SIZE },
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
