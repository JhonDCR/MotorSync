// T013 (specs/003-soporte-plataforma): el guard separa la zona de taller y la de soporte en ambos
// sentidos (research R3, US2-AC5, US2-AC6). Entrega en rojo: @SupportArea(), el tipo SupportAgent y
// la verificación por zona llegan en T014. Las specs del guard de la 001 y la 002 no se tocan y
// deben seguir en verde: el módulo de prueba se construye igual que en
// jwt-auth.guard.sessions.spec.ts (solo JwtModule y providers: [JwtAuthGuard]).
// El `code` de cada error se lee a través del ProblemDetailsFilter real, así que da igual si el
// guard lanza UnauthorizedException, ForbiddenException o ProblemException.
import { randomUUID } from 'node:crypto';
import {
  HttpException,
  type ArgumentsHost,
  type ExecutionContext,
} from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  signTestJwt,
  testTokenClaims,
  type TestTokenOptions,
} from '../../test/setup/auth.js';
import { ProblemDetailsFilter } from '../common/problem-details.filter.js';
import type { SupportAgent } from '../support/support-agent.js';
import { SupportArea } from '../support/support-area.decorator.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { Public } from './public.decorator.js';

const SECRET = 'unit-test-secret-for-jwt-auth-guard-support-0123';
const SUPPORT_SECRET = 'unit-test-support-secret-for-jwt-auth-guard-0456';
const OTHER_SECRET = 'another-secret-that-is-also-long-enough-support';
const SUPPORT_AUDIENCE = 'motorsync-support';

interface FakeRequest {
  headers: Record<string, string>;
  user?: unknown;
  supportAgent?: SupportAgent;
}

class WorkshopController {
  list(this: void): void {}
}

@SupportArea()
class SupportTicketsController {
  list(this: void): void {}
}

@SupportArea()
class SupportAuthController {
  @Public()
  login(this: void): void {}
}

type Handler = { controller: abstract new () => unknown; handler: () => void };

const WORKSHOP: Handler = {
  controller: WorkshopController,
  handler: WorkshopController.prototype.list,
};
const SUPPORT_AREA: Handler = {
  controller: SupportTicketsController,
  handler: SupportTicketsController.prototype.list,
};
const SUPPORT_PUBLIC: Handler = {
  controller: SupportAuthController,
  handler: SupportAuthController.prototype.login,
};

function httpContext(request: FakeRequest, target: Handler): ExecutionContext {
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
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(exception, host);
  const body = JSON.parse(sent) as { status: number; code: string };
  return { status: body.status, code: body.code };
}

