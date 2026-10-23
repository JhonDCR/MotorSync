import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ProblemException } from '../common/problem-details.filter.js';
import { isAuthRole, type AuthRole, type AuthUser } from './auth-user.js';

/** Current state of the account behind a valid session, read from the database (research R6). */
export interface SessionState {
  role: AuthRole;
  name: string;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
}

interface ActiveSessionRow {
  role: unknown;
  name: unknown;
  must_change_password: unknown;
  temp_password_expires_at: unknown;
}

interface DiagnosticRow {
  revoked_at: Date | null;
  user_status: string;
  inactive: boolean;
}

// Research R6, literal: one statement by primary key, under RLS (app.tenant_id already pinned).
const TOUCH_SESSION_SQL = `
UPDATE user_sessions s SET last_activity_at = now()
  FROM users u
 WHERE s.id = $1 AND s.user_id = $2 AND u.id = s.user_id
   AND s.revoked_at IS NULL AND u.status = 'active'
   AND s.last_activity_at > now() - interval '30 minutes'
RETURNING u.role, u.name, u.must_change_password, u.temp_password_expires_at`;

// Read-only diagnostic, only when the UPDATE matched nothing. The clock is PostgreSQL's.
const DIAGNOSE_SESSION_SQL = `
SELECT s.revoked_at, u.status AS user_status,
       s.last_activity_at <= now() - interval '30 minutes' AS inactive
  FROM user_sessions s
  JOIN users u ON u.id = s.user_id
 WHERE s.id = $1 AND s.user_id = $2`;

/**
 * Validates the session of the token on every authenticated request (research R6): refreshes
 * last_activity_at and returns the current role, name and temporary-password state. Runs on the
 * manager of the request transaction, after set_config. Throws 401 SESSION_EXPIRED when the only
 * problem is inactivity, 401 SESSION_REVOKED otherwise (revoked, account inactive or not found).
 */
@Injectable()
export class SessionValidator {
  async validate(manager: EntityManager, user: AuthUser): Promise<SessionState> {
    const params = [user.sessionId, user.userId];
    // TypeORM over pg resolves an UPDATE ... RETURNING to [rows, affectedCount].
    const [rows] = (await manager.query(TOUCH_SESSION_SQL, params)) as [ActiveSessionRow[], number];
    const row = rows[0];
    if (row) return toSessionState(row);

    const diagnostic = (await manager.query(DIAGNOSE_SESSION_SQL, params)) as DiagnosticRow[];
    const session = diagnostic[0];
    const expired =
      session !== undefined &&
      session.revoked_at === null &&
      session.user_status === 'active' &&
      session.inactive === true;
    throw new ProblemException(401, expired ? 'SESSION_EXPIRED' : 'SESSION_REVOKED');
  }
}

function toSessionState(row: ActiveSessionRow): SessionState {
  const { role, name, must_change_password: mustChange, temp_password_expires_at: expiresAt } = row;
  if (!isAuthRole(role) || typeof name !== 'string' || typeof mustChange !== 'boolean') {
    throw new ProblemException(401, 'SESSION_REVOKED');
  }
  return {
    role,
    name,
    mustChangePassword: mustChange,
    temporaryPasswordExpiresAt: expiresAt instanceof Date ? expiresAt : null,
  };
}
