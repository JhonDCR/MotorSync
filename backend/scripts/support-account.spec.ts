// T024 (specs/003-soporte-plataforma, Phase 4, US2): unit tests of the operations procedure
// (research R5) without a database. They pin the argument parsing and the validation rules of
// backend/scripts/support-account.ts (T026): commands, --name/--email/--confirm, the email and
// name rules, the refusal to run without DATABASE_MIGRATOR_URL and the single print of the
// temporary password on stdout (R9). The pool is always a fake that records its calls: no test
// connects to PostgreSQL.
//
// Contract under test (T026):
//   export async function runSupportAccount(
//     argv: string[],
//     deps?: SupportAccountDeps,
//   ): Promise<number>;
// argv has no `node` and no script name: only [command, ...flags]. Usage and operation errors
// never throw: they go to stderr and return 1.
import type { Pool } from 'pg';
import { runSupportAccount } from './support-account.js';

/** Format of the temporary password of research R9 and T009. */
const TEMPORARY_PASSWORD_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/;

function temporaryMatches(text: string): string[] {
  return text.match(new RegExp(TEMPORARY_PASSWORD_RE.source, 'g')) ?? [];
}

interface FakeResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

type FakeHandler = (
  text: string,
  values: unknown[],
) => FakeResult | Promise<FakeResult>;

interface FakePoolHarness {
  pool: Pool;
  /** SQL sent to the fake pool, in order. */
  calls: { text: string; values: unknown[] }[];
  /** Times the script asked for a client (a connection would be opened). */
  connects: () => number;
  /** True if the script called pool.end() (it must not close a pool it did not create). */
  wasEnded: () => boolean;
}

/**
 * Fake pg.Pool: it records every query and every connect() and never reaches a database. Both
 * pool.query() and the client returned by connect() go through the same handler, so the tests do
 * not depend on whether the script uses one or the other.
 */
function fakePool(
  handler: FakeHandler = () => ({ rows: [], rowCount: 0 }),
): FakePoolHarness {
  const calls: { text: string; values: unknown[] }[] = [];
  let connects = 0;
  let ended = false;

  const execute = async (
    query: string | { text: string; values?: unknown[] },
    values: unknown[] = [],
  ): Promise<FakeResult> => {
    const text = typeof query === 'string' ? query : query.text;
    const params = typeof query === 'string' ? values : (query.values ?? []);
    calls.push({ text, values: params });
    return handler(text, params);
  };

  const client = {
    query: execute,
    release: () => undefined,
  };
  const pool = {
    query: execute,
    connect: async () => {
      connects += 1;
      return client;
    },
    end: async () => {
      ended = true;
    },
  };

  return {
    pool: pool as unknown as Pool,
    calls,
    connects: () => connects,
    wasEnded: () => ended,
  };
}

interface RunOutcome {
  code: number;
  stdout: string[];
  stderr: string[];
  /** stdout joined with '\n', for substring and temporary-password checks. */
  text: string;
}

async function run(
  argv: string[],
  options: { pool?: Pool; env?: NodeJS.ProcessEnv } = {},
): Promise<RunOutcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runSupportAccount(argv, {
    pool: options.pool,
    env: options.env,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  });
  return { code, stdout, stderr, text: stdout.join('\n') };
}

const LIST_ROWS = [
  {
    name: 'Pedro Soporte',
    email: 'pedro@motorsync.ec',
    status: 'active',
    created_at: new Date('2026-10-01T12:00:00Z'),
  },
  {
    name: 'Lucía Soporte',
    email: 'lucia@motorsync.ec',
    status: 'inactive',
    created_at: new Date('2026-09-15T08:30:00Z'),
  },
];

const CREATED_ACCOUNT = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Pedro Soporte',
  email: 'pedro@motorsync.ec',
  status: 'active',
  created_at: new Date('2026-10-01T12:00:00Z'),
};

/**
 * Fake of a successful create: the workshop-email check says the address is free, the first
 * SELECT of support_accounts finds nothing and the INSERT (or a later SELECT) returns the row.
 */
