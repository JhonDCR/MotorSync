import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import {
  classifyRotation,
  hashRefreshToken,
  newRefreshToken,
} from '../auth/refresh-token-policy.js';
import type { TokenRotationState } from '../auth/refresh-token-policy.js';
import type { RevokeReason } from '../auth/sessions.service.js';

/** A new support session and the opaque refresh token that only travels in ms_support_refresh. */
export interface CreatedSupportSession {
  sessionId: string;
  refreshToken: string;
}

/** Refresh token of the panel resolved by its SHA-256: session and support account. */
export interface FoundSupportRefreshToken {
  tokenId: string;
  sessionId: string;
  accountId: string;
}

/** Session of a support refresh token, locked for the rotation, with its account. */
export interface LockedSupportSession {
  accountId: string;
  revoked: boolean;
  /** More than 30 minutes without activity, measured with the clock of PostgreSQL. */
  inactive: boolean;
  accountStatus: string;
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
  session_id: string;
  support_account_id: string;
}

interface LockedSessionRow {
  support_account_id: string;
  revoked: boolean;
  inactive: boolean;
  account_status: string;
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
 * Sessions and refresh tokens of the support panel (research R3, R4): the same rules as the 002
 * over support_sessions/support_refresh_tokens, without a workshop pinned. The pure policy
 * (generation, hashing and the 10 s reuse window) is shared through refresh-token-policy.ts.
 */
@Injectable()
export class SupportSessionsService {
  /** Opens a session for the account and issues its first refresh token. */
  async create(
    manager: EntityManager,
    accountId: string,
    ip: string | null,
  ): Promise<CreatedSupportSession> {
    const rows = (await manager.query(
      'INSERT INTO support_sessions (support_account_id, ip) VALUES ($1, $2) RETURNING id',
      [accountId, ip],
    )) as SessionIdRow[];
    const sessionId = rows[0].id;
    const refreshToken = newRefreshToken();
    await manager.query(
      'INSERT INTO support_refresh_tokens (session_id, token_hash) VALUES ($1, $2)',
      [sessionId, hashRefreshToken(refreshToken)],
    );
    return { sessionId, refreshToken };
  }

  /** Session and account of a refresh token, looked up by its SHA-256. */
  async findRefreshToken(
    manager: EntityManager,
    refreshToken: string,
  ): Promise<FoundSupportRefreshToken | undefined> {
    const rows = (await manager.query(
      `SELECT t.id AS token_id, t.session_id, s.support_account_id
         FROM support_refresh_tokens t
         JOIN support_sessions s ON s.id = t.session_id
        WHERE t.token_hash = $1`,
      [hashRefreshToken(refreshToken)],
    )) as FoundTokenRow[];
    const row = rows[0];
    if (!row) return undefined;
    return {
      tokenId: row.token_id,
      sessionId: row.session_id,
      accountId: row.support_account_id,
    };
  }

  /**
   * Locks the session (FOR UPDATE: concurrent refreshes of one session are serialized) and reads
   * its account. The panel has no workshop pinned, so the platform policy applies.
   */
  async lockSession(
    manager: EntityManager,
    sessionId: string,
  ): Promise<LockedSupportSession | undefined> {
    const rows = (await manager.query(
      `SELECT s.support_account_id, s.revoked_at IS NOT NULL AS revoked,
              s.last_activity_at <= now() - interval '30 minutes' AS inactive,
              a.name, a.email, a.status AS account_status, a.must_change_password,
              a.temp_password_expires_at
         FROM support_sessions s
         JOIN support_accounts a ON a.id = s.support_account_id
        WHERE s.id = $1
          FOR UPDATE OF s`,
      [sessionId],
    )) as LockedSessionRow[];
    const row = rows[0];
    if (!row) return undefined;
    return {
      accountId: row.support_account_id,
      revoked: row.revoked,
      inactive: row.inactive,
      accountStatus: row.account_status,
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
      `SELECT rotated_at, now() AS now FROM support_refresh_tokens WHERE id = $1`,
      [tokenId],
    )) as TokenStateRow[];
    const row = rows[0];
    if (!row) return 'fresh';
    return classifyRotation(row.rotated_at, row.now);
  }

  /**
   * Rotation: marks the presented token rotated, issues the next one of the same session, prunes
   * the tokens of the session rotated more than 1 day ago and records the activity. Returns the
   * new refresh token.
   */
  async rotate(
    manager: EntityManager,
    tokenId: string,
    sessionId: string,
  ): Promise<string> {
    await manager.query(
      'UPDATE support_refresh_tokens SET rotated_at = now() WHERE id = $1',
      [tokenId],
    );
    const refreshToken = newRefreshToken();
    await manager.query(
      'INSERT INTO support_refresh_tokens (session_id, token_hash) VALUES ($1, $2)',
      [sessionId, hashRefreshToken(refreshToken)],
    );
    await manager.query(
      `DELETE FROM support_refresh_tokens
        WHERE session_id = $1 AND rotated_at < now() - interval '1 day'`,
      [sessionId],
    );
    await manager.query(
      'UPDATE support_sessions SET last_activity_at = now() WHERE id = $1',
      [sessionId],
    );
    return refreshToken;
  }

  /** Revokes one session; a session already revoked keeps its revoked_at and reason. */
  async revoke(
    manager: EntityManager,
    sessionId: string,
    reason: RevokeReason,
  ): Promise<void> {
    await manager.query(
      `UPDATE support_sessions SET revoked_at = now(), revoke_reason = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
  }

  /** Revokes every open session of the account except `keepSessionId` (FR-027, US5-AC3). */
  async revokeOthers(
    manager: EntityManager,
    accountId: string,
    keepSessionId: string,
    reason: RevokeReason,
  ): Promise<void> {
    await manager.query(
      `UPDATE support_sessions SET revoked_at = now(), revoke_reason = $3
        WHERE support_account_id = $1 AND id <> $2 AND revoked_at IS NULL`,
      [accountId, keepSessionId, reason],
    );
  }
}
