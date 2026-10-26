// T062 (specs/003-soporte-plataforma, PR3, US4): e2e of the support access log view and of its
// operations command, over the full app wiring (AppModule + configureApp) and the real
// PostgreSQL, the API connecting as motorsync_app and the fixtures as motorsync_migrator.
//
// Covered: US4-AC8, US4-AC9, FR-027 (including the operations command) and the read-only half
// of FR-018 / FR-027.
//
// Contract (contracts/openapi.yaml):
// - GET /api/v1/support/access-log?workshopId=&agentId=&page= → 200 { items, page, pageSize,
//   total } with pageSize fixed at 50, newest first. AccessLogEntry has exactly id, occurredAt,
//   agent{id, name}, workshop{id, name, ruc}, ip and channel; never the agent's email.
//   Filters are optional and combinable; an unknown uuid returns an empty page, a non-uuid
//   workshopId → 400 VALIDATION_ERROR.
// - Reading the access log never writes to it. There is no create/update/delete operation:
//   POST, PUT, PATCH and DELETE on /support/access-log and /support/access-log/{id} → 404.
//   A workshop token → 403 FORBIDDEN.
// - `runSupportAccount(['access-log', '--email', <agent>, '--since', <ISO date>])` lists only
//   that agent's views from that date on, with the workshop and the IP (FR-027, R10).
//
// TDD note: T063 implements support-access-log.service.ts, support-access-log.controller.ts,
// list-access-log.dto.ts and the `access-log` command of backend/scripts/support-account.ts.
// Until it lands, GET /support/access-log does not exist (404) and the command answers
// "Comando desconocido: access-log" with exit code 1. The routes that must stay absent
// (US4-AC9) already return 404; nothing here imports production code from T063.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { runSupportAccount } from '../scripts/support-account.js';
import { authHeader, loginAs } from './setup/auth.js';
import {
  closeFixtures,
  countRows,
  createSupportAccount,
  createTenant,
  createUser,
  truncateBusinessTables,
  type SupportAccountFixture,
  type TenantFixture,
  type UserFixture,
} from './setup/db-fixtures.js';
import {
  loginAsSupport,
  type SupportLoginResult,
} from './setup/support.js';

const PASSWORD = 'Clave-Segura-123';
const SUPPORT_ACCESS_LOG = '/api/v1/support/access-log';
const PEDRO_NAME = 'Pedro Soporte';
const PEDRO_EMAIL = 'pedro.accesslog@motorsync.ec';
const MARTA_NAME = 'Marta Soporte';
const MARTA_EMAIL = 'marta.accesslog@motorsync.ec';
/** ISO 8601 with a Z suffix (the contract always serializes UTC). */
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENVELOPE_KEYS = ['items', 'page', 'pageSize', 'total'];
const ENTRY_KEYS = [
  'id',
  'occurredAt',
  'agent',
  'workshop',
  'ip',
  'channel',
];
const AGENT_KEYS = ['id', 'name'];
const WORKSHOP_KEYS = ['id', 'name', 'ruc'];

type Json = Record<string, unknown>;

interface ScriptRun {
  code: number;
  stdout: string[];
  stderr: string[];
}

let rucCounter = 0;

function newRuc(): string {
  rucCounter += 1;
  return `179${String(rucCounter).padStart(7, '0')}001`;
}

