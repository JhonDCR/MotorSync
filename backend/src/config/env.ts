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
  port: number;
}

const JWT_SECRET_MIN_LENGTH = 32;
const DEFAULT_PORT = 3000;

/** Returns a required, non-empty environment variable or throws a clear error. */
export function requireEnv(name: string, source: NodeJS.ProcessEnv = process.env): string {
  const value = source[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Locally copy .env.example to .env; in CI set it in the job env.`,
    );
  }
  return value;
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

function collectAuthFlags(source: NodeJS.ProcessEnv, problems: string[]): AuthFlags {
  const allowSessionlessTokens = readBoolean(
    source,
    'AUTH_ALLOW_SESSIONLESS_TOKENS',
    false,
    problems,
  );
  const cookieSecure = readBoolean(source, 'AUTH_COOKIE_SECURE', true, problems);
  const production = source.NODE_ENV?.trim() === 'production';
  // FR-T01: tokens without a session are never accepted in production.
  if (allowSessionlessTokens && production) {
    problems.push('AUTH_ALLOW_SESSIONLESS_TOKENS=true is not allowed with NODE_ENV=production');
  }
  // Research R11 (T031-2): the refresh cookie always carries Secure in production.
  if (!cookieSecure && production) {
    problems.push('AUTH_COOKIE_SECURE=false is not allowed with NODE_ENV=production');
  }
  return { allowSessionlessTokens, cookieSecure };
}

function throwIfProblems(problems: string[]): void {
  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration: ${problems.join('; ')}.`);
  }
}

/**
 * Reads only the auth flags (used per request by the guard and by cookies.ts), applying the same
 * rules as loadEnv, FR-T01 included. Does not require the database or JWT variables.
 */
export function readAuthFlags(source: NodeJS.ProcessEnv = process.env): AuthFlags {
  const problems: string[] = [];
  const flags = collectAuthFlags(source, problems);
  throwIfProblems(problems);
  return flags;
}

/** Reads and validates the API configuration. Throws at startup if anything is missing. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const problems: string[] = [];
  const read = (name: string): string => {
    try {
      return requireEnv(name, source);
    } catch {
      problems.push(`${name} is missing`);
      return '';
    }
  };

  const databaseUrl = read('DATABASE_URL');
  const databaseMigratorUrl = read('DATABASE_MIGRATOR_URL');
  const jwtSecret = read('JWT_SECRET');
  if (jwtSecret && jwtSecret.length < JWT_SECRET_MIN_LENGTH) {
    problems.push(`JWT_SECRET must have at least ${JWT_SECRET_MIN_LENGTH} characters`);
  }

  const rawPort = source.PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer between 1 and 65535 (got "${rawPort}")`);
  }

  const flags = collectAuthFlags(source, problems);

  throwIfProblems(problems);
  return { databaseUrl, databaseMigratorUrl, jwtSecret, port, ...flags };
}
