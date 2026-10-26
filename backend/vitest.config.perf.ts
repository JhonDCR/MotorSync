import { defineConfig } from 'vitest/config';
import {
  allowSessionlessTokensInTests,
  databaseSuiteConfig,
  loadRootEnv,
  supportJwtSecretInTests,
} from './vitest.shared.js';

loadRootEnv();
allowSessionlessTokensInTests();
supportJwtSecretInTests();

// T060: performance suite (US1-AC10). Loading the reference volume can take minutes the first
// time, hence the wide timeouts. Not picked up by `npm run test:e2e` (different suffix).
export default defineConfig(
  databaseSuiteConfig({
    include: ['test/perf/**/*.perf-spec.ts'],
    testTimeout: 600_000,
    hookTimeout: 1_200_000,
  }),
);
