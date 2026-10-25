import { Inject, Injectable } from '@nestjs/common';
import type { AuditAction, AuditActorRole } from '../audit/audit-log.entity.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthRole } from '../auth/auth-user.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { translatePgError } from '../database/pg-errors.js';
import { getManager, getTenantContext } from '../database/tenant-context.js';
import { applyTemporaryPassword } from './apply-temporary-password.js';
import type { ChangeRoleDto } from './dto/change-role.dto.js';
import type { CreateUserDto } from './dto/create-user.dto.js';
import type { ResetPasswordDto } from './dto/reset-password.dto.js';
import type { UserStatus } from './user.entity.js';

export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertValidUserId(userId: string): void {
  if (typeof userId !== 'string' || !UUID_REGEX.test(userId)) {
    throw new ProblemException(404, 'NOT_FOUND');
  }
}

/** Contract `UserAccount` (never exposes passwordHash or tenantId). */
export interface UserAccount {
  id: string;
  name: string;
  email: string;
  role: AuthRole;
  status: UserStatus;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedByName: string;
}

/** Contract `UserAuditEntry` for user change history. */
export interface UserAuditEntry {
  id: string;
  action: AuditAction;
  actorName: string;
  actorRole: AuditActorRole;
  occurredAt: string;
  before: Record<string, string | number | boolean | null> | null;
  after: Record<string, string | number | boolean | null> | null;
  ip: string | null;
  channel?: string;
}

interface UserAccountRow {
  id: string;
  name: string;
  email: string;
  role: AuthRole;
  status: UserStatus;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  updatedByName: string;
}

interface AuditLogRow {
  id: string;
  action: AuditAction;
  actorName: string;
  actorRole: AuditActorRole;
  occurredAt: Date | string;
  before: Record<string, string | number | boolean | null> | null;
  after: Record<string, string | number | boolean | null> | null;
  ip: string | null;
  channel: string;
}

/**
 * TypeORM's manager.query on UPDATE/DELETE returns [rows, rowCount] in PostgreSQL.
 * If raw is already an array of rows, we handle both shapes gracefully.
 */
function extractRows<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) {
    if (raw.length === 2 && Array.isArray(raw[0]) && typeof raw[1] === 'number') {
      return raw[0] as T[];
    }
    return raw as T[];
  }
  return [];
}

function extractRowCount(raw: unknown): number {
  if (Array.isArray(raw) && raw.length === 2 && typeof raw[1] === 'number') {
    return raw[1];
  }
  if (Array.isArray(raw)) {
    return raw.length;
  }
  return 0;
}

function toUserAccount(row: UserAccountRow): UserAccount {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    mustChangePassword: Boolean(row.mustChangePassword),
    temporaryPasswordExpiresAt: row.temporaryPasswordExpiresAt
      ? new Date(row.temporaryPasswordExpiresAt).toISOString()
      : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    updatedByName: row.updatedByName,
  };
}

