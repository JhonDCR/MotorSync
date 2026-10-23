// T013: smoke e2e of the full app wiring (AppModule + configureApp, the same as main.ts):
// global prefix /api/v1, global JwtAuthGuard, ProblemDetailsFilter and the tenant interceptor
// over the real PostgreSQL as motorsync_app.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { authHeader, issueTestToken } from './setup/auth.js';
import { closeFixtures, createTenant, type TenantFixture } from './setup/db-fixtures.js';

describe('App (e2e, T013)', () => {
  let app: INestApplication<App>;
  let tenant: TenantFixture;

  beforeAll(async () => {
    tenant = await createTenant(`Taller app e2e ${randomUUID()}`);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await closeFixtures();
  });

  function validToken(): string {
    return issueTestToken({
      tenantId: tenant.id,
      userId: randomUUID(),
      role: 'asesor',
      name: 'Ana Pérez',
    });
  }

  it('[T013][R3] GET /api/v1 sin token → 401 application/problem+json con code UNAUTHORIZED', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1');

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(typeof res.body.type).toBe('string');
    expect(typeof res.body.title).toBe('string');
  });

  // Feature 002 (research R12, T012): a validly signed but expired token now answers
  // 401 TOKEN_EXPIRED so the frontend refreshes; a token signed with another secret stays UNAUTHORIZED.
  it('[T013][R3][R12] GET /api/v1 con un token con firma válida y vencido → 401 TOKEN_EXPIRED', async () => {
    const base = { tenantId: tenant.id, userId: randomUUID(), role: 'asesor' as const, name: 'Ana' };
    const token = issueTestToken({ ...base, expiresIn: -60 });
    const res = await request(app.getHttpServer()).get('/api/v1').set(authHeader(token));
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('[T013][R3] GET /api/v1 con un token de otro secreto → 401 UNAUTHORIZED', async () => {
    const base = { tenantId: tenant.id, userId: randomUUID(), role: 'asesor' as const, name: 'Ana' };
    const token = issueTestToken({ ...base, secret: 'x'.repeat(48) });
    const res = await request(app.getHttpServer()).get('/api/v1').set(authHeader(token));
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('[T013][R3] GET /api/v1 con issueTestToken() válido → 200', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1').set(authHeader(validToken()));

    expect(res.status).toBe(200);
    expect(res.text).toBe('Hello World!');
  });

  it('[T013] el AppController solo responde bajo el prefijo: GET / → 404', async () => {
    // Outside /api/v1 the body format is not part of the contract; only the status is checked.
    const res = await request(app.getHttpServer()).get('/').set(authHeader(validToken()));
    expect(res.status).toBe(404);
  });

  it('[T013] una ruta inexistente bajo /api/v1 con token → 404 problem+json NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/no-such-route')
      .set(authHeader(validToken()));

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
