// T012 (specs/002-autenticacion): JwtAuthGuard with @Public(), the sid and pwd_change claims,
// AUTH_ALLOW_SESSIONLESS_TOKENS and TOKEN_EXPIRED (research R2, R5, R9, R12; US2-AC12, FR-010).
// The 001 suite (jwt-auth.guard.spec.ts) is not touched: the module is built the same way,
// with only JwtModule and providers: [JwtAuthGuard] (Reflector is provided by Nest).
// The contract code of each error is read through the real ProblemDetailsFilter, so it does not
// matter whether the guard throws UnauthorizedException or ProblemException(401, ...).
import { randomUUID } from 'node:crypto';
import { HttpException, type ArgumentsHost, type ExecutionContext } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { signTestJwt, testTokenClaims, type TestTokenOptions } from '../../test/setup/auth.js';
import { ProblemDetailsFilter } from '../common/problem-details.filter.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { Public } from './public.decorator.js';

const SECRET = 'unit-test-secret-for-jwt-auth-guard-sessions-0123';
const OTHER_SECRET = 'another-secret-that-is-also-long-enough-sessions';

interface FakeRequest {
  headers: Record<string, string>;
  user?: unknown;
}

class ProtectedController {
  list(this: void): void {}
}

class AuthController {
  @Public()
  login(this: void): void {}
}

@Public()
class PublicController {
  register(this: void): void {}
}

type Handler = { controller: abstract new () => unknown; handler: () => void };

const PROTECTED: Handler = { controller: ProtectedController, handler: ProtectedController.prototype.list };
const PUBLIC_HANDLER: Handler = { controller: AuthController, handler: AuthController.prototype.login };
const PUBLIC_CLASS: Handler = {
  controller: PublicController,
  handler: PublicController.prototype.register,
};

function httpContext(request: FakeRequest, target: Handler = PROTECTED): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
    getHandler: () => target.handler,
    getClass: () => target.controller,
    getArgs: () => [request, {}],
    getArgByIndex: (index: number) => [request, {}][index],
  } as unknown as ExecutionContext;
}

function bearer(token: string): FakeRequest {
  return { headers: { authorization: `Bearer ${token}` } };
}

/** Status and contract code that the API would send for this exception. */
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

