// T002: data fixtures for e2e tests. They connect as motorsync_migrator (DATABASE_MIGRATOR_URL),
// never as the app role: the API under test always uses motorsync_app (research R2).
// Feature 002 (T002 of specs/002-autenticacion) adds the account tables, createUser() and the
// helpers that simulate the passing of time (the e2e never wait 15 or 30 minutes or 72 hours).
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  type ScryptOptions,
} from 'node:crypto';
import pg from 'pg';

const BUSINESS_TABLES = [
  'clients',
  'vehicles',
  'audit_log',
  'tenants',
  'users',
  'user_sessions',
  'refresh_tokens',
  'login_attempts',
] as const;

let pool: pg.Pool | undefined;

function migratorPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_MIGRATOR_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_MIGRATOR_URL is not set in the e2e environment',
      );
    }
    pool = new pg.Pool({ connectionString, max: 2 });
  }
  return pool;
}

export interface TenantFixture {
  id: string;
  name: string;
  /** Only present when createTenant() received a RUC (column added by feature 002). */
  ruc?: string | null;
}

export async function createTenant(
  name: string,
  ruc?: string,
): Promise<TenantFixture> {
  if (ruc === undefined) {
    const result = await migratorPool().query<TenantFixture>(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name',
      [name],
    );
    return result.rows[0];
  }
  const result = await migratorPool().query<TenantFixture>(
    'INSERT INTO tenants (name, ruc) VALUES ($1, $2) RETURNING id, name, ruc',
    [name, ruc],
  );
  return result.rows[0];
}

/**
 * TRUNCATE clients, vehicles, audit_log, tenants, users, user_sessions, refresh_tokens and
 * login_attempts CASCADE, skipping the tables that do not exist yet (each migration adds its
 * own, so earlier PRs only have some of them).
 */
export async function truncateBusinessTables(): Promise<void> {
  const db = migratorPool();
  const existing = await db.query<{ name: string }>(
    `SELECT t.name
       FROM unnest($1::text[]) AS t(name)
      WHERE to_regclass('public.' || t.name) IS NOT NULL`,
    [[...BUSINESS_TABLES]],
  );
  if (existing.rows.length === 0) return;
  const tables = existing.rows
    .map((row: { name: string }) => `public."${row.name}"`)
    .join(', ');
  await db.query(`TRUNCATE ${tables} CASCADE`);
}

/** Closes the fixtures pool; call it in afterAll of each suite that uses the fixtures. */
export async function closeFixtures(): Promise<void> {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}

// ---------------------------------------------------------------------------------------------
// Feature 002: accounts, sessions and simulated time.
// ---------------------------------------------------------------------------------------------

export type UserRole = 'asesor' | 'admin';
export type UserStatus = 'active' | 'inactive';

/** Same normalization as the API (FR-003): trim and lower case. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** SHA-256 hex of the normalized email, UTF-8 (data-model: `login_attempts.email_hash`). */
export function emailHash(email: string): string {
  return createHash('sha256')
    .update(normalizeEmail(email), 'utf8')
    .digest('hex');
}

// research R3: N = 2^15, r = 8, p = 1, keylen = 64, maxmem = 64 MiB.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function scryptAsync(
  password: string,
  salt: Buffer,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * Hash in the format of research R3, `scrypt$32768$8$1$<salt base64url>$<hash base64url>`,
 * computed here without importing production code, so the API must accept the standard format.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export interface CreateUserOptions {
  tenantId: string;
  name: string;
  email: string;
  role: UserRole;
  password: string;
  /** Default: 'active'. */
  status?: UserStatus;
  /** Default: false, or true when tempPasswordExpiresAt is given. */
  mustChangePassword?: boolean;
  /** Default when mustChangePassword is true: now + 72 h (FR-026). */
  tempPasswordExpiresAt?: Date;
}

export interface UserFixture {
  id: string;
  tenantId: string;
  name: string;
  /** Normalized (trimmed, lower case), as stored. */
  email: string;
  role: UserRole;
  status: UserStatus;
  /** The plain password, to log in with it. */
  password: string;
  mustChangePassword: boolean;
  tempPasswordExpiresAt: Date | null;
}

/** Runs fn in a migrator transaction with app.tenant_id pinned (FORCE RLS reaches the owner). */
async function inMigratorTenant<T>(
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await migratorPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
      tenantId,
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The tables of feature 002 have FORCE RLS, so the migrator only sees the rows of the pinned
 * tenant. Helpers that only receive a row id try each tenant (tenants has no FORCE) inside one
 * transaction until `fn` reports that it affected a row.
 */
async function inEachMigratorTenant(
  fn: (client: pg.PoolClient, tenantId: string) => Promise<boolean>,
): Promise<boolean> {
  const client = await migratorPool().connect();
  try {
    await client.query('BEGIN');
    const tenants = await client.query<{ id: string }>(
      'SELECT id FROM tenants ORDER BY id',
    );
    let found = false;
    for (const tenant of tenants.rows) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenant.id,
      ]);
      if (await fn(client, tenant.id)) {
        found = true;
        break;
      }
    }
    await client.query('COMMIT');
    return found;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function assertFound(found: boolean, what: string): void {
  if (!found) throw new Error(`db-fixtures: ${what} not found in any tenant`);
}

