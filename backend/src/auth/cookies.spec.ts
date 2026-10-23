// T033 (specs/002-autenticacion): cookies.ts, own Cookie parser (no cookie-parser), options of the
// ms_refresh cookie, its removal and the CSRF header check (research R5, R11; contract
// components.headers.SetRefreshCookie / ClearRefreshCookie and parameters.RequestedWith).
// The Set-Cookie headers are checked as Express really writes them (a tiny express app served with
// supertest), not by inspecting how cookies.ts calls res.cookie().
import express, { type Response as ExpressResponse } from 'express';
import request from 'supertest';
import { ProblemException } from '../common/problem-details.filter.js';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  assertRequestedWith,
  clearRefreshCookie,
  parseCookies,
  refreshCookieOptions,
  setRefreshCookie,
} from './cookies.js';

const TOKEN = 'u3V5Jq0Zr8m3o6vXbq9sJ2l7cA1yWk4tHn0pQe5fG2E';

/** Set-Cookie of ms_refresh written by `write` on a real Express response. */
async function refreshSetCookie(write: (res: ExpressResponse) => void): Promise<string> {
  const app = express();
  app.post('/api/v1/auth/x', (_req, res) => {
    write(res);
    res.status(204).end();
  });
  const response = await request(app).post('/api/v1/auth/x');
  const header = response.headers['set-cookie'] as string | string[] | undefined;
  const cookies = header === undefined ? [] : Array.isArray(header) ? header : [header];
  const cookie = cookies.find((value) => value.startsWith(`${REFRESH_COOKIE_NAME}=`));
  expect(cookie, 'Set-Cookie ms_refresh').toBeDefined();
  return cookie as string;
}

function attributesOf(cookie: string): string[] {
  return cookie
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase());
}

function withCookieSecure<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env.AUTH_COOKIE_SECURE;
  if (value === undefined) delete process.env.AUTH_COOKIE_SECURE;
  else process.env.AUTH_COOKIE_SECURE = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.AUTH_COOKIE_SECURE;
      else process.env.AUTH_COOKIE_SECURE = previous;
    });
}

function problemOf(fn: () => unknown): ProblemException {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemException);
    return error as ProblemException;
  }
  throw new Error('expected the call to throw');
}

describe('parseCookies (T033, research R11)', () => {
  it('[R11] lee varias cookies del header Cookie, con espacios alrededor', () => {
    expect(parseCookies(`a=1; ms_refresh=${TOKEN};  theme=dark`)).toEqual({
      a: '1',
      ms_refresh: TOKEN,
      theme: 'dark',
    });
  });

  it('[R11] un valor que contiene "=" se conserva entero (solo corta en el primer "=")', () => {
    expect(parseCookies('ms_refresh=abc==; other=x=y=z')).toEqual({
      ms_refresh: 'abc==',
      other: 'x=y=z',
    });
  });

  it('[R11] decodifica el percent-encoding y quita las comillas dobles del valor', () => {
    expect(parseCookies('name=Ana%20P%C3%A9rez; quoted="valor"')).toEqual({
      name: 'Ana Pérez',
      quoted: 'valor',
    });
  });

  it.each([undefined, ''])('[R11] header ausente o vacío (%j) → objeto vacío', (header) => {
    expect(parseCookies(header)).toEqual({});
  });

  it.each([
    'sin-igual',
    ';;;',
    '=sin-nombre',
    'malo=%E0%A4%A; ms_refresh=ok',
    ' ; ms_refresh=ok ; basura',
  ])('[R11] un header mal formado (%j) no lanza', (header) => {
    expect(() => parseCookies(header)).not.toThrow();
  });

  it('[R11] con partes mal formadas sigue leyendo las cookies válidas', () => {
    const cookies = parseCookies(' ; basura ; =x; ms_refresh=ok; malo=%E0%A4%A');
    expect(cookies.ms_refresh).toBe('ok');
    // Percent-encoding inválido: el valor queda tal como llegó.
    expect(cookies.malo).toBe('%E0%A4%A');
    expect(Object.keys(cookies)).not.toContain('');
  });

  it('[R11] si una cookie se repite, gana la primera (como los navegadores la ordenan por Path)', () => {
    expect(parseCookies('ms_refresh=primera; ms_refresh=segunda').ms_refresh).toBe('primera');
  });
});

