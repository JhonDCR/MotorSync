// T009: unit tests of TenantTransactionInterceptor (research R3, principle I).
// The DataSource is a fake that records what the interceptor does with its QueryRunner;
// the real behaviour against PostgreSQL is covered by test/db/smoke.e2e-spec.ts and the e2e suites.
import { randomUUID } from 'node:crypto';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { defer, lastValueFrom, of, throwError, type Observable } from 'rxjs';
import type { DataSource } from 'typeorm';
import { getManager } from './tenant-context.js';
import { TenantTransactionInterceptor } from './tenant-transaction.interceptor.js';

interface FakeRunner {
  manager: { marker: string };
  log: string[];
  queries: { sql: string; params: unknown[] | undefined }[];
  isReleased: boolean;
  isTransactionActive: boolean;
  connect: () => Promise<void>;
  startTransaction: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  commitTransaction: () => Promise<void>;
  rollbackTransaction: () => Promise<void>;
  release: () => Promise<void>;
}

function createFakeRunner(): FakeRunner {
  const runner: FakeRunner = {
    manager: { marker: `manager-${randomUUID()}` },
    log: [],
    queries: [],
    isReleased: false,
    isTransactionActive: false,
    connect: async () => {
      runner.log.push('connect');
    },
    startTransaction: async () => {
      runner.log.push('startTransaction');
      runner.isTransactionActive = true;
    },
    query: async (sql: string, params?: unknown[]) => {
      runner.log.push('query');
      runner.queries.push({ sql, params });
      return [];
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
      runner.isReleased = true;
    },
  };
  return runner;
}

function createFakeDataSource(runner: FakeRunner): DataSource {
  return { createQueryRunner: () => runner } as unknown as DataSource;
}

interface AuthUserLike {
  userId: string;
  tenantId: string;
  role: 'asesor' | 'admin';
  name: string;
}

function httpContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    getArgs: () => [request, {}],
    getArgByIndex: (index: number) => [request, {}][index],
  } as unknown as ExecutionContext;
}

function handlerOf(fn: () => Observable<unknown>): CallHandler {
  return { handle: fn };
}

async function run(
  interceptor: TenantTransactionInterceptor,
  context: ExecutionContext,
  handler: CallHandler,
): Promise<unknown> {
  const result = await interceptor.intercept(context, handler);
  return lastValueFrom(result);
}

const SET_CONFIG = /set_config\(\s*'app\.tenant_id'\s*,\s*\$1\s*,\s*true\s*\)/i;

