// T011: unit tests of JwtAuthGuard (research R3, principle I).
// Tokens are built with node:crypto (test/setup/auth.ts), independent of @nestjs/jwt.
import { randomUUID } from 'node:crypto';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import {
  issueTestToken,
  signTestJwt,
  testTokenClaims,
  type TestTokenOptions,
} from '../../test/setup/auth.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const SECRET = 'unit-test-secret-for-jwt-auth-guard-0123456789';
const OTHER_SECRET = 'another-secret-that-is-also-long-enough-987654';

interface FakeRequest {
  headers: Record<string, string>;
  body?: unknown;
  query?: unknown;
  user?: unknown;
}

function httpContext(request: FakeRequest): ExecutionContext {
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

function bearer(token: string): FakeRequest {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe('JwtAuthGuard (T011, research R3)', () => {
  let guard: JwtAuthGuard;
  let previousSecret: string | undefined;
  let options: TestTokenOptions;

  async function activate(request: FakeRequest): Promise<boolean> {
    return Promise.resolve().then(() => guard.canActivate(httpContext(request))) as Promise<boolean>;
  }

  async function expect401(request: FakeRequest): Promise<void> {
    const error: unknown = await activate(request).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(401);
    expect(request.user).toBeUndefined();
  }

  beforeAll(() => {
    previousSecret = process.env.JWT_SECRET;
    // The guard may read the secret from the JwtModule or from JWT_SECRET: both are the same here.
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET })],
      providers: [JwtAuthGuard],
    }).compile();
    guard = moduleRef.get(JwtAuthGuard);
    options = {
      tenantId: randomUUID(),
      userId: randomUUID(),
      role: 'asesor',
      name: 'Ana Pérez',
      secret: SECRET,
    };
  });

  it('[T011] con un token válido permite el acceso y expone { userId, tenantId, role, name }', async () => {
    const request = bearer(issueTestToken(options));

    await expect(activate(request)).resolves.toBe(true);

    expect(request.user).toEqual({
      userId: options.userId,
      tenantId: options.tenantId,
      role: 'asesor',
      name: 'Ana Pérez',
    });
  });

  it('[T011] acepta también el rol admin', async () => {
    const request = bearer(issueTestToken({ ...options, role: 'admin' }));

    await expect(activate(request)).resolves.toBe(true);
    expect(request.user).toMatchObject({ role: 'admin', tenantId: options.tenantId });
  });

  it('[T011] 401 sin cabecera Authorization', async () => {
    await expect401({ headers: {} });
  });

  it('[T011] 401 con un esquema distinto de Bearer o sin token', async () => {
    const token = issueTestToken(options);
    await expect401({ headers: { authorization: `Basic ${token}` } });
    await expect401({ headers: { authorization: 'Bearer' } });
    await expect401({ headers: { authorization: 'Bearer ' } });
    await expect401({ headers: { authorization: token } });
  });

  it('[T011] 401 con un token mal formado', async () => {
    await expect401(bearer('not-a-jwt'));
    await expect401(bearer('a.b.c'));
  });

  it('[T011] 401 con firma inválida (otro secreto)', async () => {
    await expect401(bearer(issueTestToken({ ...options, secret: OTHER_SECRET })));
  });

  it('[T011] 401 con la firma alterada', async () => {
    const token = issueTestToken(options);
    const [header, payload, signature] = token.split('.');
    const flipped = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect401(bearer(`${header}.${payload}.${flipped}`));
  });

  it('[T011] 401 con el payload alterado (otro tenant) manteniendo la firma original', async () => {
    const token = issueTestToken(options);
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify(testTokenClaims({ ...options, tenantId: randomUUID() })),
    ).toString('base64url');
    await expect401(bearer(`${header}.${forged}.${signature}`));
  });

  it('[T011] 401 con un token expirado', async () => {
    await expect401(bearer(issueTestToken({ ...options, expiresIn: -60 })));
  });

  it('[T011] 401 con alg none', async () => {
    await expect401(bearer(signTestJwt(testTokenClaims(options), { alg: 'none' })));
  });

  it('[T011] 401 con alg distinto de HS256 aunque la firma sea correcta con el mismo secreto (HS384, HS512)', async () => {
    const claims = testTokenClaims(options);
    await expect401(bearer(signTestJwt(claims, { alg: 'HS384', secret: SECRET })));
    await expect401(bearer(signTestJwt(claims, { alg: 'HS512', secret: SECRET })));
  });

  it('[T011] 401 sin tenant_id o con tenant_id que no es uuid', async () => {
    const claims = testTokenClaims(options);
    const { tenant_id: _omit, ...withoutTenant } = claims;
    await expect401(bearer(signTestJwt(withoutTenant, { secret: SECRET })));
    await expect401(bearer(signTestJwt({ ...claims, tenant_id: 'taller-1' }, { secret: SECRET })));
    await expect401(bearer(signTestJwt({ ...claims, tenant_id: '' }, { secret: SECRET })));
  });

  it('[T011] 401 sin sub o con sub que no es uuid', async () => {
    const claims = testTokenClaims(options);
    const { sub: _omit, ...withoutSub } = claims;
    await expect401(bearer(signTestJwt(withoutSub, { secret: SECRET })));
    await expect401(bearer(signTestJwt({ ...claims, sub: 'user-42' }, { secret: SECRET })));
    await expect401(bearer(signTestJwt({ ...claims, sub: 42 }, { secret: SECRET })));
  });

  it('[T011] 401 con role fuera de asesor o admin, o sin role', async () => {
    const claims = testTokenClaims(options);
    const { role: _omit, ...withoutRole } = claims;
    await expect401(bearer(signTestJwt(withoutRole, { secret: SECRET })));
    await expect401(bearer(signTestJwt({ ...claims, role: 'mecanico' }, { secret: SECRET })));
    await expect401(bearer(signTestJwt({ ...claims, role: 'ADMIN' }, { secret: SECRET })));
    await expect401(bearer(signTestJwt({ ...claims, role: ['admin'] }, { secret: SECRET })));
  });

  it('[T011][Principio I] el tenant expuesto sale del token y no de X-Tenant-Id, body ni query', async () => {
    const foreignTenant = randomUUID();
    const request: FakeRequest = {
      headers: {
        authorization: `Bearer ${issueTestToken(options)}`,
        'x-tenant-id': foreignTenant,
      },
      body: { tenantId: foreignTenant },
      query: { tenant_id: foreignTenant },
    };

    await expect(activate(request)).resolves.toBe(true);
    expect(request.user).toMatchObject({ tenantId: options.tenantId });
  });
});
