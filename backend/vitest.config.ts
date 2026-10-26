import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Test-only default (research R9): the 001 suites keep using tokens without sid.
    env: {
      AUTH_ALLOW_SESSIONLESS_TOKENS: 'true',
      SUPPORT_JWT_SECRET: 'test-only-support-secret-0123456789abcdef',
    },
  },
});
