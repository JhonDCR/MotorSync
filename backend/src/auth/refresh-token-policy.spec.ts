// T011 (specs/003-soporte-plataforma): pure policy of the refresh token, extracted from
// sessions.service.ts so the workshop (002) and the support panel share it (research R4; research
// R5 of the 002; US2-AC9). The clock is always injected: no real waits.
import { createHash } from 'node:crypto';
import {
  REFRESH_TOKEN_BYTES,
  REUSE_WINDOW_SECONDS,
  classifyRotation,
  hashRefreshToken,
  newRefreshToken,
} from './refresh-token-policy.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TOKEN = 'u3V5Jq0Zr8m3o6vXbq9sJ2l7cA1yWk4tHn0pQe5fG2E';
const NOW = new Date('2026-10-25T12:00:00.000Z');

function rotatedSecondsAgo(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

describe('newRefreshToken (T011, research R5 de la 002)', () => {
  it('[R5] es base64url de 32 bytes aleatorios', () => {
    expect(REFRESH_TOKEN_BYTES).toBe(32);
    for (let sample = 0; sample < 200; sample += 1) {
      const token = newRefreshToken();
      expect(token).toMatch(BASE64URL);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it('[R5] 200 llamadas dan 200 tokens distintos', () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => newRefreshToken()),
    );
    expect(tokens.size).toBe(200);
  });
});

describe('hashRefreshToken (T011, research R5 de la 002)', () => {
  it('[R5] es SHA-256 hex del token en UTF-8', () => {
    const expected = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
    expect(hashRefreshToken(TOKEN)).toBe(expected);
    expect(hashRefreshToken(TOKEN)).toMatch(SHA256_HEX);
  });

  it('[R5] es determinista y distinto para tokens distintos', () => {
    expect(hashRefreshToken(TOKEN)).toBe(hashRefreshToken(TOKEN));
    expect(hashRefreshToken(TOKEN)).not.toBe(
      hashRefreshToken(newRefreshToken()),
    );
  });
});

describe('classifyRotation (T011, research R5 de la 002, US2-AC9)', () => {
  it('[R5] sin rotated_at el token es fresh', () => {
    expect(classifyRotation(null, NOW)).toBe('fresh');
  });

  it('[R5] rotado hace 0 s o 9,999 s es recently_rotated', () => {
    expect(REUSE_WINDOW_SECONDS).toBe(10);
    expect(classifyRotation(rotatedSecondsAgo(0), NOW)).toBe(
      'recently_rotated',
    );
    expect(classifyRotation(new Date(NOW.getTime() - 9_999), NOW)).toBe(
      'recently_rotated',
    );
  });

  it('[R5] rotado hace exactamente 10 s u 11 s es reused', () => {
    expect(classifyRotation(rotatedSecondsAgo(10), NOW)).toBe('reused');
    expect(classifyRotation(rotatedSecondsAgo(11), NOW)).toBe('reused');
  });

  it('[R5] usa el reloj inyectado y nunca Date.now()', () => {
    const oldRotation = new Date('2001-01-01T00:00:00.000Z');
    const fiveSecondsLater = new Date(oldRotation.getTime() + 5_000);
    expect(classifyRotation(oldRotation, fiveSecondsLater)).toBe(
      'recently_rotated',
    );
  });
});
