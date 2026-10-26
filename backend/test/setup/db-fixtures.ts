// T002: data fixtures for e2e tests. They connect as motorsync_migrator (DATABASE_MIGRATOR_URL),
// never as the app role: the API under test always uses motorsync_app (research R2).
// Feature 002 (T002 of specs/002-autenticacion) adds the account tables, createUser() and the
// helpers that simulate the passing of time (the e2e never wait 15 or 30 minutes or 72 hours).
// Feature 003 (T003 of specs/003-soporte-plataforma) adds the support platform tables,
// createSupportAccount(), createTicket() and the helpers of its simulated time (research R8, R9).
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
  // Feature 003 (specs/003-soporte-plataforma). support_access_log only exists from the PR3
  // migration on; truncateBusinessTables() skips the tables that do not exist yet.
  'support_accounts',
  'support_sessions',
  'support_refresh_tokens',
  'support_tickets',
  'support_ticket_events',
  'help_request_throttle',
  'support_access_log',
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
 * TRUNCATE clients, vehicles, audit_log, tenants, users, user_sessions, refresh_tokens,
 * login_attempts and the feature 003 support tables CASCADE, skipping the tables that do not
 * exist yet (each migration adds its own, so earlier PRs only have some of them).
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

// ---------------------------------------------------------------------------------------------
// Feature 003 (T003 of specs/003-soporte-plataforma): support platform, tickets and simulated
// time. support_accounts, support_sessions and support_refresh_tokens have RLS ENABLE without
// FORCE (research R2), so the migrator (their owner) reads and writes them directly, with no
// tenant pinned; support_tickets and support_ticket_events work the same way.
// ---------------------------------------------------------------------------------------------

export type SupportAccountStatus = 'active' | 'inactive';
export type TicketStatus = 'open' | 'resolved' | 'discarded';
export type TicketEventAction = 'discarded' | 'temporary_password_generated';

export interface CreateSupportAccountOptions {
  name: string;
  email: string;
  password: string;
  /** Default: 'active'. */
  status?: SupportAccountStatus;
  /** Default: false, or true when tempPasswordExpiresAt is given. */
  mustChangePassword?: boolean;
  /** Default when mustChangePassword is true: now + 72 h (research R5). */
  tempPasswordExpiresAt?: Date;
}

export interface SupportAccountFixture {
  id: string;
  name: string;
  /** Normalized (trimmed, lower case), as stored. */
  email: string;
  status: SupportAccountStatus;
  /** The plain password, to log in with it. */
  password: string;
  mustChangePassword: boolean;
  tempPasswordExpiresAt: Date | null;
}

/**
 * Inserts a support account as the migrator. Support accounts belong to the platform, not to a
 * tenant (research R2): no tenant is pinned and no workshop is created. The hash is the same
 * scrypt format as createUser() (research R3 of feature 002).
 *
 * must_change_password and temp_password_expires_at are kept coherent with
 * support_accounts_temp_password_coherent: a date without an explicit mustChangePassword implies
 * true, and mustChangePassword false ignores the date.
 */
