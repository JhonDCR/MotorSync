// T011 (specs/003-soporte-plataforma): ms_support_refresh and the parametrized cookie of the panel
// (research R4; US2-AC5, US2-AC9). The Set-Cookie headers are checked as Express really writes them
// (a tiny express app served with supertest), not by inspecting how cookies.ts calls res.cookie().
import express, { type Response as ExpressResponse } from 'express';
import request from 'supertest';
import {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  SUPPORT_REFRESH_COOKIE,
  WORKSHOP_REFRESH_COOKIE,
  clearRefreshCookie,
  readRefreshCookie,
  refreshCookieOptions,
  setRefreshCookie,
} from './cookies.js';

const TOKEN = 'u3V5Jq0Zr8m3o6vXbq9sJ2l7cA1yWk4tHn0pQe5fG2E';
const OTHER_TOKEN = 'Zx8Yw7Vu6Ts5Rq4Po3Nm2Lk1Ji0Hg9Fe8Dc7Ba6Zx5Y';

/** Set-Cookie written by `write` on a real Express response, for the cookie named `name`. */
async function setCookieOf(
  name: string,
  write: (res: ExpressResponse) => void,
): Promise<string> {
  const app = express();
  app.post('/api/v1/support/auth/x', (_req, res) => {
    write(res);
    res.status(204).end();
  });
  const response = await request(app).post('/api/v1/support/auth/x');
  const header = response.headers['set-cookie'] as
    string | string[] | undefined;
  const cookies =
    header === undefined ? [] : Array.isArray(header) ? header : [header];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  expect(cookie, `Set-Cookie ${name}`).toBeDefined();
  return cookie as string;
}

function attributesOf(cookie: string): string[] {
  return cookie
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase());
}

function withCookieSecure<T>(
  value: string | undefined,
  fn: () => T | Promise<T>,
): Promise<T> {
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

describe('cookies de la zona de soporte (T011, research R4)', () => {
  it('[US2-AC5] SUPPORT_REFRESH_COOKIE es ms_support_refresh en /api/v1/support/auth', () => {
    expect(SUPPORT_REFRESH_COOKIE).toEqual({
      name: 'ms_support_refresh',
      path: '/api/v1/support/auth',
    });
    expect(WORKSHOP_REFRESH_COOKIE).toEqual({
      name: REFRESH_COOKIE_NAME,
      path: REFRESH_COOKIE_PATH,
    });
    expect(REFRESH_COOKIE_NAME).toBe('ms_refresh');
    expect(REFRESH_COOKIE_PATH).toBe('/api/v1/auth');
  });

  it('[US2-AC9][R11] setRefreshCookie escribe ms_support_refresh; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/support/auth, sin Max-Age ni Expires', async () => {
    const cookie = await withCookieSecure(undefined, () =>
      setCookieOf(SUPPORT_REFRESH_COOKIE.name, (res) =>
        setRefreshCookie(res, TOKEN, SUPPORT_REFRESH_COOKIE),
      ),
    );
    expect(cookie.split(';')[0]).toBe(`ms_support_refresh=${TOKEN}`);
    const attributes = attributesOf(cookie);
    expect(attributes).toEqual(
      expect.arrayContaining([
        'path=/api/v1/support/auth',
        'httponly',
        'secure',
        'samesite=strict',
      ]),
    );
    expect(
      attributes.some((attribute) => attribute.startsWith('max-age')),
    ).toBe(false);
    expect(
      attributes.some((attribute) => attribute.startsWith('expires')),
    ).toBe(false);
  });

  it('[US2-AC9] clearRefreshCookie borra ms_support_refresh con valor vacío, Max-Age=0 y el mismo Path', async () => {
    const cookie = await withCookieSecure('true', () =>
      setCookieOf(SUPPORT_REFRESH_COOKIE.name, (res) =>
        clearRefreshCookie(res, SUPPORT_REFRESH_COOKIE),
      ),
    );
    expect(cookie.split(';')[0]).toBe('ms_support_refresh=');
    const attributes = attributesOf(cookie);
    expect(attributes).toEqual(
      expect.arrayContaining([
        'max-age=0',
        'path=/api/v1/support/auth',
        'httponly',
        'secure',
        'samesite=strict',
      ]),
    );
  });

  it('[R11] refreshCookieOptions(SUPPORT_REFRESH_COOKIE) sigue a AUTH_COOKIE_SECURE (false y true)', async () => {
    await withCookieSecure('false', () => {
      const options = refreshCookieOptions(SUPPORT_REFRESH_COOKIE);
      expect(options).toMatchObject({
        httpOnly: true,
        sameSite: 'strict',
        path: '/api/v1/support/auth',
        secure: false,
      });
      expect(options.maxAge).toBeUndefined();
      expect(options.expires).toBeUndefined();
    });
    await withCookieSecure('true', () =>
      expect(refreshCookieOptions(SUPPORT_REFRESH_COOKIE).secure).toBe(true),
    );
  });
});

describe('regresión de ms_refresh de la 002 (T011)', () => {
  it('[R11] setRefreshCookie sin tercer argumento sigue escribiendo ms_refresh con Path=/api/v1/auth', async () => {
    const cookie = await withCookieSecure('true', () =>
      setCookieOf(REFRESH_COOKIE_NAME, (res) => setRefreshCookie(res, TOKEN)),
    );
    expect(cookie.split(';')[0]).toBe(`ms_refresh=${TOKEN}`);
    expect(attributesOf(cookie)).toContain('path=/api/v1/auth');
  });

  it('[US3-AC3] clearRefreshCookie sin tercer argumento borra ms_refresh con Max-Age=0', async () => {
    const cookie = await withCookieSecure('true', () =>
      setCookieOf(REFRESH_COOKIE_NAME, (res) => clearRefreshCookie(res)),
    );
    expect(cookie.split(';')[0]).toBe('ms_refresh=');
    const attributes = attributesOf(cookie);
    expect(attributes).toEqual(
      expect.arrayContaining(['max-age=0', 'path=/api/v1/auth']),
    );
  });
});

describe('readRefreshCookie (T011, research R11)', () => {
  it('[US2-AC5] lee ms_support_refresh y no lo confunde con ms_refresh', () => {
    const header = `ms_refresh=${OTHER_TOKEN}; ms_support_refresh=${TOKEN}`;
    expect(readRefreshCookie(header, SUPPORT_REFRESH_COOKIE)).toBe(TOKEN);
    expect(readRefreshCookie(header)).toBe(OTHER_TOKEN);
  });

  it('[US2-AC6] con solo la cookie de la otra zona no hay valor (en ambos sentidos)', () => {
    expect(
      readRefreshCookie(`ms_refresh=${OTHER_TOKEN}`, SUPPORT_REFRESH_COOKIE),
    ).toBeUndefined();
    expect(readRefreshCookie(`ms_support_refresh=${TOKEN}`)).toBeUndefined();
  });

  it('[US2-AC9] la cookie de soporte ausente o vacía es undefined', () => {
    expect(
      readRefreshCookie(undefined, SUPPORT_REFRESH_COOKIE),
    ).toBeUndefined();
    expect(
      readRefreshCookie('ms_support_refresh=', SUPPORT_REFRESH_COOKIE),
    ).toBeUndefined();
  });
});