describe('opciones de ms_refresh (T033, research R5, R11, FR-012)', () => {
  it('[R11] HttpOnly, SameSite=Strict, Path=/api/v1/auth y sin Max-Age ni Expires', () => {
    const options = refreshCookieOptions();
    expect(REFRESH_COOKIE_NAME).toBe('ms_refresh');
    expect(REFRESH_COOKIE_PATH).toBe('/api/v1/auth');
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'strict', path: '/api/v1/auth' });
    expect(options.maxAge).toBeUndefined();
    expect(options.expires).toBeUndefined();
  });

  it('[R11] Secure sigue a AUTH_COOKIE_SECURE (true por defecto)', async () => {
    await withCookieSecure(undefined, () => expect(refreshCookieOptions().secure).toBe(true));
    await withCookieSecure('true', () => expect(refreshCookieOptions().secure).toBe(true));
    await withCookieSecure('false', () => expect(refreshCookieOptions().secure).toBe(false));
  });

  it('[R11][FR-012] setRefreshCookie escribe ms_refresh=<token>; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict, sin Max-Age', async () => {
    const cookie = await withCookieSecure('true', () =>
      refreshSetCookie((res) => setRefreshCookie(res, TOKEN)),
    );
    expect(cookie.split(';')[0]).toBe(`ms_refresh=${TOKEN}`);
    const attributes = attributesOf(cookie);
    expect(attributes).toEqual(
      expect.arrayContaining(['path=/api/v1/auth', 'httponly', 'secure', 'samesite=strict']),
    );
    expect(attributes.some((attribute) => attribute.startsWith('max-age'))).toBe(false);
    expect(attributes.some((attribute) => attribute.startsWith('expires'))).toBe(false);
  });

  it('[R11] con AUTH_COOKIE_SECURE=false la cookie sale sin Secure', async () => {
    const cookie = await withCookieSecure('false', () =>
      refreshSetCookie((res) => setRefreshCookie(res, TOKEN)),
    );
    expect(attributesOf(cookie)).not.toContain('secure');
    expect(attributesOf(cookie)).toContain('httponly');
  });
});

describe('clearRefreshCookie (T033, contrato ClearRefreshCookie)', () => {
  it('[US3-AC3] borra ms_refresh con valor vacío, Max-Age=0 y el mismo Path=/api/v1/auth', async () => {
    const cookie = await withCookieSecure('true', () =>
      refreshSetCookie((res) => clearRefreshCookie(res)),
    );
    expect(cookie.split(';')[0]).toBe('ms_refresh=');
    const attributes = attributesOf(cookie);
    expect(attributes).toEqual(
      expect.arrayContaining([
        'max-age=0',
        'path=/api/v1/auth',
        'httponly',
        'secure',
        'samesite=strict',
      ]),
    );
  });
});

describe('assertRequestedWith (T033, research R11, CSRF)', () => {
  it('[R11] con X-Requested-With: motorsync no lanza', () => {
    expect(() => assertRequestedWith({ 'x-requested-with': 'motorsync' })).not.toThrow();
  });

  it.each([
    ['sin el header', {}],
    ['vacío', { 'x-requested-with': '' }],
    ['con otro valor', { 'x-requested-with': 'XMLHttpRequest' }],
    ['repetido como arreglo', { 'x-requested-with': ['motorsync', 'otro'] }],
  ])('[R11] %s → 400 VALIDATION_ERROR', (_case, headers) => {
    const error = problemOf(() =>
      assertRequestedWith(headers as Record<string, string | string[] | undefined>),
    );
    expect(error.getStatus()).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
  });
});