/** Inserts an account as the migrator under its tenant, with a scrypt hash of `password`. */
export async function createUser(
  options: CreateUserOptions,
): Promise<UserFixture> {
  const id = randomUUID();
  const email = normalizeEmail(options.email);
  const status = options.status ?? 'active';
  const mustChangePassword =
    options.mustChangePassword ?? options.tempPasswordExpiresAt !== undefined;
  const tempPasswordExpiresAt = mustChangePassword
    ? (options.tempPasswordExpiresAt ?? new Date(Date.now() + 72 * 3600 * 1000))
    : (options.tempPasswordExpiresAt ?? null);
  const passwordHash = await hashPassword(options.password);

  await inMigratorTenant(options.tenantId, (client) =>
    client.query(
      `INSERT INTO users (id, tenant_id, name, email, password_hash, role, status,
                          must_change_password, temp_password_expires_at,
                          created_by, updated_by, updated_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $1, $1, $3)`,
      [
        id,
        options.tenantId,
        options.name,
        email,
        passwordHash,
        options.role,
        status,
        mustChangePassword,
        tempPasswordExpiresAt,
      ],
    ),
  );

  return {
    id,
    tenantId: options.tenantId,
    name: options.name,
    email,
    role: options.role,
    status,
    password: options.password,
    mustChangePassword,
    tempPasswordExpiresAt,
  };
}

/** Moves `user_sessions.last_activity_at` to `minutesAgo` minutes in the past (FR-012). */
export async function setSessionLastActivity(
  sessionId: string,
  minutesAgo: number,
): Promise<void> {
  const found = await inEachMigratorTenant(async (client) => {
    const result = await client.query(
      `UPDATE user_sessions
          SET last_activity_at = now() - ($2::double precision * interval '1 minute')
        WHERE id = $1`,
      [sessionId, minutesAgo],
    );
    return (result.rowCount ?? 0) > 0;
  });
  assertFound(found, `session ${sessionId}`);
}

/**
 * Sets `users.temp_password_expires_at` to now + `hoursFromNow` (negative: already expired) and
 * `must_change_password = true`, keeping users_temp_password_coherent (FR-026).
 */
export async function setTemporaryPasswordExpiry(
  userId: string,
  hoursFromNow: number,
): Promise<void> {
  const found = await inEachMigratorTenant(async (client) => {
    const result = await client.query(
      `UPDATE users
          SET must_change_password = true,
              temp_password_expires_at = now() + ($2::double precision * interval '1 hour')
        WHERE id = $1`,
      [userId, hoursFromNow],
    );
    return (result.rowCount ?? 0) > 0;
  });
  assertFound(found, `user ${userId}`);
}

/**
 * Upserts the `login_attempts` row of `email` with `failed_count = 5` and `locked_until` at
 * now + `minutesFromNow` (negative: a lock that already expired). FR-009.
 */
export async function setLockedUntil(
  email: string,
  minutesFromNow: number,
): Promise<void> {
  await migratorPool().query(
    `INSERT INTO login_attempts (email_hash, failed_count, locked_until, updated_at)
          VALUES ($1, 5, now() + ($2::double precision * interval '1 minute'), now())
     ON CONFLICT (email_hash) DO UPDATE
           SET failed_count = EXCLUDED.failed_count,
               locked_until = EXCLUDED.locked_until,
               updated_at = EXCLUDED.updated_at`,
    [emailHash(email), minutesFromNow],
  );
}

/** Moves `refresh_tokens.rotated_at` to `secondsAgo` seconds in the past (marks it as rotated). */
export async function setRefreshRotatedAt(
  tokenHash: string,
  secondsAgo: number,
): Promise<void> {
  const found = await inEachMigratorTenant(async (client) => {
    const result = await client.query(
      `UPDATE refresh_tokens
          SET rotated_at = now() - ($2::double precision * interval '1 second')
        WHERE token_hash = $1`,
      [tokenHash, secondsAgo],
    );
    return (result.rowCount ?? 0) > 0;
  });
  assertFound(found, `refresh token ${tokenHash}`);
}

export interface UserSessionRow {
  id: string;
  tenantId: string;
  userId: string;
  createdAt: Date;
  lastActivityAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  ip: string | null;
}

/** Sessions of an account, oldest first (empty if it has none). */
export async function readUserSessions(
  userId: string,
): Promise<UserSessionRow[]> {
  let rows: UserSessionRow[] = [];
  await inEachMigratorTenant(async (client) => {
    const result = await client.query<UserSessionRow>(
      `SELECT id, tenant_id AS "tenantId", user_id AS "userId", created_at AS "createdAt",
              last_activity_at AS "lastActivityAt", revoked_at AS "revokedAt",
              revoke_reason AS "revokeReason", ip
         FROM user_sessions
        WHERE user_id = $1
        ORDER BY created_at, id`,
      [userId],
    );
    rows = result.rows;
    return rows.length > 0;
  });
  return rows;
}

export interface AuditLogRow {
  id: string;
  tenantId: string;
  actorUserId: string;
  actorName: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  occurredAt: Date;
  ip: string | null;
  channel: string;
}

/** audit_log entries of an entity in a tenant, oldest first. */
export async function readAuditLog(
  tenantId: string,
  entityId: string,
): Promise<AuditLogRow[]> {
  return inMigratorTenant(tenantId, async (client) => {
    const result = await client.query<AuditLogRow>(
      `SELECT id, tenant_id AS "tenantId", actor_user_id AS "actorUserId",
              actor_name AS "actorName", actor_role AS "actorRole", action,
              entity_type AS "entityType", entity_id AS "entityId", before, after, reason,
              occurred_at AS "occurredAt", ip, channel
         FROM audit_log
        WHERE entity_id = $1
        ORDER BY occurred_at, id`,
      [entityId],
    );
    return result.rows;
  });
}
