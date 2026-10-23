// T014 (specs/002-autenticacion): TenantTransactionInterceptor with @Public(), SessionValidator,
// @Roles() and @AllowPendingPasswordChange() (research R2, R6, R7, R8, R9).
// The 001 suite (tenant-transaction.interceptor.spec.ts) is not touched and keeps building the
// interceptor as `new TenantTransactionInterceptor(dataSource)`. Here it receives, in this order,
// (dataSource, reflector, sessionValidator), the last two being @Optional() in Nest.
// The SessionValidator is a fake: its own SQL is covered by session-validator.spec.ts and, against
// PostgreSQL, by the e2e suites.
import { randomUUID } from 'node:crypto';
import { HttpException, type ArgumentsHost, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defer, lastValueFrom, of, type Observable } from 'rxjs';
import type { DataSource } from 'typeorm';
import { AllowPendingPasswordChange } from '../auth/allow-pending-password-change.decorator.js';
import type { AuthUser } from '../auth/auth-user.js';
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import type { SessionState, SessionValidator } from '../auth/session-validator.js';
import { ProblemDetailsFilter, ProblemException } from '../common/problem-details.filter.js';
import { getTenantContext } from './tenant-context.js';
import { TenantTransactionInterceptor } from './tenant-transaction.interceptor.js';

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
      runner.log.push(/set_config/i.test(sql) ? 'set_config' : 'query');
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

class AuthController {
  @Public()
  login(this: void): void {}
}

@Public()
class PublicController {
  register(this: void): void {}
}

class ClientsController {
  list(this: void): void {}
}

class MeController {
  @AllowPendingPasswordChange()
  me(this: void): void {}
}

class UsersController {
  @Roles('admin')
  list(this: void): void {}
}

@Roles('admin')
class AdminController {
  history(this: void): void {}
}

type Target = { controller: abstract new () => unknown; handler: () => void };

const target = (controller: Target['controller'], handler: () => void): Target => ({
  controller,
  handler,
});

const LOGIN = target(AuthController, AuthController.prototype.login);
const REGISTER = target(PublicController, PublicController.prototype.register);
const CLIENTS = target(ClientsController, ClientsController.prototype.list);
const ME = target(MeController, MeController.prototype.me);
const USERS = target(UsersController, UsersController.prototype.list);
const ADMIN_CLASS = target(AdminController, AdminController.prototype.history);

function httpContext(request: Record<string, unknown>, at: Target): ExecutionContext {
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
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(exception, host);
  const body = JSON.parse(sent) as { status: number; code: string };
  return { status: body.status, code: body.code };
}

const SET_CONFIG = /set_config\(\s*'app\.tenant_id'\s*,\s*\$1\s*,\s*true\s*\)/i;