export async function createSupportAccount(
  options: CreateSupportAccountOptions,
): Promise<SupportAccountFixture> {
  const id = randomUUID();
  const email = normalizeEmail(options.email);
  const status = options.status ?? 'active';
  const mustChangePassword =
    options.mustChangePassword ?? options.tempPasswordExpiresAt !== undefined;
  const tempPasswordExpiresAt = mustChangePassword
    ? (options.tempPasswordExpiresAt ?? new Date(Date.now() + 72 * 3600 * 1000))
    : null;
  const passwordHash = await hashPassword(options.password);

  await migratorPool().query(
    `INSERT INTO support_accounts (id, name, email, password_hash, status,
                                   must_change_password, temp_password_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      options.name,
      email,
      passwordHash,
      status,
      mustChangePassword,
      tempPasswordExpiresAt,
    ],
  );

  return {
    id,
    name: options.name,
    email,
    status,
    password: options.password,
    mustChangePassword,
    tempPasswordExpiresAt,
  };
}

/** Full row of support_tickets, with the closing columns (data-model, PR1). */
export interface TicketFixture {
  id: string;
  /** bigint in PostgreSQL: pg returns it as a string. */
  number: string;
  tenantId: string;
  userId: string;
  email: string;
  status: TicketStatus;
  createdAt: Date;
  lastRequestedAt: Date;
  requestCount: number;
  verificationNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  discardReason: string | null;
  discardedBy: string | null;
  discardedAt: Date | null;
}

export interface CreateTicketOptions {
  tenantId: string;
  userId: string;
  email: string;
  /** Default: 'open'. */
  status?: TicketStatus;
  /** Default: 1 (support_tickets_request_count_check). */
  requestCount?: number;
  /**
   * Support account stored in resolved_by / discarded_by. Default: the oldest existing support
   * account; if there is none, a fixture agent is created on demand (see below).
   */
  agentId?: string;
  /** Default: a generic identity-verification note (1–1000 characters). */
  verificationNote?: string;
  /** Default: a generic discard reason (1–500 characters). */
  discardReason?: string;
  /** Default: now(). It also becomes last_requested_at, to control the inbox order. */
  createdAt?: Date;
}

/** Email of the support agent that createTicket() creates when it needs a closing actor. */
const FIXTURE_AGENT_EMAIL = 'soporte.fixture@motorsync.ec';
const FIXTURE_AGENT_PASSWORD = 'Soporte-Fixture-123';
const DEFAULT_VERIFICATION_NOTE =
  'Identidad verificada por teléfono con el administrador del taller.';
const DEFAULT_DISCARD_REASON =
  'Solicitud duplicada; el taller resolvió el acceso por otra vía.';

const TICKET_COLUMNS = `id, number::text AS number, tenant_id AS "tenantId", user_id AS "userId",
       email, status, created_at AS "createdAt", last_requested_at AS "lastRequestedAt",
       request_count AS "requestCount", verification_note AS "verificationNote",
       resolved_by AS "resolvedBy", resolved_at AS "resolvedAt",
       discard_reason AS "discardReason", discarded_by AS "discardedBy",
       discarded_at AS "discardedAt"`;

/**
 * Actor of a closing ticket. resolved_by and discarded_by are NOT NULL for closed tickets
 * (support_tickets_state_coherent), so a support account is required: the one the caller passes,
 * the oldest one in the database, or a fixture agent created on demand. ON CONFLICT keeps two
 * parallel suites from racing on the fixture email.
 */
async function supportAccountForClosing(agentId?: string): Promise<string> {
  if (agentId !== undefined) return agentId;
  const existing = await migratorPool().query<{ id: string }>(
    'SELECT id FROM support_accounts ORDER BY created_at, id LIMIT 1',
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const passwordHash = await hashPassword(FIXTURE_AGENT_PASSWORD);
  const inserted = await migratorPool().query<{ id: string }>(
    `INSERT INTO support_accounts (name, email, password_hash, must_change_password,
                                   temp_password_expires_at)
          VALUES ($1, $2, $3, false, NULL)
     ON CONFLICT (email) DO NOTHING
       RETURNING id`,
    ['Soporte Fixture', FIXTURE_AGENT_EMAIL, passwordHash],
  );
  if (inserted.rows.length > 0) return inserted.rows[0].id;

  const again = await migratorPool().query<{ id: string }>(
    'SELECT id FROM support_accounts WHERE email = $1',
    [FIXTURE_AGENT_EMAIL],
  );
  return again.rows[0].id;
}

/**
 * Inserts a ticket as the migrator (research R6). `resolved` and `discarded` are inserted as
 * `open` and then closed in a second statement with the closing data that
 * support_tickets_state_coherent requires (note or reason, actor and timestamp).
 *
 * A second `open` ticket for the same account is rejected by
 * support_tickets_one_open_per_user (23505): the helper respects the index instead of bypassing
 * it. A closed ticket is immutable (support_tickets_guard), which is why the insert happens as
 * `open` first.
 */
export async function createTicket(
  options: CreateTicketOptions,
): Promise<TicketFixture> {
  const email = normalizeEmail(options.email);
  const requestCount = options.requestCount ?? 1;
  const createdAt = options.createdAt ?? null;

  const inserted = await migratorPool().query<TicketFixture>(
    `INSERT INTO support_tickets (tenant_id, user_id, email, request_count,
                                  created_at, last_requested_at)
          VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()),
                  COALESCE($5::timestamptz, now()))
       RETURNING ${TICKET_COLUMNS}`,
    [options.tenantId, options.userId, email, requestCount, createdAt],
  );
  let ticket = inserted.rows[0];

  const status = options.status ?? 'open';
  if (status === 'resolved') {
    const agentId = await supportAccountForClosing(options.agentId);
    const updated = await migratorPool().query<TicketFixture>(
      `UPDATE support_tickets
          SET status = 'resolved',
              verification_note = $2,
              resolved_by = $3,
              resolved_at = now()
        WHERE id = $1
    RETURNING ${TICKET_COLUMNS}`,
      [
        ticket.id,
        options.verificationNote ?? DEFAULT_VERIFICATION_NOTE,
        agentId,
      ],
    );
    ticket = updated.rows[0];
  } else if (status === 'discarded') {
    const agentId = await supportAccountForClosing(options.agentId);
    const updated = await migratorPool().query<TicketFixture>(
      `UPDATE support_tickets
          SET status = 'discarded',
              discard_reason = $2,
              discarded_by = $3,
              discarded_at = now()
        WHERE id = $1
    RETURNING ${TICKET_COLUMNS}`,
      [ticket.id, options.discardReason ?? DEFAULT_DISCARD_REASON, agentId],
    );
    ticket = updated.rows[0];
  }

  return ticket;
}

function assertAffected(rowCount: number | null, what: string): void {
  if (!rowCount) throw new Error(`db-fixtures: ${what} not found`);
}

/** Moves support_sessions.last_activity_at to `minutesAgo` minutes in the past (research R1). */
export async function setSupportSessionLastActivity(
  sessionId: string,
  minutesAgo: number,
): Promise<void> {
  const result = await migratorPool().query(
    `UPDATE support_sessions
        SET last_activity_at = now() - ($2::double precision * interval '1 minute')
      WHERE id = $1`,
    [sessionId, minutesAgo],
  );
  assertAffected(result.rowCount, `support session ${sessionId}`);
}

/**
 * Sets support_accounts.temp_password_expires_at to now + `hoursFromNow` (negative: already
 * expired) and must_change_password = true, keeping support_accounts_temp_password_coherent.
 */
export async function setSupportTemporaryPasswordExpiry(
  accountId: string,
  hoursFromNow: number,
): Promise<void> {
  const result = await migratorPool().query(
    `UPDATE support_accounts
        SET must_change_password = true,
            temp_password_expires_at = now() + ($2::double precision * interval '1 hour'),
            updated_at = now()
      WHERE id = $1`,
    [accountId, hoursFromNow],
  );
  assertAffected(result.rowCount, `support account ${accountId}`);
}

/** Moves support_refresh_tokens.rotated_at to `secondsAgo` seconds in the past (marks it as rotated). */
export async function setSupportRefreshRotatedAt(
  tokenHash: string,
  secondsAgo: number,
): Promise<void> {
  const result = await migratorPool().query(
    `UPDATE support_refresh_tokens
        SET rotated_at = now() - ($2::double precision * interval '1 second')
      WHERE token_hash = $1`,
    [tokenHash, secondsAgo],
  );
  assertAffected(result.rowCount, `support refresh token ${tokenHash}`);
}

/**
 * Upserts the help_request_throttle row of an origin with `count` requests and a window that
 * started `minutesAgo` minutes ago (research R8; the CHECK allows 1 to 21).
 */
export async function setHelpThrottle(
  originHash: string,
  count: number,
  minutesAgo: number,
): Promise<void> {
  await migratorPool().query(
    `INSERT INTO help_request_throttle (origin_hash, window_started_at, request_count, updated_at)
          VALUES ($1, now() - ($3::double precision * interval '1 minute'), $2, now())
     ON CONFLICT (origin_hash) DO UPDATE
           SET window_started_at = EXCLUDED.window_started_at,
               request_count = EXCLUDED.request_count,
               updated_at = EXCLUDED.updated_at`,
    [originHash, count, minutesAgo],
  );
}

/** SHA-256 hex of the origin IP, UTF-8: what help_request_throttle.origin_hash stores (research R8). */
export function originHash(ip: string): string {
  return createHash('sha256').update(ip, 'utf8').digest('hex');
}

/** Tickets of an account, oldest first (empty if it has none). */
export async function readTickets(userId: string): Promise<TicketFixture[]> {
  const result = await migratorPool().query<TicketFixture>(
    `SELECT ${TICKET_COLUMNS}
       FROM support_tickets
      WHERE user_id = $1
      ORDER BY created_at, number`,
    [userId],
  );
  return result.rows;
}

export interface TicketEventRow {
  id: string;
  ticketId: string;
  supportAccountId: string;
  action: TicketEventAction;
  fromStatus: string;
  toStatus: string;
  occurredAt: Date;
  ip: string | null;
}

/** support_ticket_events of a ticket, oldest first (append-only history). */
export async function readTicketEvents(
  ticketId: string,
): Promise<TicketEventRow[]> {
  const result = await migratorPool().query<TicketEventRow>(
    `SELECT id, ticket_id AS "ticketId", support_account_id AS "supportAccountId",
            action, from_status AS "fromStatus", to_status AS "toStatus",
            occurred_at AS "occurredAt", ip
       FROM support_ticket_events
      WHERE ticket_id = $1
      ORDER BY occurred_at, id`,
    [ticketId],
  );
  return result.rows;
}

export interface SupportSessionRow {
  id: string;
  supportAccountId: string;
  createdAt: Date;
  lastActivityAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  ip: string | null;
}

/** Sessions of a support account, oldest first (empty if it has none). */
export async function readSupportSessions(
  accountId: string,
): Promise<SupportSessionRow[]> {
  const result = await migratorPool().query<SupportSessionRow>(
    `SELECT id, support_account_id AS "supportAccountId", created_at AS "createdAt",
            last_activity_at AS "lastActivityAt", revoked_at AS "revokedAt",
            revoke_reason AS "revokeReason", ip
       FROM support_sessions
      WHERE support_account_id = $1
      ORDER BY created_at, id`,
    [accountId],
  );
  return result.rows;
}

/**
 * Rows of a table, as the migrator. Tables with FORCE RLS (users, user_sessions, audit_log,
 * clients, vehicles) only show the rows of the pinned tenant, so their count is the sum over
 * every tenant; the rest (tenants, login_attempts and the feature 003 tables) are counted
 * directly. Throws if the table does not exist (for example support_access_log before PR3).
 */
export async function countRows(table: string): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(
      `db-fixtures: countRows() got an invalid table name "${table}"`,
    );
  }
  const meta = await migratorPool().query<{ force: boolean }>(
    `SELECT c.relforcerowsecurity AS "force"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r', 'p')`,
    [table],
  );
  const info = meta.rows[0];
  if (!info) {
    throw new Error(`db-fixtures: table public."${table}" does not exist`);
  }

  if (!info.force) {
    const result = await migratorPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public."${table}"`,
    );
    return result.rows[0].count;
  }

  const client = await migratorPool().connect();
  try {
    await client.query('BEGIN');
    const tenants = await client.query<{ id: string }>(
      'SELECT id FROM tenants ORDER BY id',
    );
    let total = 0;
    for (const tenant of tenants.rows) {
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenant.id,
      ]);
      const result = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM public."${table}"`,
      );
      total += result.rows[0].count;
    }
    await client.query('COMMIT');
    return total;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
