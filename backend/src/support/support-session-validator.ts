import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ProblemException } from '../common/problem-details.filter.js';
import type { SupportAgent } from './support-agent.js';

/** Current state of the support account behind a valid session (research R4). */
export interface SupportSessionState {
  name: string;
  email: string;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
}

interface ActiveSessionRow {
  name: unknown;
  email: unknown;
  must_change_password: unknown;
  temp_password_expires_at: unknown;
  /** temp_password_expires_at <= now() with the clock of PostgreSQL (null without a temporary). */
  temp_password_expired: unknown;
}

interface DiagnosticRow {
  revoked_at: Date | null;
  account_status: string;
  inactive: boolean;
}

// Research R4: the sentence of the 002 R6 over support_sessions/support_accounts, without a
// workshop pinned. Besides the account columns it returns whether the temporary password
// expired, computed by PostgreSQL, so every support route uses the same clock.
const TOUCH_SESSION_SQL = `
UPDATE support_sessions s SET last_activity_at = now()
  FROM support_accounts a
 WHERE s.id = $1 AND s.support_account_id = $2 AND a.id = s.support_account_id
   AND s.revoked_at IS NULL AND a.status = 'active'
   AND s.last_activity_at > now() - interval '30 minutes'
RETURNING a.name, a.email, a.must_change_password, a.temp_password_expires_at,
          a.temp_password_expires_at <= now() AS temp_password_expired`;

// Read-only diagnostic, only when the UPDATE matched nothing. The clock is PostgreSQL's.
const DIAGNOSE_SESSION_SQL = `
SELECT s.revoked_at, a.status AS account_status,
       s.last_activity_at <= now() - interval '30 minutes' AS inactive
  FROM support_sessions s
  JOIN support_accounts a ON a.id = s.support_account_id
 WHERE s.id = $1 AND s.support_account_id = $2`;

/**
 * Validates the session of the support token on every request of the panel (research R4):
 * refreshes last_activity_at and returns the current name, email and temporary-password state.
 * Runs on the manager of the request transaction, without a workshop pinned. Throws 401
 * SESSION_EXPIRED when the only problem is inactivity, 401 SESSION_REVOKED otherwise (revoked,
 * account inactive or not found), and 401 TEMPORARY_PASSWORD_EXPIRED if the temporary password
 * of the account expired.
 */
@Injectable()
export class SupportSessionValidator {
  async validate(
    manager: EntityManager,
    agent: SupportAgent,
  ): Promise<SupportSessionState> {
    const params = [agent.sessionId, agent.id];
    // TypeORM over pg resolves an UPDATE ... RETURNING to [rows, affectedCount].
    const [rows] = (await manager.query(TOUCH_SESSION_SQL, params)) as [
      ActiveSessionRow[],
      number,
    ];
    const row = rows[0];
    if (row) {
      const state = toSupportSessionState(row);
      assertTemporaryPasswordValid(state, row.temp_password_expired === true);
      return state;
    }

    const diagnostic = (await manager.query(
      DIAGNOSE_SESSION_SQL,
      params,
    )) as DiagnosticRow[];
    const session = diagnostic[0];
    const expired =
      session !== undefined &&
      session.revoked_at === null &&
      session.account_status === 'active' &&
      session.inactive === true;
    throw new ProblemException(
      401,
      expired ? 'SESSION_EXPIRED' : 'SESSION_REVOKED',
    );
  }
}

/**
 * A temporary password that expired during the session (FR-009): 401
 * TEMPORARY_PASSWORD_EXPIRED. SupportTransactionInterceptor revokes the session
 * ('temp_password_expired') in its own transaction, after releasing the connection.
 */
function assertTemporaryPasswordValid(
  state: SupportSessionState,
  expired: boolean,
): void {
  if (state.mustChangePassword && expired) {
    throw new ProblemException(401, 'TEMPORARY_PASSWORD_EXPIRED');
  }
}

/** Fails closed (SESSION_REVOKED) when a column does not have the expected type. */
function toSupportSessionState(row: ActiveSessionRow): SupportSessionState {
  const {
    name,
    email,
    must_change_password: mustChange,
    temp_password_expires_at: expiresAt,
  } = row;
  if (
    typeof name !== 'string' ||
    typeof email !== 'string' ||
    typeof mustChange !== 'boolean'
  ) {
    throw new ProblemException(401, 'SESSION_REVOKED');
  }
  if (expiresAt !== null && !(expiresAt instanceof Date)) {
    throw new ProblemException(401, 'SESSION_REVOKED');
  }
  return {
    name,
    email,
    mustChangePassword: mustChange,
    temporaryPasswordExpiresAt: expiresAt,
  };
}
