export interface AuthFlags {
  /** Accept tokens without `sid` (dev and 001 test tokens). Default false (research R9). */
  allowSessionlessTokens: boolean;
  /** `Secure` attribute of the refresh cookie. Default true (research R11). */
  cookieSecure: boolean;
}

export interface AppEnv extends AuthFlags {
  databaseUrl: string;
  databaseMigratorUrl: string;
  jwtSecret: string;
  /** Signing secret of the support panel tokens (research R3). Never has a default value. */
  supportJwtSecret: string;
  port: number;
}

const SECRET_MIN_LENGTH = 32;
/** Literal value of SUPPORT_JWT_SECRET in .env.example; rejected only in production (R3). */
const EXAMPLE_SUPPORT_JWT_SECRET =
  'dev-only-support-secret-change-me-0123456789abcdef';
const DEFAULT_PORT = 3000;

/** Returns a required, non-empty environment variable or throws a clear error. */
export function requireEnv(
  name: string,
  source: NodeJS.ProcessEnv = process.env,
): string {
  const value = source[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Locally copy .env.example to .env; in CI set it in the job env.`,
    );
  }
  return value;
}

/**
 * Reads SUPPORT_JWT_SECRET, trimmed, or undefined when it is missing or blank (research R3).
 * The guard and the support token service read it per request; unlike loadEnv it never throws.
 */
export function readSupportJwtSecret(
  source: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = source.SUPPORT_JWT_SECRET?.trim();
  return value ? value : undefined;
}

/** Same as requireEnv, but records a problem instead of throwing so loadEnv can report them all. */
function readRequired(
  name: string,
  source: NodeJS.ProcessEnv,
  problems: string[],
): string {
  try {
    return requireEnv(name, source);
  } catch {
    problems.push(`${name} is missing`);
    return '';
  }
}

/** Reads an optional boolean flag: only the exact values 'true' and 'false' are accepted. */
function readBoolean(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
  problems: string[],
): boolean {
  const raw = source[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push(`${name} must be "true" or "false" (got "${raw}")`);
  return fallback;
}

function isProduction(source: NodeJS.ProcessEnv): boolean {
  return source.NODE_ENV?.trim() === 'production';
}

function collectAuthFlags(
  source: NodeJS.ProcessEnv,
  problems: string[],
): AuthFlags {
  const allowSessionlessTokens = readBoolean(
    source,
    'AUTH_ALLOW_SESSIONLESS_TOKENS',
    false,
    problems,
  );
  const cookieSecure = readBoolean(
    source,
    'AUTH_COOKIE_SECURE',
    true,
    problems,
  );
  const production = isProduction(source);
  // FR-T01: tokens without a session are never accepted in production.
  if (allowSessionlessTokens && production) {
    problems.push(
      'AUTH_ALLOW_SESSIONLESS_TOKENS=true is not allowed with NODE_ENV=production',
    );
  }
  // Research R11 (T031-2): the refresh cookie always carries Secure in production.
  if (!cookieSecure && production) {
    problems.push(
      'AUTH_COOKIE_SECURE=false is not allowed with NODE_ENV=production',
    );
  }
  return { allowSessionlessTokens, cookieSecure };
}

function throwIfProblems(problems: string[]): void {
  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration: ${problems.join('; ')}.`,
    );
  }
}

/**
 * Reads only the auth flags (used per request by the guard and by cookies.ts), applying the same
 * rules as loadEnv, FR-T01 included. Does not require the database or JWT variables.
 */
export function readAuthFlags(
  source: NodeJS.ProcessEnv = process.env,
): AuthFlags {
  const problems: string[] = [];
  const flags = collectAuthFlags(source, problems);
  throwIfProblems(problems);
  return flags;
}

/** Reads and validates the API configuration. Throws at startup if anything is missing. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const problems: string[] = [];

  const databaseUrl = readRequired('DATABASE_URL', source, problems);
  const databaseMigratorUrl = readRequired(
    'DATABASE_MIGRATOR_URL',
    source,
    problems,
  );
  const jwtSecret = readRequired('JWT_SECRET', source, problems);
  // Research R3: the support panel has its own secret, different from JWT_SECRET. A source that
  // does not mention it at all is a partial overlay (the specs), so the key is inherited from
  // process.env; an explicit undefined or blank value still counts as missing.
  const supportSource: NodeJS.ProcessEnv =
    'SUPPORT_JWT_SECRET' in source ? source : process.env;
  const supportJwtSecret = readRequired(
    'SUPPORT_JWT_SECRET',
    supportSource,
    problems,
  );

  if (jwtSecret && jwtSecret.length < SECRET_MIN_LENGTH) {
    problems.push(
      `JWT_SECRET must have at least ${SECRET_MIN_LENGTH} characters`,
    );
  }
  if (supportJwtSecret) {
    if (supportJwtSecret.length < SECRET_MIN_LENGTH) {
      problems.push(
        `SUPPORT_JWT_SECRET must have at least ${SECRET_MIN_LENGTH} characters`,
      );
    } else if (supportJwtSecret === jwtSecret) {
      problems.push('SUPPORT_JWT_SECRET must be different from JWT_SECRET');
    } else if (
      isProduction(source) &&
      supportJwtSecret === EXAMPLE_SUPPORT_JWT_SECRET
    ) {
      problems.push(
        'SUPPORT_JWT_SECRET must not be the .env.example sample value with NODE_ENV=production',
      );
    }
  }

  const rawPort = source.PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(
      `PORT must be an integer between 1 and 65535 (got "${rawPort}")`,
    );
  }

  const flags = collectAuthFlags(source, problems);

  throwIfProblems(problems);
  return {
    databaseUrl,
    databaseMigratorUrl,
    jwtSecret,
    supportJwtSecret,
    port,
    ...flags,
  };
}
