import { createHash, randomBytes } from 'node:crypto';

/** Bytes of entropy of an opaque refresh token (research R5 of the 002). */
export const REFRESH_TOKEN_BYTES = 32;

/** Window in which reusing a rotated token is a benign race between tabs (research R5 of the 002). */
export const REUSE_WINDOW_SECONDS = 10;

/**
 * State of the presented token, re-read once the session is locked (concurrent refreshes): `fresh`
 * when it was never rotated, `recently_rotated` within the reuse window and `reused` after it.
 */
export type TokenRotationState = 'fresh' | 'recently_rotated' | 'reused';

/** A new opaque refresh token: base64url of 32 random bytes (research R5 of the 002). */
export function newRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

/** SHA-256 hex of a refresh token: what refresh_tokens.token_hash stores (research R5 of the 002). */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Classifies a rotation with the clock injected (`now`, PostgreSQL's in the services): no rotated_at
 * means the token is still current, less than REUSE_WINDOW_SECONDS is a benign concurrent refresh and
 * the rest is a reuse.
 */
export function classifyRotation(
  rotatedAt: Date | null,
  now: Date,
): TokenRotationState {
  if (rotatedAt === null) return 'fresh';
  const elapsedMs = now.getTime() - rotatedAt.getTime();
  return elapsedMs < REUSE_WINDOW_SECONDS * 1000
    ? 'recently_rotated'
    : 'reused';
}