/**
 * Account management of the workshop (US4). Lock order of every mutation (research R8):
 *   1. pg_advisory_xact_lock of the workshop: taken by TenantTransactionInterceptor before the
 *      session check on the handlers marked with @LocksTenantAdmins() (changeRole, deactivate,
 *      reactivate, resetPassword). These methods rely on it and do not take it again.
 *   2. The actor's own user_sessions row (SessionValidator, in the interceptor).
 *   3. The user_sessions rows of the target account (revocation).
 *   4. The users row of the target account.
 * POST /auth/password also holds the workshop lock (@LocksTenantAdmins): it locks its own session,
 * then the users row, then the OTHER sessions of the account. Without the shared lock, a reset or
 * deactivation of that account locks the same session rows in another order (40P01) whenever the
 * account has more than one open session. 3 before 4 keeps the session -> account order anyway.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Lists all user accounts of the tenant, ordered by status, name.
   * Runs under RLS: never reveals other tenants' users.
   */
  async list(): Promise<{ items: UserAccount[] }> {
    const manager = getManager();
    const rows = await manager.query<UserAccountRow[]>(
      `SELECT id, name, email, role, status,
              must_change_password AS "mustChangePassword",
              temp_password_expires_at AS "temporaryPasswordExpiresAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              updated_by_name AS "updatedByName"
         FROM users
        ORDER BY status, name`,
    );
    return { items: rows.map(toUserAccount) };
  }

  /**
   * Retrieves a single user account by its id.
   */
  async getById(id: string): Promise<UserAccount> {
    assertValidUserId(id);
    const manager = getManager();
    const rows = await manager.query<UserAccountRow[]>(
      `SELECT id, name, email, role, status,
              must_change_password AS "mustChangePassword",
              temp_password_expires_at AS "temporaryPasswordExpiresAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              updated_by_name AS "updatedByName"
         FROM users
        WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      throw new ProblemException(404, 'NOT_FOUND');
    }
    return toUserAccount(rows[0]);
  }

  /**
   * Creates a new user with a temporary password (72h expiry).
   * Checks email collision globally -> 409 EMAIL_UNAVAILABLE.
   */
  async create(dto: CreateUserDto): Promise<UserAccount> {
    const { manager, user } = getTenantContext();
    const passwordHash = await this.hasher.hash(dto.temporaryPassword);

    // No SAVEPOINT: a unique violation aborts the transaction, but the 409 rolls the whole request
    // back anyway (TenantTransactionInterceptor) and nothing else runs on it after the INSERT.
    let rows: UserAccountRow[];
    try {
      rows = await manager.query<UserAccountRow[]>(
        `INSERT INTO users (
           name, email, password_hash, role, status,
           must_change_password, temp_password_expires_at,
           created_by, updated_by, updated_by_name
         ) VALUES (
           $1, $2, $3, $4, 'active',
           true, now() + interval '72 hours',
           $5, $5, $6
         )
         RETURNING id, name, email, role, status,
                   must_change_password AS "mustChangePassword",
                   temp_password_expires_at AS "temporaryPasswordExpiresAt",
                   created_at AS "createdAt",
                   updated_at AS "updatedAt",
                   updated_by_name AS "updatedByName"`,
        [dto.name, dto.email, passwordHash, dto.role, user.userId, user.name],
      );
    } catch (error: unknown) {
      const translated = translatePgError(error);
      if (translated && translated.code === 'EMAIL_UNAVAILABLE') {
        throw new ProblemException(409, 'EMAIL_UNAVAILABLE');
      }
      throw error;
    }

    return toUserAccount(rows[0]);
  }

  /**
   * Changes the role of a user account.
   * Protects the last active admin: the workshop advisory lock (@LocksTenantAdmins, taken by the
   * interceptor) + active admin count check.
   * Idempotent: returning existing user if role is unchanged (no audit).
   */
  async changeRole(targetUserId: string, dto: ChangeRoleDto): Promise<UserAccount> {
    assertValidUserId(targetUserId);
    const { manager, user } = getTenantContext();

    const currentRows = await manager.query<UserAccountRow[]>(
      `SELECT id, role, status, name, email,
              must_change_password AS "mustChangePassword",
              temp_password_expires_at AS "temporaryPasswordExpiresAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              updated_by_name AS "updatedByName"
         FROM users
        WHERE id = $1`,
      [targetUserId],
    );
    if (currentRows.length === 0) {
      throw new ProblemException(404, 'NOT_FOUND');
    }

    const current = currentRows[0];
    if (current.role === dto.role) {
      return toUserAccount(current);
    }

    if (current.role === 'admin' && dto.role !== 'admin' && current.status === 'active') {
      const countResult = await manager.query<{ count: string | number }[]>(
        `SELECT count(*) AS count FROM users WHERE role = 'admin' AND status = 'active' AND id <> $1`,
        [targetUserId],
      );
      const count = Number(countResult[0]?.count ?? 0);
      if (count === 0) {
        throw new ProblemException(409, 'LAST_ADMIN');
      }
    }

    const rawUpdated = await manager.query(
      `UPDATE users
          SET role = $2, updated_at = now(), updated_by = $3, updated_by_name = $4
        WHERE id = $1
        RETURNING id, name, email, role, status,
                  must_change_password AS "mustChangePassword",
                  temp_password_expires_at AS "temporaryPasswordExpiresAt",
                  created_at AS "createdAt",
                  updated_at AS "updatedAt",
                  updated_by_name AS "updatedByName"`,
      [targetUserId, dto.role, user.userId, user.name],
    );
    const updatedRows = extractRows<UserAccountRow>(rawUpdated);

    await this.audit.record({
      action: 'user.role_changed',
      entityType: 'user',
      entityId: targetUserId,
      before: { role: current.role },
      after: { role: dto.role },
    });

    return toUserAccount(updatedRows[0]);
  }

  /**
   * Deactivates a user account and revokes all active sessions.
   * Protects the last active admin: the workshop advisory lock (@LocksTenantAdmins, taken by the
   * interceptor) + active admin count check.
   * Idempotent: returning existing user if already inactive (no audit).
   */
  async deactivate(targetUserId: string): Promise<UserAccount> {
    assertValidUserId(targetUserId);
    const { manager, user } = getTenantContext();

    const currentRows = await manager.query<UserAccountRow[]>(
      `SELECT id, role, status, name, email,
              must_change_password AS "mustChangePassword",
              temp_password_expires_at AS "temporaryPasswordExpiresAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              updated_by_name AS "updatedByName"
         FROM users
        WHERE id = $1`,
      [targetUserId],
    );
    if (currentRows.length === 0) {
      throw new ProblemException(404, 'NOT_FOUND');
    }

    const current = currentRows[0];
    if (current.status === 'inactive') {
      return toUserAccount(current);
    }

    if (current.role === 'admin') {
      const countResult = await manager.query<{ count: string | number }[]>(
        `SELECT count(*) AS count FROM users WHERE role = 'admin' AND status = 'active' AND id <> $1`,
        [targetUserId],
      );
      const count = Number(countResult[0]?.count ?? 0);
      if (count === 0) {
        throw new ProblemException(409, 'LAST_ADMIN');
      }
    }

    // Sessions before the account: the session -> users order of POST /auth/password (R8).
    const rawRevoked = await manager.query(
      `UPDATE user_sessions
          SET revoked_at = now(), revoke_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [targetUserId, 'deactivated'],
    );
    const sessionsClosed = extractRowCount(rawRevoked);

    const rawUpdated = await manager.query(
      `UPDATE users
          SET status = 'inactive', updated_at = now(), updated_by = $2, updated_by_name = $3
        WHERE id = $1
        RETURNING id, name, email, role, status,
                  must_change_password AS "mustChangePassword",
                  temp_password_expires_at AS "temporaryPasswordExpiresAt",
                  created_at AS "createdAt",
                  updated_at AS "updatedAt",
                  updated_by_name AS "updatedByName"`,
      [targetUserId, user.userId, user.name],
    );
    const updatedRows = extractRows<UserAccountRow>(rawUpdated);

    await this.audit.record({
      action: 'user.deactivated',
      entityType: 'user',
      entityId: targetUserId,
      before: { status: 'active' },
      after: { status: 'inactive', sessionsClosed },
    });

    return toUserAccount(updatedRows[0]);
  }

  /**
   * Reactivates an inactive user account. Runs under the workshop advisory lock
   * (@LocksTenantAdmins, taken by the interceptor) like every status change (R8).
   * Idempotent: returning existing user if already active (no audit).
   */
  async reactivate(targetUserId: string): Promise<UserAccount> {
    assertValidUserId(targetUserId);
    const { manager, user } = getTenantContext();

    const currentRows = await manager.query<UserAccountRow[]>(
      `SELECT id, role, status, name, email,
              must_change_password AS "mustChangePassword",
              temp_password_expires_at AS "temporaryPasswordExpiresAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              updated_by_name AS "updatedByName"
         FROM users
        WHERE id = $1`,
      [targetUserId],
    );
    if (currentRows.length === 0) {
      throw new ProblemException(404, 'NOT_FOUND');
    }

    const current = currentRows[0];
    if (current.status === 'active') {
      return toUserAccount(current);
    }

    const rawUpdated = await manager.query(
      `UPDATE users
          SET status = 'active', updated_at = now(), updated_by = $2, updated_by_name = $3
        WHERE id = $1
        RETURNING id, name, email, role, status,
                  must_change_password AS "mustChangePassword",
                  temp_password_expires_at AS "temporaryPasswordExpiresAt",
                  created_at AS "createdAt",
                  updated_at AS "updatedAt",
                  updated_by_name AS "updatedByName"`,
      [targetUserId, user.userId, user.name],
    );
    const updatedRows = extractRows<UserAccountRow>(rawUpdated);

    await this.audit.record({
      action: 'user.reactivated',
      entityType: 'user',
      entityId: targetUserId,
      before: { status: 'inactive' },
      after: { status: 'active' },
    });

    return toUserAccount(updatedRows[0]);
  }

  /**
   * Resets another user's password with a temporary password (72h expiry). Runs under the
   * workshop advisory lock (@LocksTenantAdmins, taken by the interceptor).
   * Revokes all active sessions of the user, clears login attempt lockouts,
   * and records an audit log entry without exposing passwords.
   */
  async resetPassword(targetUserId: string, dto: ResetPasswordDto): Promise<UserAccount> {
    assertValidUserId(targetUserId);
    const { manager, user } = getTenantContext();

    if (targetUserId === user.userId) {
      throw new ProblemException(409, 'SELF_RESET_NOT_ALLOWED');
    }

    const currentRows = await manager.query<UserAccountRow[]>(
      `SELECT id, role, status, name, email,
              must_change_password AS "mustChangePassword",
              temp_password_expires_at AS "temporaryPasswordExpiresAt",
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              updated_by_name AS "updatedByName"
         FROM users
        WHERE id = $1`,
      [targetUserId],
    );
    if (currentRows.length === 0) {
      throw new ProblemException(404, 'NOT_FOUND');
    }

    const current = currentRows[0];
    const passwordHash = await this.hasher.hash(dto.temporaryPassword);

    const applied = await applyTemporaryPassword({
      manager,
      targetUserId,
      passwordHash,
      updatedBy: user.userId,
      updatedByName: user.name,
      previousMustChangePassword: Boolean(current.mustChangePassword),
    });

    const updatedAccount = applied.updatedUser
      ? toUserAccount(applied.updatedUser)
      : {
          id: current.id,
          name: current.name,
          email: current.email,
          role: current.role,
          status: current.status,
          mustChangePassword: true,
          temporaryPasswordExpiresAt: applied.temporaryPasswordExpiresAt.toISOString(),
          createdAt: new Date(current.createdAt).toISOString(),
          updatedAt: new Date().toISOString(),
          updatedByName: user.name,
        };

    await this.audit.record({
      action: 'user.password_reset',
      entityType: 'user',
      entityId: targetUserId,
      before: { mustChangePassword: Boolean(current.mustChangePassword) },
      after: {
        mustChangePassword: true,
        temporaryPasswordExpiresAt: updatedAccount.temporaryPasswordExpiresAt,
        sessionsClosed: applied.sessionsClosed,
      },
    });

    return updatedAccount;
  }

  /**
   * Retrieves the audit history for a user, ordered from newest to oldest.
   */
  async getHistory(targetUserId: string): Promise<{ items: UserAuditEntry[] }> {
    assertValidUserId(targetUserId);
    const manager = getManager();

    const userRows = await manager.query<{ id: string }[]>(
      'SELECT id FROM users WHERE id = $1',
      [targetUserId],
    );
    if (userRows.length === 0) {
      throw new ProblemException(404, 'NOT_FOUND');
    }

    const rows = await manager.query<AuditLogRow[]>(
      `SELECT id, action, actor_name AS "actorName", actor_role AS "actorRole",
              occurred_at AS "occurredAt", before, after, ip, channel
         FROM audit_log
        WHERE entity_type = 'user' AND entity_id = $1
        ORDER BY occurred_at DESC`,
      [targetUserId],
    );

    const items: UserAuditEntry[] = rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorName: row.actorName,
      actorRole: row.actorRole,
      occurredAt: new Date(row.occurredAt).toISOString(),
      before: row.before,
      after: row.after,
      ip: row.ip ?? null,
      channel: row.channel ?? 'web',
    }));

    return { items };
  }
}
