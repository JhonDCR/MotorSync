// T006 (specs/002-autenticacion): API configuration, auth flags and the FR-T01 rule (research R9, R11).
// loadEnv and readAuthFlags receive an explicit source, so process.env (and the test-only default
// AUTH_ALLOW_SESSIONLESS_TOKENS=true of vitest.config.ts) never leaks into these cases.
import { loadEnv, readAuthFlags } from './env.js';

const VALID_SECRET = 'a-jwt-secret-that-has-at-least-32-chars';

function baseEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://motorsync_app:pw@localhost:5432/motorsync',
    DATABASE_MIGRATOR_URL: 'postgres://motorsync_migrator:pw@localhost:5432/motorsync',
    JWT_SECRET: VALID_SECRET,
    ...extra,
  };
}

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to throw');
}

describe('loadEnv: banderas de autenticación (T006, research R9)', () => {
  it('[FR-T01] lanza un error que nombra AUTH_ALLOW_SESSIONLESS_TOKENS si es true con NODE_ENV=production', () => {
    const error = errorOf(() =>
      loadEnv(baseEnv({ AUTH_ALLOW_SESSIONLESS_TOKENS: 'true', NODE_ENV: 'production' })),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('AUTH_ALLOW_SESSIONLESS_TOKENS');
  });

  it.each(['development', 'test'])(
    '[FR-T01] arranca con AUTH_ALLOW_SESSIONLESS_TOKENS=true y NODE_ENV=%s',
    (nodeEnv) => {
      const env = loadEnv(baseEnv({ AUTH_ALLOW_SESSIONLESS_TOKENS: 'true', NODE_ENV: nodeEnv }));
      expect(env.allowSessionlessTokens).toBe(true);
    },
  );

  it('[FR-T01] arranca con AUTH_ALLOW_SESSIONLESS_TOKENS=true y sin NODE_ENV', () => {
    const env = loadEnv(baseEnv({ AUTH_ALLOW_SESSIONLESS_TOKENS: 'true' }));
    expect(env.allowSessionlessTokens).toBe(true);
  });

  it('[FR-T01] en producción arranca con AUTH_ALLOW_SESSIONLESS_TOKENS=false o ausente', () => {
    expect(
      loadEnv(baseEnv({ AUTH_ALLOW_SESSIONLESS_TOKENS: 'false', NODE_ENV: 'production' }))
        .allowSessionlessTokens,
    ).toBe(false);
    expect(loadEnv(baseEnv({ NODE_ENV: 'production' })).allowSessionlessTokens).toBe(false);
  });

  it('[R9] AUTH_ALLOW_SESSIONLESS_TOKENS vale false por defecto', () => {
    expect(loadEnv(baseEnv()).allowSessionlessTokens).toBe(false);
  });

  it('[R11] AUTH_COOKIE_SECURE vale true por defecto y acepta false', () => {
    expect(loadEnv(baseEnv()).cookieSecure).toBe(true);
    expect(loadEnv(baseEnv({ AUTH_COOKIE_SECURE: 'false' })).cookieSecure).toBe(false);
    expect(loadEnv(baseEnv({ AUTH_COOKIE_SECURE: 'true' })).cookieSecure).toBe(true);
  });

  it.each(['yes', '1', 'on', 'verdadero', 'tru'])(
    '[R9] AUTH_ALLOW_SESSIONLESS_TOKENS=%s (ni true ni false) da error',
    (value) => {
      const error = errorOf(() => loadEnv(baseEnv({ AUTH_ALLOW_SESSIONLESS_TOKENS: value })));
      expect(error.message).toContain('AUTH_ALLOW_SESSIONLESS_TOKENS');
    },
  );

  it.each(['no', '0', 'off', 'falso'])(
    '[R11] AUTH_COOKIE_SECURE=%s (ni true ni false) da error',
    (value) => {
      const error = errorOf(() => loadEnv(baseEnv({ AUTH_COOKIE_SECURE: value })));
      expect(error.message).toContain('AUTH_COOKIE_SECURE');
    },
  );
});

describe('AUTH_COOKIE_SECURE en producción (ajuste 2 del reviewer T031, research R11)', () => {
  it('[R11][T031-2] loadEnv lanza un error que nombra AUTH_COOKIE_SECURE si es false con NODE_ENV=production', () => {
    const error = errorOf(() =>
      loadEnv(baseEnv({ AUTH_COOKIE_SECURE: 'false', NODE_ENV: 'production' })),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('AUTH_COOKIE_SECURE');
  });

  it('[R11][T031-2] readAuthFlags aplica la misma regla (la usa cookies.ts en cada respuesta)', () => {
    expect(() =>
      readAuthFlags({ AUTH_COOKIE_SECURE: 'false', NODE_ENV: 'production' }),
    ).toThrow(/AUTH_COOKIE_SECURE/);
  });

  it('[R11][T031-2] en producción arranca con AUTH_COOKIE_SECURE=true o ausente', () => {
    expect(
      loadEnv(baseEnv({ AUTH_COOKIE_SECURE: 'true', NODE_ENV: 'production' })).cookieSecure,
    ).toBe(true);
    expect(loadEnv(baseEnv({ NODE_ENV: 'production' })).cookieSecure).toBe(true);
  });

  it.each(['development', 'test'])(
    '[R11][T031-2] AUTH_COOKIE_SECURE=false sigue permitido con NODE_ENV=%s',
    (nodeEnv) => {
      expect(
        loadEnv(baseEnv({ AUTH_COOKIE_SECURE: 'false', NODE_ENV: nodeEnv })).cookieSecure,
      ).toBe(false);
    },
  );

  it('[R11][T031-2][FR-T01] con las dos banderas inválidas en producción el error nombra ambas', () => {
    const error = errorOf(() =>
      loadEnv(
        baseEnv({
          AUTH_ALLOW_SESSIONLESS_TOKENS: 'true',
          AUTH_COOKIE_SECURE: 'false',
          NODE_ENV: 'production',
        }),
      ),
    );
    expect(error.message).toContain('AUTH_ALLOW_SESSIONLESS_TOKENS');
    expect(error.message).toContain('AUTH_COOKIE_SECURE');
  });
});

describe('loadEnv: validaciones de la 001 sin cambios (T006)', () => {
  it('[T006] con la configuración mínima devuelve los campos de la 001 y el puerto por defecto', () => {
    expect(loadEnv(baseEnv())).toMatchObject({
      databaseUrl: 'postgres://motorsync_app:pw@localhost:5432/motorsync',
      databaseMigratorUrl: 'postgres://motorsync_migrator:pw@localhost:5432/motorsync',
      jwtSecret: VALID_SECRET,
      port: 3000,
    });
  });

  it('[T006] JWT_SECRET con menos de 32 caracteres da error', () => {
    const error = errorOf(() => loadEnv(baseEnv({ JWT_SECRET: 'x'.repeat(31) })));
    expect(error.message).toContain('JWT_SECRET');
  });

  it.each(['DATABASE_URL', 'DATABASE_MIGRATOR_URL', 'JWT_SECRET'])(
    '[T006] sin %s da un error que la nombra',
    (name) => {
      const error = errorOf(() => loadEnv(baseEnv({ [name]: undefined })));
      expect(error.message).toContain(name);
    },
  );

  it('[T006] PORT fuera de rango o no entero da error', () => {
    expect(() => loadEnv(baseEnv({ PORT: '0' }))).toThrow(/PORT/);
    expect(() => loadEnv(baseEnv({ PORT: '70000' }))).toThrow(/PORT/);
    expect(() => loadEnv(baseEnv({ PORT: 'abc' }))).toThrow(/PORT/);
    expect(loadEnv(baseEnv({ PORT: '8080' })).port).toBe(8080);
  });
});

describe('readAuthFlags (T006, usada por el guard y cookies.ts)', () => {
  it('[R9][R11] solo lee las banderas: no exige DATABASE_URL ni JWT_SECRET; por defecto false y true', () => {
    expect(readAuthFlags({})).toEqual({ allowSessionlessTokens: false, cookieSecure: true });
  });

  it('[R9][R11] lee true y false de cada bandera', () => {
    expect(
      readAuthFlags({ AUTH_ALLOW_SESSIONLESS_TOKENS: 'true', AUTH_COOKIE_SECURE: 'false' }),
    ).toEqual({ allowSessionlessTokens: true, cookieSecure: false });
  });

  it('[FR-T01] aplica la misma regla: true con NODE_ENV=production da error', () => {
    expect(() =>
      readAuthFlags({ AUTH_ALLOW_SESSIONLESS_TOKENS: 'true', NODE_ENV: 'production' }),
    ).toThrow(/AUTH_ALLOW_SESSIONLESS_TOKENS/);
  });

  it('[R9] un valor distinto de true o false da error', () => {
    expect(() => readAuthFlags({ AUTH_ALLOW_SESSIONLESS_TOKENS: 'yes' })).toThrow(
      /AUTH_ALLOW_SESSIONLESS_TOKENS/,
    );
  });

  it('[R9] por defecto lee process.env', () => {
    const previous = process.env.AUTH_ALLOW_SESSIONLESS_TOKENS;
    try {
      process.env.AUTH_ALLOW_SESSIONLESS_TOKENS = 'false';
      expect(readAuthFlags().allowSessionlessTokens).toBe(false);
      process.env.AUTH_ALLOW_SESSIONLESS_TOKENS = 'true';
      expect(readAuthFlags().allowSessionlessTokens).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.AUTH_ALLOW_SESSIONLESS_TOKENS;
      else process.env.AUTH_ALLOW_SESSIONLESS_TOKENS = previous;
    }
  });
});