function createHarness(): FakePoolHarness {
  let inserted = false;
  return fakePool((text) => {
    if (/support_workshop_email_exists/i.test(text)) {
      return { rows: [{ exists: false }], rowCount: 1 };
    }
    if (/insert\s+into\s+support_accounts/i.test(text)) {
      inserted = true;
      return { rows: [{ ...CREATED_ACCOUNT }], rowCount: 1 };
    }
    if (inserted && /select/i.test(text) && /support_accounts/i.test(text)) {
      return { rows: [{ ...CREATED_ACCOUNT }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('support-account (unitaria, T024, US2)', () => {
  it.each<[string, string[], RegExp]>([
    ['sin --name', ['create', '--email', 'pedro@motorsync.ec'], /name/i],
    ['sin --email', ['create', '--name', 'Pedro Soporte'], /email/i],
  ])(
    '[T024] create %s → 1, stderr nombra el campo y no toca la base',
    async (_label, argv, field) => {
      const harness = fakePool();
      const result = await run(argv, { pool: harness.pool });

      expect(result.code).toBe(1);
      expect(result.stderr.join('\n')).toMatch(field);
      expect(harness.calls).toEqual([]);
      expect(harness.connects()).toBe(0);
    },
  );

  it.each<[string, string]>([
    ['1 carácter', 'A'],
    ['121 caracteres', 'A'.repeat(121)],
  ])(
    '[T024] create con nombre de %s → 1 y no toca la base',
    async (_label, name) => {
      const harness = fakePool();
      const result = await run(
        ['create', '--name', name, '--email', 'pedro@motorsync.ec'],
        { pool: harness.pool },
      );

      expect(result.code).toBe(1);
      expect(result.stderr.join('\n')).toMatch(/name/i);
      expect(harness.calls).toEqual([]);
      expect(harness.connects()).toBe(0);
    },
  );

  it.each<[string]>([['nadie'], ['a@b.c']])(
    '[T024] create con correo inválido %j → 1 y no toca la base',
    async (email) => {
      const harness = fakePool();
      const result = await run(
        ['create', '--name', 'Pedro Soporte', '--email', email],
        { pool: harness.pool },
      );

      expect(result.code).toBe(1);
      expect(result.stderr.join('\n')).toMatch(/email/i);
      expect(harness.calls).toEqual([]);
      expect(harness.connects()).toBe(0);
    },
  );

  it.each<[string]>([['deactivate'], ['reactivate'], ['reset-password']])(
    '[T024] %s sin --confirm → 1, stderr contiene --confirm y no toca la base',
    async (command) => {
      const harness = fakePool();
      const result = await run([command, '--email', 'pedro@motorsync.ec'], {
        pool: harness.pool,
      });

      expect(result.code).toBe(1);
      expect(result.stderr.join('\n')).toContain('--confirm');
      expect(harness.calls).toEqual([]);
      expect(harness.connects()).toBe(0);
    },
  );

  it.each<[string]>([['delete'], ['inventado']])(
    '[T024] el comando %s no existe → 1, stderr lo menciona y no toca la base',
    async (command) => {
      const harness = fakePool();
      const result = await run([command], { pool: harness.pool });

      expect(result.code).toBe(1);
      expect(result.stderr.join('\n')).toContain(command);
      expect(harness.calls).toEqual([]);
      expect(harness.connects()).toBe(0);
    },
  );

  it.each<[string, string[]]>([
    ['flag desconocido --force', ['list', '--force']],
    ['--email sin valor', ['create', '--name', 'Pedro Soporte', '--email']],
  ])('[T024] %s → 1 y no toca la base', async (_label, argv) => {
    const harness = fakePool();
    const result = await run(argv, { pool: harness.pool });

    expect(result.code).toBe(1);
    expect(harness.calls).toEqual([]);
    expect(harness.connects()).toBe(0);
  });

  it('[T024] sin deps.pool y con env {} → 1, stderr contiene DATABASE_MIGRATOR_URL y no conecta', async () => {
    const result = await run(['list'], { env: {} });

    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toContain('DATABASE_MIGRATOR_URL');
  });

  it('[T024] list con dos filas → 0, nombre/correo/estado/fecha de cada una y ningún hash', async () => {
    const harness = fakePool(() => ({
      rows: LIST_ROWS.map((row) => ({ ...row })),
      rowCount: LIST_ROWS.length,
    }));
    const result = await run(['list'], { pool: harness.pool });

    expect(result.code, result.stderr.join('\n')).toBe(0);
    for (const row of LIST_ROWS) {
      const line = result.stdout.find((value) => value.includes(row.email));
      expect(line, `stdout: ${result.text}`).toBeDefined();
      expect(line).toContain(row.name);
      expect(line).toContain(row.status);
      expect(line).toMatch(
        /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/,
      );
    }
    expect(result.text).not.toContain('scrypt$');
    expect(result.text.toLowerCase()).not.toContain('password_hash');
    expect(harness.wasEnded()).toBe(false);
  });

  it('[T024] create correcto → 0, una sola temporal de R9 en stdout y stderr vacío', async () => {
    const harness = createHarness();
    const result = await run(
      ['create', '--name', 'Pedro Soporte', '--email', ' Pedro@MotorSync.EC '],
      { pool: harness.pool },
    );

    expect(result.code, result.stderr.join('\n')).toBe(0);
    const temporaries = temporaryMatches(result.text);
    expect(temporaries).toHaveLength(1);
    expect(temporaries[0]).toMatch(TEMPORARY_PASSWORD_RE);
    expect(result.stderr).toEqual([]);
    expect(harness.wasEnded()).toBe(false);
  });

  it('[T024] un error de la base → 1, el mensaje va a stderr y no se propaga', async () => {
    const harness = fakePool(() => {
      throw new Error('fallo de base de datos');
    });
    const result = await run(['list'], { pool: harness.pool });

    expect(result.code).toBe(1);
    expect(result.stderr.join('\n')).toContain('fallo de base de datos');
  });
});
