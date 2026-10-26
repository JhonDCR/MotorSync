import { Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { getTenantContext } from '../database/tenant-context.js';
import { withAuthTransaction } from './auth-transaction.js';
import type { AuthUser } from './auth-user.js';
import {
  classifyRotation,
  hashRefreshToken,
  newRefreshToken,
} from './refresh-token-policy.js';
import type { TokenRotationState } from './refresh-token-policy.js';

export { hashRefreshToken } from './refresh-token-policy.js';
export type { TokenRotationState } from './refresh-token-policy.js';

/** user_sessions.revoke_reason values (data-model). */
export type RevokeReason =
  | 'logout'
  | 'deactivated'
  | 'password_changed'
  | 'password_reset'
  | 'refresh_reuse'
  | 'temp_password_expired';

/** A new session and the opaque refresh token that only travels in the ms_refresh cookie. */
export interface CreatedSession {
  sessionId: string;
  refreshToken: string;
}

/** Refresh token resolved by auth_find_refresh_token: identifies the tenant and the session. */
export interface FoundRefreshToken {
  tokenId: string;
  tenantId: string;
  sessionId: string;
}

/** Session of a refresh token, locked for the rotation, with its account (read under RLS). */
export interface LockedSession {
  userId: string;
  revoked: boolean;
  /** More than 30 minutes without activity, measured with the clock of PostgreSQL. */
  inactive: boolean;
  userStatus: string;
  role: string;
  name: string;
  email: string;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
}

interface SessionIdRow {
  id: string;
}

interface FoundTokenRow {
  token_id: string;
  tenant_id: string;
  session_id: string;
}

interface LockedSessionRow {
  user_id: string;
  revoked: boolean;
  inactive: boolean;
  user_status: string;
  role: string;
  name: string;
  email: string;
  must_change_password: boolean;
  temp_password_expires_at: Date | null;
}

interface TokenStateRow {
  rotated_at: Date | null;
  now: Date;
}

/**
 * Sessions and refresh tokens (research R5). Runs under a pinned tenant (tenant_id comes from the
 * DEFAULT app_current_tenant(), RLS applies as for any business row). Only
 * auth_find_refresh_token looks a token up before the tenant is known.
 */
@Injectable()
export class SessionsService {
  /** Opens a session for the user of the context and issues its first refresh token. */
  async create(): Promise<CreatedSession> {
    const { manager, user, ip } = getTenantContext();
    const rows = (await manager.query(
      'INSERT INTO user_sessions (user_id, ip) VALUES ($1, $2) RETURNING id',
      [user.userId, ip],
    )) as SessionIdRow[];
    const sessionId = rows[0].id;
    const refreshToken = newRefreshToken();
    await manager.query(
      'INSERT INTO refresh_tokens (session_id, token_hash) VALUES ($1, $2)',
      [sessionId, hashRefreshToken(refreshToken)],
    );
    return { sessionId, refreshToken };
  }

  /** Tenant and session of a refresh token (SECURITY DEFINER, before any tenant is pinned). */
  async findRefreshToken(
    manager: EntityManager,
    refreshToken: string,
  ): Promise<FoundRefreshToken | undefined> {
    const rows = (await manager.query(
      'SELECT token_id, tenant_id, session_id FROM auth_find_refresh_token($1)',
      [hashRefreshToken(refreshToken)],
    )) as FoundTokenRow[];
    const row = rows[0];
    if (!row) return undefined;
    return {
      tokenId: row.token_id,
      tenantId: row.tenant_id,
      sessionId: row.session_id,
    };
  }

  /**
   * Locks the session (FOR UPDATE: concurrent refreshes of one session are serialized) and reads
   * its account. Under RLS: a session of another tenant is never found.
   */
  async lockSession(
    manager: EntityManager,
    sessionId: string,
  ): Promise<LockedSession | undefined> {
    const rows = (await manager.query(
      `SELECT s.user_id, s.revoked_at IS NOT NULL AS revoked,
              s.last_activity_at <= now() - interval '30 minutes' AS inactive,
              u.status AS user_status, u.role, u.name, u.email, u.must_change_password,
              u.temp_password_expires_at
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1
          FOR UPDATE OF s`,
      [sessionId],
    )) as LockedSessionRow[];
    const row = rows[0];
    if (!row) return undefined;
    return {
      userId: row.user_id,
      revoked: row.revoked,
      inactive: row.inactive,
      userStatus: row.user_status,
      role: row.role,
      name: row.name,
      email: row.email,
      mustChangePassword: row.must_change_password,
      temporaryPasswordExpiresAt: row.temp_password_expires_at,
    };
  }

  /** Whether the token is fresh, was rotated within 10 s, or was rotated before. */
  async tokenState(
    manager: EntityManager,
    tokenId: string,
  ): Promise<TokenRotationState> {
    const rows = (await manager.query(
      `SELECT rotated_at, now() AS now FROM refresh_tokens WHERE id = $1`,
      [tokenId],
    )) as TokenStateRow[];
    const row = rows[0];
    if (!row) return 'fresh';
    return classifyRotation(row.rotated_at, row.now);
  }

  /**
   * Rotation (research R5): marks the presented token rotated, issues the next one of the same
   * session, prunes the tokens of the session rotated more than 1 day ago and records the
   * activity (FR-012). Returns the new refresh token.
   */
  async rotate(
    manager: EntityManager,
    tokenId: string,
    sessionId: string,
  ): Promise<string> {
    await manager.query(
      'UPDATE refresh_tokens SET rotated_at = now() WHERE id = $1',
      [tokenId],
    );
    const refreshToken = newRefreshToken();
    await manager.query(
      'INSERT INTO refresh_tokens (session_id, token_hash) VALUES ($1, $2)',
      [sessionId, hashRefreshToken(refreshToken)],
    );
    await manager.query(
      `DELETE FROM refresh_tokens
        WHERE session_id = $1 AND rotated_at < now() - interval '1 day'`,
      [sessionId],
    );
    await manager.query(
      'UPDATE user_sessions SET last_activity_at = now() WHERE id = $1',
      [sessionId],
    );
    return refreshToken;
  }

  /** Revokes one session; a session already revoked keeps its revoked_at and reason (US3-AC6). */
  async revoke(
    manager: EntityManager,
    sessionId: string,
    reason: RevokeReason,
  ): Promise<void> {
    await manager.query(
      `UPDATE user_sessions SET revoked_at = now(), revoke_reason = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
  }

  /** Revokes every open session of the account except `keepSessionId` (FR-027, US5-AC3). */
  async revokeOthers(
    manager: EntityManager,
    userId: string,
    keepSessionId: string,
    reason: RevokeReason,
  ): Promise<void> {
    await manager.query(
      `UPDATE user_sessions SET revoked_at = now(), revoke_reason = $3
        WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [userId, keepSessionId, reason],
    );
  }
}

/**
 * Revokes the session of `user` in a transaction of its own, so the revocation is committed even
 * though the request that detected the reason rolls back (research R7: temporary password expired
 * during the session). The tenant is the one of the verified token.
 */
export async function revokeSessionApart(
  dataSource: DataSource,
  user: AuthUser,
  reason: RevokeReason,
): Promise<void> {
  if (user.sessionId === undefined) return;
  const sessionId = user.sessionId;
  await withAuthTransaction(dataSource, null, async (tx) => {
    await tx.pinTenant(user.tenantId);
    await tx.manager.query(
      `UPDATE user_sessions SET revoked_at = now(), revoke_reason = $3
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sessionId, user.userId, reason],
    );
  });
}
