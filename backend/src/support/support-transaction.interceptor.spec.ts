// T015 (specs/003-soporte-plataforma): SupportTransactionInterceptor, la transacción del panel
// (research R3, R4 y R9). Entrega en rojo: el interceptor, el contexto y el validador llegan en T016.
// Solo actúa en rutas @SupportArea() no públicas; abre la transacción sin taller (nunca ejecuta
// set_config('app.tenant_id', ...)), valida la sesión antes del handler, refresca el agente con la
// base, aplica @AllowPendingPasswordChange() y publica supportStorage con { manager, agent, ip }.
// El DataSource y el validador son falsos, como en las specs de la 001/002: la SQL del validador se
// cubre en support-session-validator.spec.ts y, contra PostgreSQL, en las e2e de T025.
import { randomUUID } from 'node:crypto';
import {
  HttpException,
  type ArgumentsHost,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defer, lastValueFrom, of, throwError, type Observable } from 'rxjs';
import type { DataSource } from 'typeorm';
import { AllowPendingPasswordChange } from '../auth/allow-pending-password-change.decorator.js';
import { Public } from '../auth/public.decorator.js';
import {
  ProblemDetailsFilter,
  ProblemException,
} from '../common/problem-details.filter.js';
import type { SupportAgent } from './support-agent.js';
import { SupportArea } from './support-area.decorator.js';
import { getSupportContext } from './support-context.js';
import type {
  SupportSessionState,
  SupportSessionValidator,
} from './support-session-validator.js';
import { SupportTransactionInterceptor } from './support-transaction.interceptor.js';

interface FakeRunner {
  manager: { marker: string };
  log: string[];
  queries: { sql: string; params: unknown[] | undefined }[];
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
    },
  };
  return runner;
}

// --- Controllers whose metadata the interceptor reads with Reflector -----------------------------

class WorkshopController {
  list(this: void): void {}
}

class SupportTicketsController {
  @SupportArea()
  list(this: void): void {}
}

@SupportArea()
class SupportAuthController {
  @Public()
  login(this: void): void {}
}

@SupportArea()
class SupportMeController {
  @AllowPendingPasswordChange()
  me(this: void): void {}
}

type Target = { controller: abstract new () => unknown; handler: () => void };

const target = (
  controller: Target['controller'],
  handler: () => void,
): Target => ({
  controller,
  handler,
});

const WORKSHOP = target(WorkshopController, WorkshopController.prototype.list);
const TICKETS = target(
  SupportTicketsController,
  SupportTicketsController.prototype.list,
);
const SUPPORT_LOGIN = target(
  SupportAuthController,
  SupportAuthController.prototype.login,
);
const SUPPORT_ME = target(
  SupportMeController,
  SupportMeController.prototype.me,
);

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

