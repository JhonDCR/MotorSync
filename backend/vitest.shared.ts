import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ViteUserConfig } from 'vitest/config';

// Common base of the suites that run against the real PostgreSQL (e2e and perf).

/**
 * Local development: variables come from the repo-root env file, if present.
 * In CI they come from the job env (already set variables are never overridden).
 */
export function loadRootEnv(): void {
  const rootEnvFile = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);
}

type DatabaseSuiteOptions = {
  include: string[];
  testTimeout?: number;
  hookTimeout?: number;
};

export function databaseSuiteConfig(options: DatabaseSuiteOptions): ViteUserConfig {
  return {
    resolve: { tsconfigPaths: true },
    test: {
      globals: true,
      root: './',
      globalSetup: ['./test/setup/global-setup.ts'],
      // The suites share one database: run the files one at a time.
      fileParallelism: false,
      ...options,
    },
  };
}