describe('JwtAuthGuard con sesiones (T012, research R2, R9, R12)', () => {
  let previous: { secret?: string; sessionless?: string; nodeEnv?: string };
  let options: TestTokenOptions;
  let sessionId: string;

  function claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...testTokenClaims(options), sid: sessionId, ...extra };
  }

  function sign(payload: Record<string, unknown>, secret = SECRET): string {
    return signTestJwt(payload, { secret });
  }

  /** Builds the guard after fixing the flag, so it works whether the flag is read at construction or per request. */
  async function guardWith(allowSessionlessTokens: boolean): Promise<JwtAuthGuard> {
    process.env.AUTH_ALLOW_SESSIONLESS_TOKENS = String(allowSessionlessTokens);
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET })],
      providers: [JwtAuthGuard],
    }).compile();
    return moduleRef.get(JwtAuthGuard);
  }

  async function activate(
    guard: JwtAuthGuard,
    request: FakeRequest,
    target: Handler = PROTECTED,
  ): Promise<boolean> {
    return Promise.resolve().then(() => guard.canActivate(httpContext(request, target))) as Promise<boolean>;
  }

  async function rejection(
    guard: JwtAuthGuard,
    request: FakeRequest,
    target: Handler = PROTECTED,
  ): Promise<{ status: number; code: string }> {
    const error: unknown = await activate(guard, request, target).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HttpException);
    expect(request.user).toBeUndefined();
    return problemOf(error);
  }

  beforeAll(() => {
    previous = {
      secret: process.env.JWT_SECRET,
      sessionless: process.env.AUTH_ALLOW_SESSIONLESS_TOKENS,
      nodeEnv: process.env.NODE_ENV,
    };
    process.env.JWT_SECRET = SECRET;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('JWT_SECRET', previous.secret);
    restore('AUTH_ALLOW_SESSIONLESS_TOKENS', previous.sessionless);
    restore('NODE_ENV', previous.nodeEnv);
  });

  beforeEach(() => {
    options = {
      tenantId: randomUUID(),
      userId: randomUUID(),
      role: 'asesor',
      name: 'Ana Pérez',
      secret: SECRET,
    };
    sessionId = randomUUID();
  });

  describe('@Public()', () => {
    it('[FR-010][R2] un handler con @Public() pasa sin token y sin request.user', async () => {
      const guard = await guardWith(false);
      const request: FakeRequest = { headers: {} };

      await expect(activate(guard, request, PUBLIC_HANDLER)).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('[FR-010][R2] una clase con @Public() pasa sin token y sin request.user', async () => {
      const guard = await guardWith(false);
      const request: FakeRequest = { headers: {} };

      await expect(activate(guard, request, PUBLIC_CLASS)).resolves.toBe(true);
      expect(request.user).toBeUndefined();
    });

    it('[FR-010][R2] una ruta pública no rechaza un token vencido o inválido que el cliente siga enviando', async () => {
      const guard = await guardWith(false);
      const expired = sign(claims({ exp: Math.floor(Date.now() / 1000) - 60 }));

      await expect(activate(guard, bearer(expired), PUBLIC_HANDLER)).resolves.toBe(true);
      await expect(activate(guard, bearer('not-a-jwt'), PUBLIC_HANDLER)).resolves.toBe(true);
    });

    it('[US2-AC12][FR-010] sin @Public() y sin token: 401 UNAUTHORIZED', async () => {
      const guard = await guardWith(true);
      await expect(rejection(guard, { headers: {} })).resolves.toEqual({
        status: 401,
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('claims sid y pwd_change', () => {
    it('[R5] expone sid como sessionId y pwd_change como mustChangePassword', async () => {
      const guard = await guardWith(false);
      const request = bearer(sign(claims({ pwd_change: true })));

      await expect(activate(guard, request)).resolves.toBe(true);
      expect(request.user).toEqual({
        userId: options.userId,
        tenantId: options.tenantId,
        role: 'asesor',
        name: 'Ana Pérez',
        sessionId,
        mustChangePassword: true,
      });
    });

    it('[R5] pwd_change es opcional: sin él la cuenta no queda marcada', async () => {
      const guard = await guardWith(false);
      const request = bearer(sign(claims()));

      await expect(activate(guard, request)).resolves.toBe(true);
      expect(request.user).toMatchObject({ userId: options.userId, sessionId });
      expect((request.user as { mustChangePassword?: boolean }).mustChangePassword).not.toBe(true);
    });

    it('[R5] pwd_change: false se expone como mustChangePassword false', async () => {
      const guard = await guardWith(false);
      const request = bearer(sign(claims({ pwd_change: false })));

      await expect(activate(guard, request)).resolves.toBe(true);
      expect(request.user).toMatchObject({ sessionId, mustChangePassword: false });
    });

    it.each([
      ['un texto que no es uuid', 'sesion-1'],
      ['un número', 42],
      ['vacío', ''],
      ['null', null],
    ])('[R5] sid %s → 401 UNAUTHORIZED', async (_label, sid) => {
      const guard = await guardWith(true);
      await expect(rejection(guard, bearer(sign(claims({ sid }))))).resolves.toEqual({
        status: 401,
        code: 'UNAUTHORIZED',
      });
    });

    it.each([
      ['un texto', 'true'],
      ['un número', 1],
    ])('[R5] pwd_change no booleano (%s) → 401 UNAUTHORIZED', async (_label, pwdChange) => {
      const guard = await guardWith(true);
      await expect(
        rejection(guard, bearer(sign(claims({ pwd_change: pwdChange })))),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
    });
  });

  describe('AUTH_ALLOW_SESSIONLESS_TOKENS (research R9)', () => {
    it('[R9][FR-024] un token sin sid es 401 UNAUTHORIZED con allowSessionlessTokens = false', async () => {
      const guard = await guardWith(false);
      const token = sign(testTokenClaims(options));

      await expect(rejection(guard, bearer(token))).resolves.toEqual({
        status: 401,
        code: 'UNAUTHORIZED',
      });
    });

    it('[R9][FR-024] un token sin sid se acepta con allowSessionlessTokens = true, sin sessionId', async () => {
      const guard = await guardWith(true);
      const request = bearer(sign(testTokenClaims(options)));

      await expect(activate(guard, request)).resolves.toBe(true);
      expect(request.user).toEqual({
        userId: options.userId,
        tenantId: options.tenantId,
        role: 'asesor',
        name: 'Ana Pérez',
      });
      expect((request.user as { sessionId?: string }).sessionId).toBeUndefined();
    });

    it('[R9] un token con sid se acepta con allowSessionlessTokens = false', async () => {
      const guard = await guardWith(false);
      const request = bearer(sign(claims()));

      await expect(activate(guard, request)).resolves.toBe(true);
      expect(request.user).toMatchObject({ sessionId, tenantId: options.tenantId });
    });
  });

  describe('TOKEN_EXPIRED frente a UNAUTHORIZED (research R12)', () => {
    const past = (): number => Math.floor(Date.now() / 1000) - 60;

    it('[R12][R5] un token con firma válida y vencido → 401 TOKEN_EXPIRED', async () => {
      const guard = await guardWith(false);
      await expect(rejection(guard, bearer(sign(claims({ exp: past() }))))).resolves.toEqual({
        status: 401,
        code: 'TOKEN_EXPIRED',
      });
    });

    it('[R12] un token de la 001 (sin sid) vencido con firma válida también → 401 TOKEN_EXPIRED', async () => {
      const guard = await guardWith(true);
      const token = sign({ ...testTokenClaims(options), exp: past() });
      await expect(rejection(guard, bearer(token))).resolves.toEqual({
        status: 401,
        code: 'TOKEN_EXPIRED',
      });
    });

    it('[R12] un token vencido con otra firma → 401 UNAUTHORIZED (no TOKEN_EXPIRED)', async () => {
      const guard = await guardWith(false);
      const token = sign(claims({ exp: past() }), OTHER_SECRET);
      await expect(rejection(guard, bearer(token))).resolves.toEqual({
        status: 401,
        code: 'UNAUTHORIZED',
      });
    });

    it('[R12] un token vencido con alg none o HS512 → 401 UNAUTHORIZED', async () => {
      const guard = await guardWith(false);
      const payload = claims({ exp: past() });
      await expect(
        rejection(guard, bearer(signTestJwt(payload, { alg: 'none' }))),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
      await expect(
        rejection(guard, bearer(signTestJwt(payload, { alg: 'HS512', secret: SECRET }))),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
    });

    it('[R12] un token vencido con la firma alterada → 401 UNAUTHORIZED', async () => {
      const guard = await guardWith(false);
      const [header, payload, signature] = sign(claims({ exp: past() })).split('.');
      const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
      await expect(rejection(guard, bearer(`${header}.${payload}.${flipped}`))).resolves.toEqual({
        status: 401,
        code: 'UNAUTHORIZED',
      });
    });

    it('[R12] token mal formado o esquema distinto de Bearer → 401 UNAUTHORIZED', async () => {
      const guard = await guardWith(false);
      await expect(rejection(guard, bearer('not-a-jwt'))).resolves.toEqual({
        status: 401,
        code: 'UNAUTHORIZED',
      });
      await expect(
        rejection(guard, { headers: { authorization: `Basic ${sign(claims())}` } }),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
    });

    it('[R12] un token vigente con claims inválidos → 401 UNAUTHORIZED', async () => {
      const guard = await guardWith(false);
      await expect(
        rejection(guard, bearer(sign(claims({ tenant_id: 'taller-1' })))),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
      await expect(rejection(guard, bearer(sign(claims({ role: 'mecanico' }))))).resolves.toEqual({
        status: 401,
        code: 'UNAUTHORIZED',
      });
    });
  });
});
