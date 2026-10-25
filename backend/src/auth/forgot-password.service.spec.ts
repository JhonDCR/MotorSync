// T020 (specs/003-soporte-plataforma): ForgotPasswordService, el camino único de
// "¿Olvidaste tu contraseña?" (research R7 y R8; US1-AC6, FR-003). Una sola llamada a
// support_request_help(email, origin_hash) dentro de withAuthTransaction, sin taller, con el
// piso de HELP_RESPONSE_FLOOR_MS desde el inicio de la petición y sin registrar el correo.
// Entrega en rojo: el servicio llega en T021. El DataSource, el reloj y sus esperas son falsos,
// como en las specs de la 001/002; la SQL real se cubre en las e2e de T022.
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { ProblemException } from '../common/problem-details.filter.js';
import {
  FORGOT_PASSWORD_CLOCK,
  ForgotPasswordService,
  HELP_RESPONSE_FLOOR_MS,
  type ForgotPasswordClock,
} from './forgot-password.service.js';

const STARTED_AT = 1_000;
const EMAIL = 'ana.perez@taller.ec';
const IP = '203.0.113.7';
/** SHA-256 of the empty string, used when req.ip is absent (research R8). */
const EMPTY_HASH =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface QueryCall {
  sql: string;
  params: unknown[] | undefined;
}

interface FakeRunner {
  manager: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> };
  log: string[];
  queries: QueryCall[];
  isTransactionActive: boolean;
  connect: () => Promise<void>;
  startTransaction: () => Promise<void>;
  commitTransaction: () => Promise<void>;
  rollbackTransaction: () => Promise<void>;
  release: () => Promise<void>;
}

interface FakeDatabase {
  runner: FakeRunner;
  dataSource: DataSource;
  /** Response of every manager.query from now on: rows or an error to reject with. */
  respond: (result: unknown[] | Error) => void;
}

function createFakeDatabase(): FakeDatabase {
  let nextResult: unknown[] | Error = [{ outcome: 'accepted' }];
  const runner: FakeRunner = {
    manager: {
      query: async (sql: string, params?: unknown[]) => {
        runner.log.push('query');
        runner.queries.push({ sql, params });
        if (nextResult instanceof Error) throw nextResult;
        return nextResult;
      },
    },
    log: [],
    queries: [],
    isTransactionActive: false,
    connect: async () => {
      runner.log.push('connect');
    },
    startTransaction: async () => {
      runner.log.push('startTransaction');
      runner.isTransactionActive = true;
    },
    commitTransaction: async () => {
      runner.log.push('commit');
      runner.isTransactionActive = false;
    },
    rollbackTransaction: async () => {
      runner.log.push('rollback');
      runner.isTransactionActive = false;
    },
    release: async () => {
      runner.log.push('release');
    },
  };
  return {
    runner,
    dataSource: { createQueryRunner: () => runner } as unknown as DataSource,
    respond: (result) => {
      nextResult = result;
    },
  };
}

interface FakeClock {
  clock: ForgotPasswordClock;
  wait: ReturnType<typeof vi.fn>;
}

/** Clock whose wait resolves immediately; it logs the requested delay. */
function createClock(now: () => number, log: string[] = []): FakeClock {
  const wait = vi.fn(async (ms: number) => {
    log.push(`wait:${ms}`);
  });
  return { clock: { now, wait }, wait };
}

interface ClockGate extends FakeClock {
  /** Resolves as soon as the service calls wait, before the delay is released. */
  reached: Promise<void>;
  release: () => void;
}

/** Clock whose wait stays pending until release(): proves the service awaits the floor. */
function createClockGate(now: () => number, log: string[]): ClockGate {
  let release: () => void = () => {};
  let markReached: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const wait = vi.fn(
    (ms: number) =>
      new Promise<void>((resolve) => {
        log.push(`wait:${ms}`);
        release = () => {
          log.push('wait:done');
          resolve();
        };
        markReached();
      }),
  );
  return { clock: { now, wait }, wait, reached, release: () => release() };
}

