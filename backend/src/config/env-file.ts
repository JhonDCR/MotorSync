import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directory of backend/package.json, found by walking up from this module. Works the same
 * from the TypeScript sources (Vitest) and from the compiled output in dist/.
 */
export function backendRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not locate backend/package.json');
    dir = parent;
  }
  return dir;
}

/**
 * Loads the repo-root env file (local development) if it exists. Variables already present
 * in the environment (CI job env) are not overridden.
 */
export function loadRootEnvFile(): void {
  const file = join(dirname(backendRoot()), '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