describe('TenantTransactionInterceptor con sesiones (T014, research R2, R6, R7, R8)', () => {
  let runner: FakeRunner;
  let createQueryRunner: ReturnType<typeof vi.fn>;
  let validate: ReturnType<typeof vi.fn>;
  let interceptor: TenantTransactionInterceptor;
  let sessionUser: AuthUser;
  let fromDatabase: SessionState;
  let handled: number;

  function handlerOf(fn: () => Observable<unknown> = () => of('ok')): CallHandler {
    return {
      handle: () => {
        handled += 1;
        runner.log.push('handler');
        return fn();
      },
    };
  }

  async function run(request: Record<string, unknown>, at: Target, handler = handlerOf()): Promise<unknown> {
    const result = await interceptor.intercept(httpContext(request, at), handler);
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
    sessionUser = {
      userId: randomUUID(),
      tenantId: randomUUID(),
      role: 'admin',
      name: 'Nombre del token',
      sessionId: randomUUID(),
      mustChangePassword: false,
    };
    fromDatabase = {
      role: 'admin',
      name: 'Nombre de la base',
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
    };
    validate = vi.fn(async () => {
      runner.log.push('validate');
      return { ...fromDatabase };
    });
    const sessionValidator = { validate } as unknown as SessionValidator;
    interceptor = new TenantTransactionInterceptor(dataSource, new Reflector(), sessionValidator);
  });

  describe('@Public()', () => {
    it('[R2][FR-010] una ruta @Public() no abre transacción ni ejecuta set_config, y llega al handler', async () => {
      const result = await run({ headers: {}, body: {} }, LOGIN, handlerOf(() => of({ ok: 1 })));

      expect(result).toEqual({ ok: 1 });
      expect(handled).toBe(1);
      expect(createQueryRunner).not.toHaveBeenCalled();
      expect(runner.queries).toHaveLength(0);
      expect(validate).not.toHaveBeenCalled();
    });

    it('[R2][FR-010] una clase @Public() tampoco abre transacción, aunque haya request.user', async () => {
      await run({ headers: {}, user: sessionUser }, REGISTER);

      expect(handled).toBe(1);
      expect(createQueryRunner).not.toHaveBeenCalled();
      expect(validate).not.toHaveBeenCalled();
    });

    it('[R2][US2-AC12] una ruta no pública sin request.user sigue siendo 401', async () => {
      await expect(failure({ headers: {} }, CLIENTS)).resolves.toMatchObject({ status: 401 });
      expect(handled).toBe(0);
    });
  });

  describe('SessionValidator (research R6)', () => {
    it('[R6][FR-013] se llama después de set_config y antes del handler, con el manager de la transacción', async () => {
      await run({ headers: {}, user: sessionUser }, CLIENTS);

      expect(validate).toHaveBeenCalledTimes(1);
      const [manager, user] = validate.mock.calls[0] as [unknown, AuthUser];
      expect(manager).toBe(runner.manager);
      expect(user).toMatchObject({
        userId: sessionUser.userId,
        tenantId: sessionUser.tenantId,
        sessionId: sessionUser.sessionId,
      });

      const setConfigAt = runner.log.indexOf('set_config');
      const validateAt = runner.log.indexOf('validate');
      const handlerAt = runner.log.indexOf('handler');
      expect(setConfigAt).toBeGreaterThan(runner.log.indexOf('startTransaction'));
      expect(validateAt).toBeGreaterThan(setConfigAt);
      expect(handlerAt).toBeGreaterThan(validateAt);
      expect(runner.queries[0].sql).toMatch(SET_CONFIG);
      expect(runner.queries[0].params).toEqual([sessionUser.tenantId]);
      expect(runner.log).toContain('commit');
    });

    it('[FR-014][US4-AC5] role y name del contexto (y de request.user) se reemplazan por los de la base', async () => {
      sessionUser.role = 'admin';
      fromDatabase = { ...fromDatabase, role: 'asesor', name: 'Luis Ortega' };
      const request: Record<string, unknown> = { headers: {}, user: sessionUser };
      let seen: AuthUser | undefined;

      await run(
        request,
        CLIENTS,
        handlerOf(() =>
          defer(() => {
            seen = getTenantContext().user;
            return of('ok');
          }),
        ),
      );

      expect(seen).toMatchObject({
        userId: sessionUser.userId,
        tenantId: sessionUser.tenantId,
        role: 'asesor',
        name: 'Luis Ortega',
      });
      expect(request.user).toMatchObject({ role: 'asesor', name: 'Luis Ortega' });
    });

    it.each(['SESSION_EXPIRED', 'SESSION_REVOKED'])(
      '[R6][FR-012][FR-013] si el validador responde 401 %s: el error se propaga, ROLLBACK y sin handler',
      async (code) => {
        validate.mockImplementation(async () => {
          runner.log.push('validate');
          throw new ProblemException(401, code);
        });

        await expect(failure({ headers: {}, user: sessionUser }, CLIENTS)).resolves.toEqual({
          status: 401,
          code,
        });
        expect(handled).toBe(0);
        expect(runner.log).toContain('rollback');
        expect(runner.log).not.toContain('commit');
        expect(runner.log[runner.log.length - 1]).toBe('release');
      },
    );

    it('[R9][FR-024] un usuario sin sessionId (token de la 001) no llama al validador y conserva el rol del token', async () => {
      const { sessionId: _sid, mustChangePassword: _pwd, ...legacy } = sessionUser;
      const user: AuthUser = { ...legacy, role: 'asesor', name: 'Ana Pérez' };
      let seen: AuthUser | undefined;

      await run(
        { headers: {}, user },
        CLIENTS,
        handlerOf(() =>
          defer(() => {
            seen = getTenantContext().user;
            return of('ok');
          }),
        ),
      );

      expect(validate).not.toHaveBeenCalled();
      expect(handled).toBe(1);
      expect(seen).toMatchObject({ role: 'asesor', name: 'Ana Pérez' });
      expect(runner.queries[0].sql).toMatch(SET_CONFIG);
      expect(runner.log).toContain('commit');
    });
  });

  describe('contraseña temporal (research R7, FR-026)', () => {
    it('[FR-026][US5-AC1] con must_change_password = true en la base y un handler sin @AllowPendingPasswordChange(): 403 PASSWORD_CHANGE_REQUIRED', async () => {
      fromDatabase = {
        ...fromDatabase,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 3_600_000),
      };

      await expect(failure({ headers: {}, user: sessionUser }, CLIENTS)).resolves.toEqual({
        status: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
      expect(handled).toBe(0);
      expect(runner.log).not.toContain('commit');
      expect(runner.log[runner.log.length - 1]).toBe('release');
    });

    it('[FR-026] la base manda: aunque el token diga pwd_change = false, la cuenta temporal recibe 403', async () => {
      sessionUser.mustChangePassword = false;
      fromDatabase = {
        ...fromDatabase,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 3_600_000),
      };

      await expect(failure({ headers: {}, user: sessionUser }, USERS)).resolves.toEqual({
        status: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    });

    it('[FR-026][R7] con @AllowPendingPasswordChange() el handler se ejecuta', async () => {
      fromDatabase = {
        ...fromDatabase,
        mustChangePassword: true,
        temporaryPasswordExpiresAt: new Date(Date.now() + 3_600_000),
      };

      await expect(run({ headers: {}, user: sessionUser }, ME)).resolves.toBe('ok');
      expect(handled).toBe(1);
      expect(runner.log).toContain('commit');
    });

    it('[FR-026] la base manda: aunque el token diga pwd_change = true, una cuenta ya cambiada pasa', async () => {
      sessionUser.mustChangePassword = true;

      await expect(run({ headers: {}, user: sessionUser }, CLIENTS)).resolves.toBe('ok');
      expect(handled).toBe(1);
    });
  });

  describe("@Roles('admin') con el rol vigente (research R8)", () => {
    it('[US4-AC16][FR-014] rol vigente asesor en la base: 403 FORBIDDEN aunque el token diga admin', async () => {
      sessionUser.role = 'admin';
      fromDatabase = { ...fromDatabase, role: 'asesor' };

      await expect(failure({ headers: {}, user: sessionUser }, USERS)).resolves.toEqual({
        status: 403,
        code: 'FORBIDDEN',
      });
      expect(handled).toBe(0);
      expect(runner.log).not.toContain('commit');
      expect(runner.log[runner.log.length - 1]).toBe('release');
    });

    it('[US4-AC16] también con @Roles en la clase', async () => {
      fromDatabase = { ...fromDatabase, role: 'asesor' };

      await expect(failure({ headers: {}, user: sessionUser }, ADMIN_CLASS)).resolves.toEqual({
        status: 403,
        code: 'FORBIDDEN',
      });
    });

    it('[US4-AC5][FR-014] rol vigente admin en la base: pasa aunque el token diga asesor', async () => {
      sessionUser.role = 'asesor';
      fromDatabase = { ...fromDatabase, role: 'admin' };

      await expect(run({ headers: {}, user: sessionUser }, USERS)).resolves.toBe('ok');
      expect(handled).toBe(1);
    });

    it('[R8][R9] sin sessionId (token de la 001) @Roles se aplica con el rol del token', async () => {
      const { sessionId: _sid, mustChangePassword: _pwd, ...legacy } = sessionUser;

      await expect(
        failure({ headers: {}, user: { ...legacy, role: 'asesor' } }, USERS),
      ).resolves.toEqual({ status: 403, code: 'FORBIDDEN' });
      expect(validate).not.toHaveBeenCalled();

      await expect(run({ headers: {}, user: { ...legacy, role: 'admin' } }, USERS)).resolves.toBe(
        'ok',
      );
    });

    it('[R8] una ruta sin @Roles admite a asesor', async () => {
      fromDatabase = { ...fromDatabase, role: 'asesor' };

      await expect(run({ headers: {}, user: sessionUser }, CLIENTS)).resolves.toBe('ok');
    });
  });

  // Leader decision: fail closed. A token with sid is never accepted without validating its
  // session; the chosen code is 401 SESSION_REVOKED. Only tokens without sid (dev tokens accepted
  // through AUTH_ALLOW_SESSIONLESS_TOKENS) may pass without a SessionValidator, as in the 001.
  describe('sin SessionValidator inyectado (falla cerrado)', () => {
    const dataSourceOf = (): DataSource =>
      ({ createQueryRunner: () => runner }) as unknown as DataSource;

    it.each([
      ['con Reflector', () => new TenantTransactionInterceptor(dataSourceOf(), new Reflector())],
      ['con el constructor de la 001', () => new TenantTransactionInterceptor(dataSourceOf())],
    ])(
      '[FR-013][Principio I] un token con sid y sin validador (%s) → 401 SESSION_REVOKED, ROLLBACK y release, sin handler',
      async (_label, build) => {
        interceptor = build();

        await expect(failure({ headers: {}, user: sessionUser }, CLIENTS)).resolves.toEqual({
          status: 401,
          code: 'SESSION_REVOKED',
        });
        expect(handled).toBe(0);
        expect(validate).not.toHaveBeenCalled();
        expect(runner.log).toContain('rollback');
        expect(runner.log).not.toContain('commit');
        expect(runner.log[runner.log.length - 1]).toBe('release');
      },
    );

    it('[FR-013][Principio I][R9] un token sin sid y sin validador pasa como en la 001', async () => {
      interceptor = new TenantTransactionInterceptor(dataSourceOf(), new Reflector());
      const { sessionId: _sid, mustChangePassword: _pwd, ...legacy } = sessionUser;

      await expect(run({ headers: {}, user: legacy }, CLIENTS)).resolves.toBe('ok');
      expect(handled).toBe(1);
      expect(runner.queries[0].sql).toMatch(SET_CONFIG);
      expect(runner.log).toContain('commit');
    });
  });
});
