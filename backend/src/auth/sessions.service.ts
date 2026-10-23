import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { getTenantContext } from '../database/tenant-context.js';

const REFRESH_TOKEN_BYTES = 32;

/** A new session and the opaque refresh token that only travels in the ms_refresh cookie. */
export interface CreatedSession {
  sessionId: string;
  refreshToken: string;
}

interface SessionIdRow {
  id: string;
}

/** SHA-256 hex of a refresh token: what refresh_tokens.token_hash stores (research R5). */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Sessions and refresh tokens (research R5). Runs under the tenant pinned by withAuthTransaction
 * (tenant_id comes from the DEFAULT app_current_tenant(), RLS applies as for any business row).
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
    const refreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    await manager.query('INSERT INTO refresh_tokens (session_id, token_hash) VALUES ($1, $2)', [
      sessionId,
      hashRefreshToken(refreshToken),
    ]);
    return { sessionId, refreshToken };
  }
}
