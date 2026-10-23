// Utilidades de prueba (PR3, US4): JWT de desarrollo sin firma válida. El frontend nunca verifica la firma
// (current-session.ts solo lee el payload para la UI); el backend sí la verifica.
import { AUTH_TOKEN_STORAGE_KEY } from '../app/core/auth/auth-token.interceptor';

export type FakeRole = 'asesor' | 'admin';

export const ASESOR_ID = '11111111-1111-4111-8111-111111111111';
export const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
export const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** base64url (RFC 4648 §5) sin relleno, con UTF-8 para nombres con tildes. */
export function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** header.payload.signature con la firma inventada: sirve para probar que no se verifica. */
export function fakeJwt(claims: Record<string, unknown>, signature = 'firma-no-verificada'): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `${header}.${payload}.${signature}`;
}

/** Claims del contrato: sub, tenant_id, role, name y exp. */
export function sessionClaims(role: FakeRole, name = role === 'admin' ? 'Admin Uno' : 'Asesor Uno'): Record<string, unknown> {
  return {
    sub: role === 'admin' ? ADMIN_ID : ASESOR_ID,
    tenant_id: TENANT_A,
    role,
    name,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

export function tokenFor(role: FakeRole, name?: string): string {
  return fakeJwt(sessionClaims(role, name));
}

/** Guarda en localStorage el token que lee current-session (como /dev-token). */
export function signInAs(role: FakeRole, name?: string): void {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, tokenFor(role, name));
}

export function signOut(): void {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}