function createService(
  database: FakeDatabase,
  clock: ForgotPasswordClock,
): ForgotPasswordService {
  return new ForgotPasswordService(database.dataSource, clock);
}

describe('ForgotPasswordService (T020, research R7 y R8)', () => {
  let database: FakeDatabase;

  beforeEach(() => {
    database = createFakeDatabase();
  });

  it('[T020] HELP_RESPONSE_FLOOR_MS es 400 y el token de reloj es un string', () => {
    expect(HELP_RESPONSE_FLOOR_MS).toBe(400);
    expect(FORGOT_PASSWORD_CLOCK).toBe('FORGOT_PASSWORD_CLOCK');
  });

  it('[R7] accepted: una sola llamada a support_request_help con el hash de la IP, commit y release', async () => {
    const { clock, wait } = createClock(() => STARTED_AT);
    const service = createService(database, clock);

    await expect(
      service.request(EMAIL, IP, STARTED_AT),
    ).resolves.toBeUndefined();

    expect(database.runner.queries).toHaveLength(1);
    const [call] = database.runner.queries;
    expect(call.sql).toMatch(/support_request_help/);
    expect(call.params).toEqual([EMAIL, sha256Hex(IP)]);
    expect(call.params?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(call.sql).not.toMatch(/set_config/i);
    expect(database.runner.log).toContain('commit');
    expect(database.runner.log).not.toContain('rollback');
    expect(database.runner.log.indexOf('release')).toBeGreaterThan(
      database.runner.log.indexOf('commit'),
    );
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(HELP_RESPONSE_FLOOR_MS);
  });

  it('[R7][R8] con ip null usa SHA-256 de la cadena vacía (64 hex) y no falla', async () => {
    const { clock } = createClock(() => STARTED_AT);
    const service = createService(database, clock);

    await expect(
      service.request(EMAIL, null, STARTED_AT),
    ).resolves.toBeUndefined();

    expect(database.runner.queries).toHaveLength(1);
    const hash = database.runner.queries[0].params?.[1];
    expect(hash).toBe(sha256Hex(''));
    expect(hash).toBe(EMPTY_HASH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(database.runner.log).toContain('commit');
  });

  it('[US1-AC6] rate_limited: 429 HELP_RATE_LIMITED', async () => {
    database.respond([{ outcome: 'rate_limited' }]);
    const { clock } = createClock(() => STARTED_AT);
    const service = createService(database, clock);

    const error = await service.request(EMAIL, IP, STARTED_AT).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ProblemException);
    const problem = error as ProblemException;
    expect(problem.getStatus()).toBe(429);
    expect(problem.code).toBe('HELP_RATE_LIMITED');
    expect(database.runner.queries).toHaveLength(1);
  });

  it('[R7] un valor inesperado de la función lanza Error (no un 2xx)', async () => {
    database.respond([{ outcome: 'otra_cosa' }]);
    const { clock } = createClock(() => STARTED_AT);
    const service = createService(database, clock);

    const error = await service.request(EMAIL, IP, STARTED_AT).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ProblemException);
    expect(database.runner.queries).toHaveLength(1);
  });

  it('[R7] piso en 202: espera 400 ms desde el inicio antes de resolver', async () => {
    const gate = createClockGate(() => STARTED_AT, database.runner.log);
    const service = createService(database, gate.clock);
    let settled = false;

    const pending = service.request(EMAIL, IP, STARTED_AT).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await gate.reached;
    expect(settled).toBe(false);
    expect(gate.wait).toHaveBeenCalledTimes(1);
    expect(gate.wait).toHaveBeenCalledWith(HELP_RESPONSE_FLOOR_MS);

    gate.release();
    await pending;
    expect(settled).toBe(true);
  });

  it('[R7] piso en 429: espera 400 ms y después lanza HELP_RATE_LIMITED', async () => {
    database.respond([{ outcome: 'rate_limited' }]);
    const gate = createClockGate(() => STARTED_AT, database.runner.log);
    const service = createService(database, gate.clock);
    let settled = false;
    let rejection: unknown;

    const pending = service.request(EMAIL, IP, STARTED_AT).then(
      () => {
        settled = true;
      },
      (reason: unknown) => {
        settled = true;
        rejection = reason;
      },
    );

    await gate.reached;
    expect(settled).toBe(false);
    expect(gate.wait).toHaveBeenCalledWith(HELP_RESPONSE_FLOOR_MS);

    gate.release();
    await pending;
    expect(settled).toBe(true);
    expect(rejection).toBeInstanceOf(ProblemException);
    expect((rejection as ProblemException).getStatus()).toBe(429);
    expect((rejection as ProblemException).code).toBe('HELP_RATE_LIMITED');
  });

  it('[R7] piso si la base lanza: espera 400 ms y luego propaga el error', async () => {
    const boom = new Error('boom');
    database.respond(boom);
    const gate = createClockGate(() => STARTED_AT, database.runner.log);
    const service = createService(database, gate.clock);
    let settled = false;
    let rejection: unknown;

    const pending = service.request(EMAIL, IP, STARTED_AT).then(
      () => {
        settled = true;
      },
      (reason: unknown) => {
        settled = true;
        rejection = reason;
      },
    );

    await gate.reached;
    expect(settled).toBe(false);
    expect(gate.wait).toHaveBeenCalledWith(HELP_RESPONSE_FLOOR_MS);

    gate.release();
    await pending;
    expect(settled).toBe(true);
    expect(rejection).toBe(boom);
    expect(database.runner.log).toContain('rollback');
    expect(database.runner.log.indexOf('wait:400')).toBeGreaterThan(
      database.runner.log.indexOf('query'),
    );
  });

  it('[R7] base lenta: si ya pasaron 450 ms, no espera y resuelve', async () => {
    const { clock, wait } = createClock(() => STARTED_AT + 450);
    const service = createService(database, clock);

    await expect(
      service.request(EMAIL, IP, STARTED_AT),
    ).resolves.toBeUndefined();

    expect(wait).not.toHaveBeenCalled();
    expect(database.runner.log).toContain('commit');
  });

  it.each([
    { elapsed: 399, expectedWait: 1 },
    { elapsed: 400, expectedWait: null },
  ])(
    '[R7] con la base a $elapsed ms espera lo que falta hasta el piso',
    async ({ elapsed, expectedWait }) => {
      const { clock, wait } = createClock(() => STARTED_AT + elapsed);
      const service = createService(database, clock);

      await expect(
        service.request(EMAIL, IP, STARTED_AT),
      ).resolves.toBeUndefined();

      if (expectedWait === null) {
        expect(wait).not.toHaveBeenCalled();
      } else {
        expect(wait).toHaveBeenCalledTimes(1);
        expect(wait).toHaveBeenCalledWith(expectedWait);
      }
    },
  );

  it('[R7][FR-003] nunca registra el correo, ni en 202 ni en 500', async () => {
    const spies = [
      vi.spyOn(Logger.prototype, 'log'),
      vi.spyOn(Logger.prototype, 'warn'),
      vi.spyOn(Logger.prototype, 'error'),
      vi.spyOn(Logger.prototype, 'debug'),
      vi.spyOn(Logger.prototype, 'verbose'),
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'debug'),
    ];
    for (const spy of spies) spy.mockImplementation(() => undefined);

    try {
      const { clock } = createClock(() => STARTED_AT);
      const service = createService(database, clock);

      await expect(
        service.request(EMAIL, IP, STARTED_AT),
      ).resolves.toBeUndefined();

      database.respond(new Error('boom'));
      await expect(service.request(EMAIL, IP, STARTED_AT)).rejects.toThrow(
        'boom',
      );

      const logged = spies.flatMap((spy) => spy.mock.calls as unknown[][]);
      const text = logged
        .map((args) => args.map((arg) => String(arg)).join(' '))
        .join('\n');
      expect(text).not.toContain(EMAIL);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