describe('TenantTransactionInterceptor (T009, principio I)', () => {
  let runner: FakeRunner;
  let interceptor: TenantTransactionInterceptor;
  let user: AuthUserLike;

  beforeEach(() => {
    runner = createFakeRunner();
    interceptor = new TenantTransactionInterceptor(createFakeDataSource(runner));
    user = { userId: randomUUID(), tenantId: randomUUID(), role: 'asesor', name: 'Ana Pérez' };
  });

  it('[T009][Principio I] abre la transacción y fija app.tenant_id del usuario autenticado como primera sentencia', async () => {
    const request = { user, body: {}, query: {}, headers: {} };

    await run(interceptor, httpContext(request), handlerOf(() => of('ok')));

    const startIndex = runner.log.indexOf('startTransaction');
    const firstQueryIndex = runner.log.indexOf('query');
    expect(runner.log[0]).toBe('connect');
    expect(startIndex).toBeGreaterThan(-1);
    expect(firstQueryIndex).toBeGreaterThan(startIndex);
    expect(runner.queries[0].sql).toMatch(SET_CONFIG);
    expect(runner.queries[0].params).toEqual([user.tenantId]);
  });

  it('[T009] publica el manager del QueryRunner en el contexto del request (getManager)', async () => {
    const request = { user, body: {}, query: {}, headers: {} };
    let seenManager: unknown;
    let seenLogWhenHandlerRuns: string[] = [];

    const result = await run(
      interceptor,
      httpContext(request),
      handlerOf(() =>
        defer(() => {
          seenManager = getManager();
          seenLogWhenHandlerRuns = [...runner.log];
          return of({ ok: true });
        }),
      ),
    );

    expect(result).toEqual({ ok: true });
    expect(seenManager).toBe(runner.manager);
    // When the handler runs, the tenant is already pinned and nothing has been committed.
    expect(seenLogWhenHandlerRuns).toContain('query');
    expect(seenLogWhenHandlerRuns).not.toContain('commit');
  });

  it('[T009] hace COMMIT cuando el handler termina bien y libera el QueryRunner', async () => {
    const request = { user, body: {}, query: {}, headers: {} };

    await run(interceptor, httpContext(request), handlerOf(() => of('ok')));

    expect(runner.log).toContain('commit');
    expect(runner.log).not.toContain('rollback');
    expect(runner.isReleased).toBe(true);
    expect(runner.log.indexOf('release')).toBeGreaterThan(runner.log.indexOf('commit'));
  });

  it('[T009] hace ROLLBACK y libera el QueryRunner cuando el handler lanza; el error se propaga', async () => {
    const request = { user, body: {}, query: {}, headers: {} };
    const failure = new Error('handler failed');

    await expect(
      run(interceptor, httpContext(request), handlerOf(() => throwError(() => failure))),
    ).rejects.toBe(failure);

    expect(runner.log).toContain('rollback');
    expect(runner.log).not.toContain('commit');
    expect(runner.isReleased).toBe(true);
    expect(runner.log.indexOf('release')).toBeGreaterThan(runner.log.indexOf('rollback'));
  });

  it('[T009] hace ROLLBACK y libera también si el handler lanza de forma síncrona', async () => {
    const request = { user, body: {}, query: {}, headers: {} };
    const failure = new Error('sync failure');

    await expect(
      run(
        interceptor,
        httpContext(request),
        handlerOf(() =>
          defer(() => {
            throw failure;
          }),
        ),
      ),
    ).rejects.toBe(failure);

    expect(runner.log).toContain('rollback');
    expect(runner.log).not.toContain('commit');
    expect(runner.isReleased).toBe(true);
  });

  it('[T009][Principio I] nunca usa el tenant de body, query ni cabeceras', async () => {
    const foreignTenant = randomUUID();
    const request = {
      user,
      body: { tenantId: foreignTenant, tenant_id: foreignTenant },
      query: { tenantId: foreignTenant, tenant_id: foreignTenant },
      params: { tenantId: foreignTenant },
      headers: { 'x-tenant-id': foreignTenant, 'tenant-id': foreignTenant },
    };

    await run(interceptor, httpContext(request), handlerOf(() => of('ok')));

    const setConfigCalls = runner.queries.filter((q) => SET_CONFIG.test(q.sql));
    expect(setConfigCalls).toHaveLength(1);
    expect(setConfigCalls[0].params).toEqual([user.tenantId]);
    const allParams = runner.queries.flatMap((q) => q.params ?? []);
    expect(allParams).not.toContain(foreignTenant);
  });

  it('[T009][Principio I] dos requests concurrentes ven cada uno su propio manager', async () => {
    const runnerA = createFakeRunner();
    const runnerB = createFakeRunner();
    const runners = [runnerA, runnerB];
    const dataSource = {
      createQueryRunner: () => runners.shift(),
    } as unknown as DataSource;
    const shared = new TenantTransactionInterceptor(dataSource);
    const userB: AuthUserLike = { ...user, tenantId: randomUUID(), userId: randomUUID() };

    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const pending = run(
      shared,
      httpContext({ user, body: {}, query: {}, headers: {} }),
      handlerOf(() =>
        defer(async () => {
          await gateA;
          return getManager();
        }),
      ),
    );
    const managerB = await run(
      shared,
      httpContext({ user: userB, body: {}, query: {}, headers: {} }),
      handlerOf(() => defer(async () => getManager())),
    );
    releaseA();
    const managerA = await pending;

    expect(managerA).toBe(runnerA.manager);
    expect(managerB).toBe(runnerB.manager);
    expect(runnerA.queries[0].params).toEqual([user.tenantId]);
    expect(runnerB.queries[0].params).toEqual([userB.tenantId]);
  });

  it('[T010] getManager() lanza fuera del contexto de un request', () => {
    expect(() => getManager()).toThrow();
  });
});
