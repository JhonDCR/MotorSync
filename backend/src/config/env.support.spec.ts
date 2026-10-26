// T007 (specs/003-soporte-plataforma): the support panel signs its tokens with its own secret
// (research R3). loadEnv must require SUPPORT_JWT_SECRET in every NODE_ENV, with at least 32
// characters and different from JWT_SECRET, and must reject the .env.example sample value only in
// production. The 002 rules (FR-T01, AUTH_COOKIE_SECURE) must keep working exactly as before.
// loadEnv receives an explicit source, so process.env (and the test-only defaults of
// vitest.config.ts) never leaks into these cases. env.spec.ts (002) is not touched.
// This is the RED test of T007: AppEnv.supportJwtSecret and the SUPPORT_JWT_SECRET checks (T008)
// do not exist yet, so these cases fail. That is expected.
import { loadEnv } from './env.js';

const VALID_JWT_SECRET = 'a-jwt-secret-that-has-at-least-32-chars';
const VALID_SUPPORT_SECRET = 'a-support-jwt-secret-with-at-least-32-chars';
/** Literal value of SUPPORT_JWT_SECRET in .env.example. */
const EXAMPLE_SUPPORT_SECRET =
  'dev-only-support-secret-change-me-0123456789abcdef';

/** Every NODE_ENV the rule must cover, including its absence. */
const ANY_NODE_ENV = [
  { label: 'sin NODE_ENV', nodeEnv: undefined },
  { label: 'NODE_ENV=development', nodeEnv: 'development' },
  { label: 'NODE_ENV=test', nodeEnv: 'test' },
  { label: 'NODE_ENV=production', nodeEnv: 'production' },
];

function baseEnv(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://motorsync_app:pw@localhost:5432/motorsync',
    DATABASE_MIGRATOR_URL:
      'postgres://motorsync_migrator:pw@localhost:5432/motorsync',
    JWT_SECRET: VALID_JWT_SECRET,
    SUPPORT_JWT_SECRET: VALID_SUPPORT_SECRET,
    ...extra,
  };
}

function withNodeEnv(nodeEnv: string | undefined): Record<string, string> {
  return nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv };
}

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to throw');
}