describe('Support access log: bitácora de solo lectura y comando (e2e, T062, US4)', () => {
  let app: INestApplication<App>;
  let migratorPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Only used by the operations test, to prove the `--since` filter. */
  let tenantC: TenantFixture;
  /** Admin of workshop A: the workshop token of the separation checks. */
  let ana: UserFixture;
  let pedro: SupportAccountFixture;
  let marta: SupportAccountFixture;
  let pedroSession: SupportLoginResult;
  let martaSession: SupportLoginResult;

  function server() {
    return request(app.getHttpServer());
  }

  function expectProblem(res: Response, status: number, code: string): void {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, code });
  }

  function expectIsoZ(value: unknown): void {
    expect(typeof value).toBe('string');
    expect(value as string).toMatch(ISO_Z_RE);
    expect(Number.isNaN(Date.parse(value as string))).toBe(false);
  }

  function expectExactKeys(
    value: unknown,
    expected: string[],
    label: string,
  ): void {
    expect(value, `${label} is missing`).toBeTruthy();
    expect(Object.keys(value as Json).sort(), label).toEqual(
      [...expected].sort(),
    );
  }

  /** Inserts an access log entry as the migrator with a controlled occurred_at. */
  async function insertAccessLog(
    agentId: string,
    tenantId: string,
    occurredAt: Date,
    ip: string,
  ): Promise<string> {
    const result = await migratorPool.query<{ id: string }>(
      `INSERT INTO support_access_log (support_account_id, tenant_id, action, ip, occurred_at)
       VALUES ($1, $2, 'workshop.accounts_viewed', $3, $4)
       RETURNING id`,
      [agentId, tenantId, ip, occurredAt],
    );
    return result.rows[0].id;
  }

  async function runScript(argv: string[]): Promise<ScriptRun> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runSupportAccount(argv, {
      pool: migratorPool,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    });
    return { code, stdout, stderr };
  }

  function getAccessLog(
    token: string,
    query: Json = {},
  ): Promise<Response> {
    return server()
      .get(SUPPORT_ACCESS_LOG)
      .query(query)
      .set(authHeader(token));
  }

  function http(
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token: string,
  ): Promise<Response> {
    const agent = server();
    const call =
      method === 'post'
        ? agent.post(path)
        : method === 'put'
          ? agent.put(path)
          : method === 'patch'
            ? agent.patch(path)
            : agent.delete(path);
    return call.set(authHeader(token)).send({});
  }

  function entryIds(res: Response): string[] {
    return ((res.body as { items?: Json[] }).items ?? []).map(
      (item) => item.id as string,
    );
  }

  beforeAll(async () => {
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!migratorUrl) {
      throw new Error(
        'DATABASE_MIGRATOR_URL is not set in the e2e environment',
      );
    }
    migratorPool = new pg.Pool({ connectionString: migratorUrl, max: 2 });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    tenantA = await createTenant('Taller A bitácora', newRuc());
    tenantB = await createTenant('Taller B bitácora', newRuc());
    tenantC = await createTenant('Taller C bitácora', newRuc());
    ana = await createUser({
      tenantId: tenantA.id,
      name: 'Ana Pérez',
      email: 'ana.perez@taller.ec',
      role: 'admin',
      password: PASSWORD,
    });
    pedro = await createSupportAccount({
      name: PEDRO_NAME,
      email: PEDRO_EMAIL,
      password: PASSWORD,
      mustChangePassword: false,
    });
    marta = await createSupportAccount({
      name: MARTA_NAME,
      email: MARTA_EMAIL,
      password: PASSWORD,
      mustChangePassword: false,
    });
    pedroSession = await loginAsSupport(app, PEDRO_EMAIL, PASSWORD);
    martaSession = await loginAsSupport(app, MARTA_EMAIL, PASSWORD);
  });

  afterAll(async () => {
    await app?.close();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US4-AC8

  it('[US4-AC8] la bitácora va de la más reciente a la más antigua, pageSize = 50 y claves exactas, sin correo del agente', async () => {
    const oldestAt = new Date('2026-01-01T10:00:00.000Z');
    const middleAt = new Date('2026-01-02T10:00:00.000Z');
    const newestAt = new Date('2026-01-03T10:00:00.000Z');
    const oldest = await insertAccessLog(
      pedro.id,
      tenantA.id,
      oldestAt,
      '198.51.100.1',
    );
    const middle = await insertAccessLog(
      marta.id,
      tenantB.id,
      middleAt,
      '198.51.100.2',
    );
    const newest = await insertAccessLog(
      pedro.id,
      tenantA.id,
      newestAt,
      '198.51.100.3',
    );

    const res = await getAccessLog(pedroSession.accessToken);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(Object.keys(res.body as Json).sort()).toEqual(
      [...ENVELOPE_KEYS].sort(),
    );

    const body = res.body as {
      items: Json[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(50);
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.map((item) => item.id)).toEqual([
      newest,
      middle,
      oldest,
    ]);

    const expected = new Map([
      [newest, { agent: pedro, tenant: tenantA, at: newestAt, ip: '198.51.100.3' }],
      [middle, { agent: marta, tenant: tenantB, at: middleAt, ip: '198.51.100.2' }],
      [oldest, { agent: pedro, tenant: tenantA, at: oldestAt, ip: '198.51.100.1' }],
    ]);
    for (const item of body.items) {
      expectExactKeys(item, ENTRY_KEYS, 'AccessLogEntry');
      expect(item.id).toMatch(UUID_RE);
      expectIsoZ(item.occurredAt);
      expectExactKeys(item.agent, AGENT_KEYS, 'AccessLogEntry.agent');
      expectExactKeys(item.workshop, WORKSHOP_KEYS, 'AccessLogEntry.workshop');
      expect((item.agent as Json).id).toMatch(UUID_RE);
      expect((item.workshop as Json).id).toMatch(UUID_RE);
      expect(item.channel).toBe('support_panel');
      expect(typeof item.ip).toBe('string');

      const reference = expected.get(item.id as string);
      expect(reference).toBeDefined();
      expect(item.agent).toEqual({
        id: reference?.agent.id,
        name: reference?.agent.name,
      });
      expect(item.workshop).toEqual({
        id: reference?.tenant.id,
        name: reference?.tenant.name,
        ruc: reference?.tenant.ruc,
      });
      expect(item.ip).toBe(reference?.ip);
      expect(new Date(item.occurredAt as string).toISOString()).toBe(
        reference?.at.toISOString(),
      );
    }

    // The access log never exposes the agent's email (contract, FR-027).
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(PEDRO_EMAIL);
    expect(serialized).not.toContain(MARTA_EMAIL);
  });

  it('[US4-AC8] filtra por taller, por agente y por ambos filtros combinados', async () => {
    const pedroA = await insertAccessLog(
      pedro.id,
      tenantA.id,
      new Date('2026-01-01T10:00:00.000Z'),
      '198.51.100.10',
    );
    const pedroB = await insertAccessLog(
      pedro.id,
      tenantB.id,
      new Date('2026-01-02T10:00:00.000Z'),
      '198.51.100.11',
    );
    const martaA = await insertAccessLog(
      marta.id,
      tenantA.id,
      new Date('2026-01-03T10:00:00.000Z'),
      '198.51.100.12',
    );
    const martaB = await insertAccessLog(
      marta.id,
      tenantB.id,
      new Date('2026-01-04T10:00:00.000Z'),
      '198.51.100.13',
    );

    const byWorkshop = await getAccessLog(pedroSession.accessToken, {
      workshopId: tenantA.id,
    });
    expect(byWorkshop.status, JSON.stringify(byWorkshop.body)).toBe(200);
    expect(entryIds(byWorkshop)).toEqual([martaA, pedroA]);
    for (const item of (byWorkshop.body as { items: Json[] }).items) {
      expect((item.workshop as Json).id).toBe(tenantA.id);
    }

    const byAgent = await getAccessLog(pedroSession.accessToken, {
      agentId: marta.id,
    });
    expect(byAgent.status, JSON.stringify(byAgent.body)).toBe(200);
    expect(entryIds(byAgent)).toEqual([martaB, martaA]);
    for (const item of (byAgent.body as { items: Json[] }).items) {
      expect((item.agent as Json).id).toBe(marta.id);
    }

    const combined = await getAccessLog(pedroSession.accessToken, {
      workshopId: tenantA.id,
      agentId: marta.id,
    });
    expect(combined.status, JSON.stringify(combined.body)).toBe(200);
    expect(entryIds(combined)).toEqual([martaA]);
    expect((combined.body as { total: number }).total).toBe(1);

    // The other combinations are consistent too.
    expect(
      entryIds(
        await getAccessLog(pedroSession.accessToken, {
          workshopId: tenantB.id,
        }),
      ),
    ).toEqual([martaB, pedroB]);
    expect(
      entryIds(
        await getAccessLog(pedroSession.accessToken, {
          workshopId: tenantB.id,
          agentId: pedro.id,
        }),
      ),
    ).toEqual([pedroB]);
  });

  it('[US4-AC8] un uuid inexistente devuelve una página vacía y un workshopId no uuid → 400', async () => {
    await insertAccessLog(
      pedro.id,
      tenantA.id,
      new Date('2026-01-01T10:00:00.000Z'),
      '198.51.100.20',
    );

    const missing = await getAccessLog(pedroSession.accessToken, {
      workshopId: randomUUID(),
    });
    expect(missing.status, JSON.stringify(missing.body)).toBe(200);
    const missingBody = missing.body as {
      items: Json[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(missingBody.items).toEqual([]);
    expect(missingBody.total).toBe(0);
    expect(missingBody.page).toBe(1);
    expect(missingBody.pageSize).toBe(50);

    const invalid = await getAccessLog(pedroSession.accessToken, {
      workshopId: 'not-a-uuid',
    });
    expectProblem(invalid, 400, 'VALIDATION_ERROR');
  });

  it('[US4-AC8] con 51 registros la página 1 trae 50 y la página 2 trae 1', async () => {
    const base = Date.parse('2026-02-01T00:00:00.000Z');
    const ids: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      ids.push(
        await insertAccessLog(
          pedro.id,
          tenantA.id,
          new Date(base + index * 60_000),
          `198.51.100.${100 + index}`,
        ),
      );
    }

    const first = await getAccessLog(pedroSession.accessToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const firstPage = first.body as {
      items: Json[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(firstPage.page).toBe(1);
    expect(firstPage.pageSize).toBe(50);
    expect(firstPage.total).toBe(51);
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.items[0].id).toBe(ids[50]);
    expect(firstPage.items[49].id).toBe(ids[1]);

    const second = await getAccessLog(pedroSession.accessToken, { page: 2 });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const secondPage = second.body as {
      items: Json[];
      page: number;
      pageSize: number;
      total: number;
    };
    expect(secondPage.page).toBe(2);
    expect(secondPage.pageSize).toBe(50);
    expect(secondPage.total).toBe(51);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].id).toBe(ids[0]);
  });

  // ---------------------------------------------------------------- US4-AC9

  it('[US4-AC9] consultar la bitácora varias veces no crea registros en ella', async () => {
    await insertAccessLog(
      pedro.id,
      tenantA.id,
      new Date('2026-01-01T10:00:00.000Z'),
      '198.51.100.30',
    );
    await insertAccessLog(
      marta.id,
      tenantB.id,
      new Date('2026-01-02T10:00:00.000Z'),
      '198.51.100.31',
    );
    const before = await countRows('support_access_log');
    expect(before).toBe(2);

    const requests = [
      await getAccessLog(pedroSession.accessToken),
      await getAccessLog(martaSession.accessToken, {
        workshopId: tenantA.id,
      }),
      await getAccessLog(pedroSession.accessToken, { agentId: marta.id }),
    ];
    for (const res of requests) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    expect(await countRows('support_access_log')).toBe(before);
  });

  it('[US4-AC9] POST, PUT, PATCH y DELETE sobre la bitácora y sus registros → 404 sin cambios', async () => {
    const id = await insertAccessLog(
      pedro.id,
      tenantA.id,
      new Date('2026-01-01T10:00:00.000Z'),
      '198.51.100.40',
    );
    const before = await countRows('support_access_log');

    const paths = [SUPPORT_ACCESS_LOG, `${SUPPORT_ACCESS_LOG}/${id}`];
    const methods = ['post', 'put', 'patch', 'delete'] as const;
    for (const path of paths) {
      for (const method of methods) {
        const res = await http(method, path, pedroSession.accessToken);
        expect(
          res.status,
          `${method.toUpperCase()} ${path}: ${JSON.stringify(res.body)}`,
        ).toBe(404);
      }
    }

    expect(await countRows('support_access_log')).toBe(before);
  });

  it('[US4-AC9] el token del admin del taller A no puede ver la bitácora → 403 FORBIDDEN sin cambios', async () => {
    await insertAccessLog(
      pedro.id,
      tenantA.id,
      new Date('2026-01-01T10:00:00.000Z'),
      '198.51.100.50',
    );
    const before = await countRows('support_access_log');
    const admin = await loginAs(app, ana.email, PASSWORD);

    const res = await getAccessLog(admin.accessToken);
    expectProblem(res, 403, 'FORBIDDEN');
    expect(res.body).not.toHaveProperty('items');

    expect(await countRows('support_access_log')).toBe(before);
  });

  // ---------------------------------------------------------------- FR-027 (operations)

  it('[FR-027] el comando access-log lista solo las consultas de Pedro desde --since, con taller e IP', async () => {
    await insertAccessLog(
      pedro.id,
      tenantC.id,
      new Date('2026-10-19T12:00:00.000Z'),
      '198.51.100.61',
    );
    await insertAccessLog(
      pedro.id,
      tenantA.id,
      new Date('2026-10-21T12:00:00.000Z'),
      '198.51.100.62',
    );
    await insertAccessLog(
      pedro.id,
      tenantB.id,
      new Date('2026-10-22T12:00:00.000Z'),
      '198.51.100.63',
    );
    await insertAccessLog(
      marta.id,
      tenantA.id,
      new Date('2026-10-21T13:00:00.000Z'),
      '198.51.100.64',
    );

    const run = await runScript([
      'access-log',
      '--email',
      PEDRO_EMAIL,
      '--since',
      '2026-10-20T00:00:00.000Z',
    ]);

    expect(run.code, run.stderr.join('\n')).toBe(0);
    expect(run.stderr).toEqual([]);
    const text = run.stdout.join('\n');
    expect(text, 'the command should print the matching entries').not.toBe('');

    // Only Pedro's views from the given date on: workshop A and B, with their IPs.
    expect(text).toContain(tenantA.name);
    expect(text).toContain(tenantB.name);
    expect(text).toContain('198.51.100.62');
    expect(text).toContain('198.51.100.63');
    // The entry before --since (tenant C) and Marta's entry are excluded.
    expect(text).not.toContain(tenantC.name);
    expect(text).not.toContain('198.51.100.61');
    expect(text).not.toContain('198.51.100.64');
    expect(text).not.toContain(MARTA_NAME);
    expect(text).not.toContain(MARTA_EMAIL);
  });
});
