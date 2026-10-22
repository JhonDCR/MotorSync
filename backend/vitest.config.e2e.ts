import { defineConfig } from 'vitest/config';
import { databaseSuiteConfig, loadRootEnv } from './vitest.shared.js';

loadRootEnv();

// The e2e suites truncate the business tables between tests (one shared database).
export default defineConfig(databaseSuiteConfig({ include: ['**/*.e2e-spec.ts'] }));
