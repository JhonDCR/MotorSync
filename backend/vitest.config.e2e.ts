import { defineConfig } from 'vitest/config';
import { allowSessionlessTokensInTests, databaseSuiteConfig, loadRootEnv } from './vitest.shared.js';

loadRootEnv();
allowSessionlessTokensInTests();

// The e2e suites truncate the business tables between tests (one shared database).
export default defineConfig(databaseSuiteConfig({ include: ['**/*.e2e-spec.ts'] }));