function problemOf(exception: unknown): { status: number; code: string } {
  let sent = '';
  const response = {
    status: () => response,
    setHeader: () => response,
    send: (body: string) => {
      sent = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(exception, host);
  const body = JSON.parse(sent) as { status: number; code: string };
  return { status: body.status, code: body.code };
}

describe('SupportTransactionInterceptor (T015, research R3, R4, R9)', () => {
  let runner: FakeRunner;
  let createQueryRunner: ReturnType<typeof vi.fn>;
  let validate: ReturnType<typeof vi.fn>;
  let interceptor: SupportTransactionInterceptor;
  let agent: SupportAgent;
  let fromDatabase: SupportSessionState;
  let handled: number;

  function handlerOf(
    fn: () => Observable<unknown> = () => of('ok'),
  ): CallHandler {
    return {
      handle: () => {
        handled += 1;
        runner.log.push('handler');
        return fn();
      },
    };
  }

  async function run(
    request: Record<string, unknown>,
    at: Target,
    handler = handlerOf(),
  ): Promise<unknown> {
    const result = await interceptor.intercept(
      httpContext(request, at),
      handler,
    );
    return lastValueFrom(result, { defaultValue: undefined });
  }

  async function failure(
    request: Record<string, unknown>,
    at: Target,
  ): Promise<{ status: number; code: string }> {
    const error: unknown = await run(request, at).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HttpException);
    return problemOf(error);
  }

  beforeEach(() => {
    runner = createFakeRunner();
    createQueryRunner = vi.fn(() => runner);
    const dataSource = { createQueryRunner } as unknown as DataSource;
    handled = 0;
    agent = {
      id: randomUUID(),
      sessionId: randomUUID(),
      name: 'Nombre del token',
      mustChangePassword: false,
    };
    fromDatabase = {
      name: 'Pedro Soporte',
      email: 'pedro@motorsync.ec',
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
    };
    validate = vi.fn(async () => {
      runner.log.push('validate');
      return { ...fromDatabase };
    });
    const sessionValidator = { validate } as unknown as SupportSessionValidator;
    interceptor = new SupportTransactionInterceptor(
      dataSource,
      new Reflector(),
      sessionValidator,
    );
  });

  describe('rutas fuera de la zona de soporte', () => {
    it('[T015] una ruta sin @SupportArea() llega al handler y no crea QueryRunner', async () => {
      const result = await run(
        { supportAgent: agent, headers: {}, body: {} },
        WORKSHOP,
        handlerOf(() => of({ ok: 1 })),
      );

      expect(result).toEqual({ ok: 1 });
      expect(handled).toBe(1);
      expect(createQueryRunner).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      expect(runner.queries).toHaveLength(0);
    });

    it('[T015] una ruta @SupportArea() + @Public() llega al handler y no crea QueryRunner', async () => {
      const result = await run(
        { supportAgent: agent, headers: {}, body: {} },
        SUPPORT_LOGIN,
        handlerOf(() => of({ ok: 2 })),
      );

      expect(result).toEqual({ ok: 2 });
      expect(handled).toBe(1);
      expect(createQueryRunner).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
      expect(runner.queries).toHaveLength(0);
    });
  });

  describe('ruta de soporte con sesión', () => {
    it('[T015] conecta, abre transacción, valida, ejecuta el handler, hace commit y release en ese orden, sin set_config', async () => {
      const request = {
        supportAgent: agent,
        ip: '203.0.113.7',
        headers: {},
        body: {},
      };

      const result = await run(
        request,
        TICKETS,
        handlerOf(() => of({ ok: true })),
      );

      expect(result).toEqual({ ok: true });
      expect(handled).toBe(1);
      expect(runner.log).toEqual([
        'connect',
        'startTransaction',
        'validate',
        'handler',
        'commit',
        'release',
      ]);
      expect(validate).toHaveBeenCalledTimes(1);
      const [manager, validated] = validate.mock.calls[0] as [
        unknown,
        SupportAgent,
      ];
      expect(manager).toBe(runner.manager);
      expect(validated).toEqual(agent);
      for (const { sql } of runner.queries) {
        expect(sql).not.toMatch(/set_config/i);
        expect(sql).not.toMatch(/app\.tenant_id/i);
      }
      expect(runner.queries).toHaveLength(0);
    });

    it('[T015] publica supportStorage con el manager, el agente refrescado y la ip; fuera lanza', async () => {
      fromDatabase = { ...fromDatabase, name: 'Pedro Soporte desde la base' };
      const request = {
        supportAgent: agent,
        ip: '203.0.113.7',
        headers: {},
        body: {},
      };
      let seenManager: unknown;
      let seenAgent: SupportAgent | undefined;
      let seenIp: string | null | undefined;

      const result = await run(
        request,
        TICKETS,
        handlerOf(() =>
          defer(() => {
            const context = getSupportContext();
            seenManager = context.manager;
            seenAgent = context.agent;
            seenIp = context.ip;
            return of('ok');
          }),
        ),
      );

      expect(result).toBe('ok');
      expect(seenManager).toBe(runner.manager);
      expect(seenAgent).toEqual({
        id: agent.id,
        sessionId: agent.sessionId,
        name: 'Pedro Soporte desde la base',
        mustChangePassword: false,
      });
      expect(seenIp).toBe('203.0.113.7');
      expect(request.supportAgent).toEqual(seenAgent);
      expect(() => getSupportContext()).toThrow();
    });
  });

  describe('contraseña temporal pendiente (FR-009)', () => {
    it('[FR-009] mustChangePassword = true sin @AllowPendingPasswordChange() → 403 PASSWORD_CHANGE_REQUIRED, sin handler y con rollback', async () => {
      fromDatabase = {
        ...fromDatabase,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 3_600_000),
      };
      const request = {
        supportAgent: agent,
        ip: '203.0.113.7',
        headers: {},
        body: {},
      };

      await expect(failure(request, TICKETS)).resolves.toEqual({
        status: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
      expect(handled).toBe(0);
      expect(runner.log).toContain('rollback');
      expect(runner.log).not.toContain('commit');
      expect(runner.log[runner.log.length - 1]).toBe('release');
    });

    it('[FR-009] con @AllowPendingPasswordChange() el handler se ejecuta y hace commit', async () => {
      fromDatabase = {
        ...fromDatabase,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 3_600_000),
      };
      const request = {
        supportAgent: agent,
        ip: '203.0.113.7',
        headers: {},
        body: {},
      };

      await expect(run(request, SUPPORT_ME)).resolves.toBe('ok');
      expect(handled).toBe(1);
      expect(runner.log).toContain('commit');
      expect(request.supportAgent).toMatchObject({ mustChangePassword: true });
    });
  });

  describe('fallos: rollback y release', () => {
    it('[T015] si el handler lanza, hace rollback y release, y propaga el error', async () => {
      const failureError = new Error('handler failed');
      const request = {
        supportAgent: agent,
        ip: '203.0.113.7',
        headers: {},
        body: {},
      };

      await expect(
        run(
          request,
          TICKETS,
          handlerOf(() => throwError(() => failureError)),
        ),
      ).rejects.toBe(failureError);

      expect(runner.log).toContain('rollback');
      expect(runner.log).not.toContain('commit');
      expect(runner.log[runner.log.length - 1]).toBe('release');
    });

    it('[T015] si el validador lanza, hace rollback y release, sin handler y con el error propagado', async () => {
      const validatorError = new ProblemException(401, 'SESSION_REVOKED');
      validate.mockImplementation(async () => {
        runner.log.push('validate');
        throw validatorError;
      });
      const request = {
        supportAgent: agent,
        ip: '203.0.113.7',
        headers: {},
        body: {},
      };

      await expect(run(request, TICKETS)).rejects.toBe(validatorError);

      expect(handled).toBe(0);
      expect(runner.log).toContain('rollback');
      expect(runner.log).not.toContain('commit');
      expect(runner.log[runner.log.length - 1]).toBe('release');
    });

    it('[T015] sin request.supportAgent → 401 y no crea QueryRunner', async () => {
      const request = { ip: '203.0.113.7', headers: {}, body: {} };

      await expect(failure(request, TICKETS)).resolves.toMatchObject({
        status: 401,
      });
      expect(handled).toBe(0);
      expect(createQueryRunner).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
    });
  });
});
