// T076: sesión actual para la UI (FR-019: el rol decide si el motivo es obligatorio u opcional en pantalla).
// El rol que vale es siempre el del token verificado en el backend; aquí solo se lee el payload, SIN verificar la
// firma, para mostrar u ocultar el campo "Motivo" y su obligatoriedad.
//
// Contrato para el implementer (T077), archivo core/auth/current-session.ts:
//   export interface CurrentSession { role: Role; name: string }          // Role de core/api/api.models.ts
//   export function decodeSessionToken(token: string | null | undefined): CurrentSession | null
//     - token JWT "header.payload.signature" (exactamente 3 partes, la firma no se comprueba).
//     - payload en base64url (- y _, sin relleno) con JSON UTF-8 (nombres con tildes).
//     - role debe ser 'asesor' o 'admin'; otro valor o ausente → null.
//     - name: el claim `name` si es string; si falta, ''.
//     - token null, vacío, con otro número de partes, base64 inválido, JSON inválido o payload que no es un objeto
//       → null. Nunca lanza.
//     (Lo reutiliza también el mock de T083 para leer el rol del header Authorization.)
//   export function readCurrentSession(): CurrentSession | null
//     - lee localStorage 'motorsync.token' (AUTH_TOKEN_STORAGE_KEY, con readAuthToken) EN CADA llamada, sin cachear.
//   Las páginas (T079, T081) deben consultar la sesión al crearse o al guardar, no en tiempo de carga del módulo:
//   sus pruebas cambian el token de localStorage entre casos.
import { AUTH_TOKEN_STORAGE_KEY } from './auth-token.interceptor';
import { decodeSessionToken, readCurrentSession, type CurrentSession } from './current-session';
import { base64UrlEncode, fakeJwt, sessionClaims, signInAs, tokenFor } from '../../../testing/fake-jwt';

describe('current-session (T076)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  describe('decodeSessionToken', () => {
    it('[FR-019] lee role y name del payload de un token de asesor', () => {
      const session: CurrentSession | null = decodeSessionToken(tokenFor('asesor', 'Ana Asesora'));

      expect(session).toEqual({ role: 'asesor', name: 'Ana Asesora' });
    });

    it('[FR-019] lee role y name del payload de un token de administrador', () => {
      expect(decodeSessionToken(tokenFor('admin', 'Carlos Admin'))).toEqual({ role: 'admin', name: 'Carlos Admin' });
    });

    it('[FR-019] decodifica base64url con UTF-8 (nombres con tildes y ñ, caracteres - y _)', () => {
      // "José Núñez ¿?>>>" produce + y / en base64 clásico, que en base64url son - y _.
      const name = 'José Núñez ¿?>>>';
      const token = fakeJwt(sessionClaims('asesor', name));
      expect(token.split('.')[1]).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.split('.')[1]).toMatch(/[-_]/);

      expect(decodeSessionToken(token)).toEqual({ role: 'asesor', name });
    });

    it('[FR-019] no verifica la firma: solo sirve para la UI', () => {
      const token = fakeJwt(sessionClaims('admin'), 'cualquier-cosa');

      expect(decodeSessionToken(token)?.role).toBe('admin');
    });

    it('[FR-019] sin claim name devuelve name vacío', () => {
      const claims = sessionClaims('asesor');
      delete claims['name'];

      expect(decodeSessionToken(fakeJwt(claims))).toEqual({ role: 'asesor', name: '' });
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['vacío', ''],
      ['sin puntos', 'abc'],
      ['dos partes', 'abc.def'],
      ['cuatro partes', 'a.b.c.d'],
      ['payload no base64', 'aaa.@@@###.ccc'],
      ['payload no JSON', `aaa.${base64UrlEncode('no es json')}.ccc`],
      ['payload JSON que no es objeto', `aaa.${base64UrlEncode('"asesor"')}.ccc`],
      ['payload null', `aaa.${base64UrlEncode('null')}.ccc`],
    ])('[FR-019] un token mal formado (%s) → sin sesión, sin lanzar', (_label, token) => {
      expect(() => decodeSessionToken(token)).not.toThrow();
      expect(decodeSessionToken(token)).toBeNull();
    });

    it.each([['supervisor'], [''], [1], [null]])('[FR-019] un role desconocido (%s) → sin sesión', (role) => {
      expect(decodeSessionToken(fakeJwt({ ...sessionClaims('asesor'), role }))).toBeNull();
    });

    it('[FR-019] sin claim role → sin sesión', () => {
      const claims = sessionClaims('asesor');
      delete claims['role'];

      expect(decodeSessionToken(fakeJwt(claims))).toBeNull();
    });
  });

  describe('readCurrentSession', () => {
    it('[FR-019] sin token guardado → sin sesión', () => {
      expect(readCurrentSession()).toBeNull();
    });

    it('[FR-019] lee el token guardado en localStorage motorsync.token', () => {
      signInAs('asesor', 'Ana Asesora');

      expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).not.toBeNull();
      expect(readCurrentSession()).toEqual({ role: 'asesor', name: 'Ana Asesora' });
    });

    it('[FR-019] acepta el token con espacios al inicio o al final (como el interceptor)', () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, `  ${tokenFor('admin', 'Admin Uno')}\n`);

      expect(readCurrentSession()).toEqual({ role: 'admin', name: 'Admin Uno' });
    });

    it('[FR-019] un token guardado mal formado → sin sesión', () => {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, 'esto-no-es-un-jwt');

      expect(readCurrentSession()).toBeNull();
    });

    it('[FR-019] no cachea: refleja el token vigente en cada llamada', () => {
      signInAs('asesor');
      expect(readCurrentSession()?.role).toBe('asesor');

      signInAs('admin');
      expect(readCurrentSession()?.role).toBe('admin');

      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
      expect(readCurrentSession()).toBeNull();
    });
  });
});
