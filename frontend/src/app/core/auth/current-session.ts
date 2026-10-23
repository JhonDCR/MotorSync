import type { Role } from '../api/api.models';
import { readAuthToken } from './auth-token.interceptor';

/**
 * Session data read from the JWT payload for the UI only (FR-019). The signature is NOT verified here:
 * the backend verifies it and its role is the one that counts.
 */
export interface CurrentSession {
  role: Role;
  name: string;
}

const ROLES: readonly Role[] = ['asesor', 'admin'];
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

function decodeBase64Url(segment: string): string | null {
  if (!BASE64URL.test(segment) || segment.length % 4 === 1) {
    return null;
  }
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Decodes role and name from a JWT ("header.payload.signature"). Never throws; invalid → null. */
export function decodeSessionToken(token: string | null | undefined): CurrentSession | null {
  if (typeof token !== 'string' || token === '') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const json = decodeBase64Url(parts[1]);
    if (json === null) {
      return null;
    }
    const payload: unknown = JSON.parse(json);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return null;
    }
    const claims = payload as Record<string, unknown>;
    if (!isRole(claims['role'])) {
      return null;
    }
    const name = typeof claims['name'] === 'string' ? claims['name'] : '';
    return { role: claims['role'], name };
  } catch {
    return null;
  }
}

/** Reads the stored token on every call (no cache). */
export function readCurrentSession(): CurrentSession | null {
  return decodeSessionToken(readAuthToken());
}
