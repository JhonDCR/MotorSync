export interface AppEnv {
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

  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration: ${problems.join('; ')}.`);
  }
  return { databaseUrl, databaseMigratorUrl, jwtSecret, port };
}
