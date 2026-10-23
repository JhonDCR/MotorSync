// Adjustment 3 of the T031 review (specs/002-autenticacion, tasks.md "# PR2"): npm run db:seed:dev
// creates accounts with a known development password, so it never runs with NODE_ENV=production.
// Kept apart from seed-dev.ts (which runs main() when loaded) so the rule has its own unit test.

/** Throws an error naming NODE_ENV when it is 'production' (surrounding spaces ignored). */
export function assertSeedAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV?.trim() === 'production') {
    throw new Error(
      'db:seed:dev is not allowed with NODE_ENV=production: it creates accounts with a known development password.',
    );
  }
}