describe('loadEnv: SUPPORT_JWT_SECRET obligatoria (T007, research R3)', () => {
  it.each(ANY_NODE_ENV)(
    '[T007] sin SUPPORT_JWT_SECRET falla nombrando la variable ($label)',
    ({ nodeEnv }) => {
      const error = errorOf(() =>
        loadEnv(
          baseEnv({ SUPPORT_JWT_SECRET: undefined, ...withNodeEnv(nodeEnv) }),
        ),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('SUPPORT_JWT_SECRET');
    },
  );

  it.each(ANY_NODE_ENV)(
    '[T007] con SUPPORT_JWT_SECRET vacía o solo espacios falla ($label)',
    ({ nodeEnv }) => {
      for (const value of ['', '   ', '\t\n ']) {
        const error = errorOf(() =>
          loadEnv(
            baseEnv({ SUPPORT_JWT_SECRET: value, ...withNodeEnv(nodeEnv) }),
          ),
        );
        expect(error.message).toContain('SUPPORT_JWT_SECRET');
      }
    },
  );

  it.each(ANY_NODE_ENV)(
    '[T007] con SUPPORT_JWT_SECRET de menos de 32 caracteres falla ($label)',
    ({ nodeEnv }) => {
      for (const value of ['x', 'x'.repeat(31)]) {
        const error = errorOf(() =>
          loadEnv(
            baseEnv({ SUPPORT_JWT_SECRET: value, ...withNodeEnv(nodeEnv) }),
          ),
        );
        expect(error.message).toContain('SUPPORT_JWT_SECRET');
      }
    },
  );

  it.each(ANY_NODE_ENV)(
    '[T007] con SUPPORT_JWT_SECRET igual a JWT_SECRET falla ($label)',
    ({ nodeEnv }) => {
      const error = errorOf(() =>
        loadEnv(
          baseEnv({
            JWT_SECRET: VALID_JWT_SECRET,
            SUPPORT_JWT_SECRET: VALID_JWT_SECRET,
            ...withNodeEnv(nodeEnv),
          }),
        ),
      );
      expect(error.message).toContain('SUPPORT_JWT_SECRET');
    },
  );

  it('[T007] la comparación con JWT_SECRET usa los valores ya recortados', () => {
    const error = errorOf(() =>
      loadEnv(
        baseEnv({
          JWT_SECRET: `  ${VALID_JWT_SECRET}  `,
          SUPPORT_JWT_SECRET: `\t${VALID_JWT_SECRET} `,
        }),
      ),
    );
    expect(error.message).toContain('SUPPORT_JWT_SECRET');
  });

  it('[T007][R3] con NODE_ENV=production rechaza el valor de ejemplo de .env.example', () => {
    const error = errorOf(() =>
      loadEnv(
        baseEnv({
          SUPPORT_JWT_SECRET: EXAMPLE_SUPPORT_SECRET,
          NODE_ENV: 'production',
        }),
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('SUPPORT_JWT_SECRET');
  });

  it('[T007] fuera de producción acepta el valor de ejemplo de .env.example', () => {
    const env = loadEnv(
      baseEnv({ SUPPORT_JWT_SECRET: EXAMPLE_SUPPORT_SECRET }),
    );
    expect(env.supportJwtSecret).toBe(EXAMPLE_SUPPORT_SECRET);
  });
});

describe('loadEnv: AppEnv.supportJwtSecret (T007, research R3)', () => {
  it('[T007][R3] con un valor válido lo expone tal cual y distinto de JWT_SECRET', () => {
    const env = loadEnv(baseEnv());
    expect(env.supportJwtSecret).toBe(VALID_SUPPORT_SECRET);
    expect(env.jwtSecret).toBe(VALID_JWT_SECRET);
    expect(env.supportJwtSecret).not.toBe(env.jwtSecret);
  });

  it('[T007] con un valor válido rodeado de espacios lo expone recortado', () => {
    const env = loadEnv(
      baseEnv({ SUPPORT_JWT_SECRET: `  ${VALID_SUPPORT_SECRET}  ` }),
    );
    expect(env.supportJwtSecret).toBe(VALID_SUPPORT_SECRET);
  });

  it('[T007] exactamente 32 caracteres es válido', () => {
    const secret = 's'.repeat(32);
    expect(
      loadEnv(baseEnv({ SUPPORT_JWT_SECRET: secret })).supportJwtSecret,
    ).toBe(secret);
  });

  it('[T007][R3] en producción arranca con un valor válido', () => {
    const env = loadEnv(baseEnv({ NODE_ENV: 'production' }));
    expect(env.supportJwtSecret).toBe(VALID_SUPPORT_SECRET);
    expect(env.cookieSecure).toBe(true);
    expect(env.allowSessionlessTokens).toBe(false);
  });
});

describe('loadEnv: validaciones de la 002 intactas con SUPPORT_JWT_SECRET válida (T007)', () => {
  it('[FR-T01] AUTH_ALLOW_SESSIONLESS_TOKENS=true con NODE_ENV=production sigue fallando', () => {
    const error = errorOf(() =>
      loadEnv(
        baseEnv({
          AUTH_ALLOW_SESSIONLESS_TOKENS: 'true',
          NODE_ENV: 'production',
        }),
      ),
    );
    expect(error.message).toContain(
      'AUTH_ALLOW_SESSIONLESS_TOKENS=true is not allowed with NODE_ENV=production',
    );
    expect(error.message).not.toContain('SUPPORT_JWT_SECRET');
  });

  it('[R11] AUTH_COOKIE_SECURE=false con NODE_ENV=production sigue fallando', () => {
    const error = errorOf(() =>
      loadEnv(baseEnv({ AUTH_COOKIE_SECURE: 'false', NODE_ENV: 'production' })),
    );
    expect(error.message).toContain(
      'AUTH_COOKIE_SECURE=false is not allowed with NODE_ENV=production',
    );
    expect(error.message).not.toContain('SUPPORT_JWT_SECRET');
  });

  it('[FR-T01][R11] con las dos banderas inválidas en producción el error nombra ambas y no el secreto de soporte', () => {
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
    expect(error.message).not.toContain('SUPPORT_JWT_SECRET');
  });

  it('[T007] las banderas de la 002 fuera de producción siguen permitidas con SUPPORT_JWT_SECRET válida', () => {
    const env = loadEnv(
      baseEnv({
        AUTH_ALLOW_SESSIONLESS_TOKENS: 'true',
        AUTH_COOKIE_SECURE: 'false',
        NODE_ENV: 'test',
      }),
    );
    expect(env.allowSessionlessTokens).toBe(true);
    expect(env.cookieSecure).toBe(false);
    expect(env.supportJwtSecret).toBe(VALID_SUPPORT_SECRET);
  });
});
