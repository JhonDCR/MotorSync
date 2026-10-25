import type { EntityManager } from 'typeorm';
import type { AuthRole } from '../auth/auth-user.js';
import type { UserStatus } from './user.entity.js';

export interface UserAccountRow {
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

export interface ApplyTemporaryPasswordParams {
  manager: EntityManager;
  targetUserId: string;
  passwordHash: string;
  updatedBy: string;
  updatedByName: string;
  previousMustChangePassword: boolean;
}

export interface AppliedTemporaryPassword {
  sessionsClosed: number;
  previousMustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date;
  updatedUser?: UserAccountRow;
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

/**
 * Shared core for resetting a user's password with a temporary password (US3-AC1, US3-AC13, research R9).
 *
 * Executes in strict order:
 * 1. Revokes all active sessions with revoke_reason = 'password_reset'.
 * 2. Updates users: sets password_hash, must_change_password = true, temp_password_expires_at = now() + 72 hours,
 *    updated_at = now(), updated_by, and updated_by_name. Never touches role or status.
 * 3. Clears login failure lockouts via auth_clear_login_failures.
 */
export async function applyTemporaryPassword(
  params: ApplyTemporaryPasswordParams,
): Promise<AppliedTemporaryPassword> {
  const {
    manager,
    targetUserId,
    passwordHash,
    updatedBy,
    updatedByName,
    previousMustChangePassword,
  } = params;

  // 1. Revoke active sessions (session -> users order of POST /auth/password, research R8).
  const rawRevoked = await manager.query(
    `UPDATE user_sessions
        SET revoked_at = now(), revoke_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [targetUserId, 'password_reset'],
  );
  const sessionsClosed = extractRowCount(rawRevoked);

  // 2. UPDATE users setting hash, must_change_password, expiry at 72h, updated_by, updated_by_name.
  const rawUpdated = await manager.query(
    `UPDATE users
        SET password_hash = $2,
            must_change_password = true,
            temp_password_expires_at = now() + interval '72 hours',
            updated_at = now(),
            updated_by = $3,
            updated_by_name = $4
      WHERE id = $1
      RETURNING id, name, email, role, status,
                must_change_password AS "mustChangePassword",
                temp_password_expires_at AS "temporaryPasswordExpiresAt",
                created_at AS "createdAt",
                updated_at AS "updatedAt",
                updated_by_name AS "updatedByName"`,
    [targetUserId, passwordHash, updatedBy, updatedByName],
  );
  const updatedRows = extractRows<UserAccountRow>(rawUpdated);
  const updatedUser = updatedRows[0];

  // 3. Clear failed login attempts / lockouts.
  await manager.query('SELECT auth_clear_login_failures($1)', [targetUserId]);

  const rawExpires = updatedUser?.temporaryPasswordExpiresAt;
  const temporaryPasswordExpiresAt = rawExpires
    ? new Date(rawExpires)
    : new Date(Date.now() + 72 * 3600 * 1000);

  return {
    sessionsClosed,
    previousMustChangePassword,
    temporaryPasswordExpiresAt,
    updatedUser,
  };
}
