// T015 (specs/003-soporte-plataforma): TenantTransactionInterceptor deja de actuar en rutas
// @SupportArea(), igual que ya hace con @Public() (research R3). Entrega en rojo: la exclusión
// llega en T016. Las specs de la 001 y la 002 no se tocan; esta usa el mismo DataSource y
// QueryRunner falsos de la 001 y el Reflector real.
import { randomUUID } from 'node:crypto';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, type Observable } from 'rxjs';
import type { DataSource } from 'typeorm';
import type { SessionValidator } from '../auth/session-validator.js';
import { SupportArea } from '../support/support-area.decorator.js';
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

@SupportArea()
class SupportTicketsController {
  list(this: void): void {}
}

class ClientsController {
  list(this: void): void {}
}

type Target = { controller: abstract new () => unknown; handler: () => void };

const target = (
  controller: Target['controller'],
  handler: () => void,
): Target => ({
  controller,
  handler,
});

const SUPPORT_TICKETS = target(
  SupportTicketsController,
  SupportTicketsController.prototype.list,
);
const CLIENTS = target(ClientsController, ClientsController.prototype.list);

function httpContext(
  request: Record<string, unknown>,
  at: Target,
): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    getHandler: () => at.handler,
    getClass: () => at.controller,
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

describe('TenantTransactionInterceptor en la zona de soporte (T015, research R3)', () => {
  let runner: FakeRunner;
  let createQueryRunner: ReturnType<typeof vi.fn>;
  let validate: ReturnType<typeof vi.fn>;
  let interceptor: TenantTransactionInterceptor;

  beforeEach(() => {
    runner = createFakeRunner();
    createQueryRunner = vi.fn(() => runner);
    const dataSource = { createQueryRunner } as unknown as DataSource;
    validate = vi.fn();
    const sessionValidator = { validate } as unknown as SessionValidator;
    interceptor = new TenantTransactionInterceptor(
      dataSource,
      new Reflector(),
      sessionValidator,
    );
  });

  it('[T015] en una ruta @SupportArea() no abre transacción, no fija taller ni exige request.user', async () => {
    let handled = 0;
    const handler: CallHandler = {
      handle: () => {
        handled += 1;
        return of('ok');
      },
    };

    const result = await run(
      interceptor,
      httpContext({ headers: {}, body: {} }, SUPPORT_TICKETS),
      handler,
    );

    expect(result).toBe('ok');
    expect(handled).toBe(1);
    expect(createQueryRunner).not.toHaveBeenCalled();
    expect(runner.log).toHaveLength(0);
    expect(runner.queries).toHaveLength(0);
    expect(validate).not.toHaveBeenCalled();
  });

  it('[T015] una ruta normal con request.user sigue abriendo transacción y fijando el tenant', async () => {
    const user = {
      userId: randomUUID(),
      tenantId: randomUUID(),
      role: 'asesor',
      name: 'Ana Pérez',
    };

    const result = await run(
      new TenantTransactionInterceptor({
        createQueryRunner,
      } as unknown as DataSource),
      httpContext({ user, headers: {}, body: {} }, CLIENTS),
      handlerOf(() => of('ok')),
    );

    expect(result).toBe('ok');
    expect(runner.log[0]).toBe('connect');
    expect(runner.queries[0].sql).toMatch(SET_CONFIG);
    expect(runner.queries[0].params).toEqual([user.tenantId]);
    expect(runner.log).toContain('commit');
    expect(runner.log).not.toContain('rollback');
    expect(runner.isReleased).toBe(true);
    expect(runner.log.indexOf('release')).toBeGreaterThan(
      runner.log.indexOf('commit'),
    );
  });
});