describe('JwtAuthGuard por zona (T013, research R3, US2-AC5, US2-AC6)', () => {
  let previous: {
    secret?: string;
    supportSecret?: string;
    sessionless?: string;
    nodeEnv?: string;
  };
  let options: TestTokenOptions;
  let workshopSessionId: string;
  let supportAccountId: string;
  let supportSessionId: string;

  /** Claims de un token de taller, con sid salvo que se omita en `extra`. */
  function workshopClaims(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { ...testTokenClaims(options), sid: workshopSessionId, ...extra };
  }

  /** Claims de un token de soporte válido (research R3): sub, sid, name, pwd_change y aud. */
  function supportClaims(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      sub: supportAccountId,
      sid: supportSessionId,
      name: 'Pedro Soporte',
      pwd_change: true,
      iat: now,
      exp: now + 15 * 60,
      aud: SUPPORT_AUDIENCE,
      ...extra,
    };
  }

  function sign(
    payload: Record<string, unknown>,
    secret = SUPPORT_SECRET,
  ): string {
    return signTestJwt(payload, { secret });
  }

  /** Builds the guard after fixing the flag, so it works whether the flag is read at construction or per request. */
  async function guardWith(
    allowSessionlessTokens: boolean,
  ): Promise<JwtAuthGuard> {
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
    target: Handler = WORKSHOP,
  ): Promise<boolean> {
    return Promise.resolve().then(() =>
      guard.canActivate(httpContext(request, target)),
    ) as Promise<boolean>;
  }

  /** Runs the guard, asserts it rejected and that no identity was published. */
  async function captureError(
    guard: JwtAuthGuard,
    request: FakeRequest,
    target: Handler,
  ): Promise<HttpException> {
    const error: unknown = await activate(guard, request, target).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HttpException);
    expect(request.user).toBeUndefined();
    expect(request.supportAgent).toBeUndefined();
    return error as HttpException;
  }

  async function rejection(
    guard: JwtAuthGuard,
    request: FakeRequest,
    target: Handler = WORKSHOP,
  ): Promise<{ status: number; code: string }> {
    return problemOf(await captureError(guard, request, target));
  }

  async function forbidden(
    guard: JwtAuthGuard,
    request: FakeRequest,
    target: Handler,
  ): Promise<void> {
    const error = await captureError(guard, request, target);
    expect(error.getStatus()).toBe(403);
    expect(problemOf(error)).toEqual({ status: 403, code: 'FORBIDDEN' });
  }

  beforeAll(() => {
    previous = {
      secret: process.env.JWT_SECRET,
      supportSecret: process.env.SUPPORT_JWT_SECRET,
      sessionless: process.env.AUTH_ALLOW_SESSIONLESS_TOKENS,
      nodeEnv: process.env.NODE_ENV,
    };
    process.env.JWT_SECRET = SECRET;
    process.env.SUPPORT_JWT_SECRET = SUPPORT_SECRET;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('JWT_SECRET', previous.secret);
    restore('SUPPORT_JWT_SECRET', previous.supportSecret);
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
    workshopSessionId = randomUUID();
    supportAccountId = randomUUID();
    supportSessionId = randomUUID();
  });

  describe('ruta de taller (sin @SupportArea())', () => {
    it('[T013][R3] un token de taller válido permite el acceso y publica request.user', async () => {
      const guard = await guardWith(false);
      const request = bearer(sign(workshopClaims(), SECRET));

      await expect(activate(guard, request)).resolves.toBe(true);
      expect(request.user).toEqual({
        userId: options.userId,
        tenantId: options.tenantId,
        role: 'asesor',
        name: 'Ana Pérez',
        sessionId: workshopSessionId,
      });
      expect(request.supportAgent).toBeUndefined();
    });

    it('[US2-AC6][R3] un token de soporte válido responde 403 FORBIDDEN y no publica request.user', async () => {
      const guard = await guardWith(false);

      await forbidden(guard, bearer(sign(supportClaims())), WORKSHOP);
    });

    it('[T013][R9] un token de taller sin sid se acepta con AUTH_ALLOW_SESSIONLESS_TOKENS=true', async () => {
      const guard = await guardWith(true);
      const { sid: _sid, ...withoutSid } = workshopClaims();
      const request = bearer(sign(withoutSid, SECRET));

      await expect(activate(guard, request)).resolves.toBe(true);
      expect(request.user).toMatchObject({
        userId: options.userId,
        tenantId: options.tenantId,
      });
      expect(
        (request.user as { sessionId?: string }).sessionId,
      ).toBeUndefined();
    });

    it('[T013][R9] un token de taller sin sid → 401 UNAUTHORIZED con AUTH_ALLOW_SESSIONLESS_TOKENS=false', async () => {
      const guard = await guardWith(false);
      const { sid: _sid, ...withoutSid } = workshopClaims();

      await expect(
        rejection(guard, bearer(sign(withoutSid, SECRET))),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
    });

    it('[US2-AC6][R3] un token de soporte sin aud o con aud distinto no se confunde con uno de taller: 401 UNAUTHORIZED', async () => {
      const guard = await guardWith(false);
      const { aud: _aud, ...withoutAudience } = supportClaims();

      await expect(
        rejection(guard, bearer(sign(withoutAudience))),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
      await expect(
        rejection(
          guard,
          bearer(sign(supportClaims({ aud: 'motorsync-workshop' }))),
        ),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
    });
  });

  describe('ruta @SupportArea()', () => {
    it('[US2-AC5][R3] un token de soporte válido permite el acceso, publica supportAgent y no publica request.user', async () => {
      const guard = await guardWith(false);
      const request = bearer(sign(supportClaims()));

      await expect(activate(guard, request, SUPPORT_AREA)).resolves.toBe(true);
      expect(request.supportAgent).toEqual({
        id: supportAccountId,
        sessionId: supportSessionId,
        name: 'Pedro Soporte',
        mustChangePassword: true,
      });
      expect(request.user).toBeUndefined();
    });

    it('[US2-AC5][R3] un token de taller responde 403 FORBIDDEN y no publica supportAgent', async () => {
      const guard = await guardWith(false);

      await forbidden(
        guard,
        bearer(sign(workshopClaims(), SECRET)),
        SUPPORT_AREA,
      );
    });

    it('[R3] un token de soporte vencido → 401 TOKEN_EXPIRED', async () => {
      const guard = await guardWith(false);
      const past = Math.floor(Date.now() / 1000) - 60;

      await expect(
        rejection(
          guard,
          bearer(sign(supportClaims({ exp: past }))),
          SUPPORT_AREA,
        ),
      ).resolves.toEqual({ status: 401, code: 'TOKEN_EXPIRED' });
    });

    it('[R3] un token de soporte sin sid se rechaza aunque AUTH_ALLOW_SESSIONLESS_TOKENS=true', async () => {
      const guard = await guardWith(true);
      const { sid: _sid, ...withoutSid } = supportClaims();

      await expect(
        rejection(guard, bearer(sign(withoutSid)), SUPPORT_AREA),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
    });

    it('[US2-AC5][R3] sin aud, con aud distinto o firmado con otro secreto → 401 UNAUTHORIZED', async () => {
      const guard = await guardWith(false);
      const { aud: _aud, ...withoutAudience } = supportClaims();

      await expect(
        rejection(guard, bearer(sign(withoutAudience)), SUPPORT_AREA),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
      await expect(
        rejection(
          guard,
          bearer(sign(supportClaims({ aud: 'motorsync-workshop' }))),
          SUPPORT_AREA,
        ),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
      await expect(
        rejection(
          guard,
          bearer(sign(supportClaims(), OTHER_SECRET)),
          SUPPORT_AREA,
        ),
      ).resolves.toEqual({ status: 401, code: 'UNAUTHORIZED' });
    });

    it('[R3] @SupportArea() + @Public() pasa sin token y no publica supportAgent', async () => {
      const guard = await guardWith(false);
      const request: FakeRequest = { headers: {} };

      await expect(activate(guard, request, SUPPORT_PUBLIC)).resolves.toBe(
        true,
      );
      expect(request.supportAgent).toBeUndefined();
      expect(request.user).toBeUndefined();
    });
  });
});
