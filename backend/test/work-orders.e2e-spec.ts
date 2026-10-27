// T001, T003, T004, T006: ordenes de trabajo (feature 006) over AppModule and the real PostgreSQL.
// Contract: specs/006-ordenes-trabajo/contracts/openapi.yaml.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { authHeader, loginAs } from './setup/auth.js';
import {
  closeFixtures,
  createTenant,
  createUser,
  readAuditLog,
  truncateBusinessTables,
  type TenantFixture,
} from './setup/db-fixtures.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const PASSWORD = 'Clave-Segura-123';
const TABLES = ['work_orders', 'work_order_items', 'work_order_status_changes', 'work_order_notes'];
const LINES = {
  lines: [
    { kind: 'repuesto', description: 'pastillas de freno', quantity: '2', unitPrice: '18.50' },
    { kind: 'mano_obra', description: 'cambio de pastillas', quantity: '1', unitPrice: '25.00' },
  ],
};

interface Actor {
  token: string;
  userId: string;
}
interface Setup {
  tenant: TenantFixture;
  actor: Actor;
  vehicleId: string;
  checkinId: string;
}

let app: INestApplication<App>;
let appPool: pg.Pool;
let migratorPool: pg.Pool;
let A: Setup;
let B: Setup;

const http = () => request(app.getHttpServer());
const get = (a: Actor, path: string) => http().get(`/api/v1${path}`).set(authHeader(a.token));
const post = (a: Actor, path: string, payload?: object) =>
  http().post(`/api/v1${path}`).set(authHeader(a.token)).send(payload);
const patch = (a: Actor, path: string, payload: object) =>
  http().patch(`/api/v1${path}`).set(authHeader(a.token)).send(payload);
const ids = (body: { id: string }[]) => body.map((b) => b.id);

async function newCheckin(actor: Actor, vehicleId: string): Promise<string> {
  const res = await post(actor, `/vehicles/${vehicleId}/checkins`, {
    mileage: 85000,
    fuelLevel: '1/2',
    reason: 'ruido al frenar',
    inventory: [],
    damages: [],
    signature: { mime: 'image/png', base64: PNG.toString('base64') },
  });
  expect(res.status, 'POST checkin').toBe(201);
  return res.body.id as string;
}

async function createBudget(s: Setup, checkinId = s.checkinId): Promise<string> {
  const res = await post(s.actor, `/checkins/${checkinId}/budgets`, LINES);
  expect(res.status, 'POST budget').toBe(201);
  return res.body.id as string;
}

async function approvedBudget(s: Setup, checkinId = s.checkinId): Promise<string> {
  const id = await createBudget(s, checkinId);
  expect((await post(s.actor, `/budgets/${id}/send`)).status).toBe(200);
  expect((await post(s.actor, `/budgets/${id}/approve`)).status).toBe(200);
  return id;
}

async function createWo(s: Setup, checkinId = s.checkinId): Promise<string> {
  const res = await post(s.actor, `/budgets/${await approvedBudget(s, checkinId)}/work-orders`);
  expect(res.status, 'POST work-order').toBe(201);
  return res.body.id as string;
}

async function setup(label: string, doc: string, plate: string): Promise<Setup> {
  const tenant = await createTenant(`Taller ${label} wo ${randomUUID()}`);
  const email = `asesor-${label.toLowerCase()}-${randomUUID()}@wo.test`;
  const user = await createUser({
    tenantId: tenant.id,
    name: `Asesor ${label}`,
    email,
    role: 'asesor',
    password: PASSWORD,
  });
  const { accessToken } = await loginAs(app, email, PASSWORD);
  const actor = { token: accessToken, userId: user.id };
  const client = await post(actor, '/clients', {
    clientType: 'natural',
    documentType: 'passport',
    documentNumber: doc,
    firstNames: 'Ana',
    lastNames: 'Pérez',
    phone: '0991234567',
  });
  expect(client.status, 'POST /clients').toBe(201);
  const vehicle = await post(actor, '/vehicles', {
    ownerClientId: client.body.id,
    plate,
    brand: 'Toyota',
    model: 'Corolla',
    year: 2020,
    color: 'Blanco',
    bodyType: 'sedan',
    initialMileage: 45000,
  });
  expect(vehicle.status, 'POST /vehicles').toBe(201);
  const vehicleId = vehicle.body.id as string;
  return { tenant, actor, vehicleId, checkinId: await newCheckin(actor, vehicleId) };
}

/** Runs fn on the pool with the tenant pinned (or not) and rolls back unless commit is true. */
async function inTx<T>(
  pool: pg.Pool,
  tenantId: string | null,
  fn: (c: pg.PoolClient) => Promise<T>,
  commit = false,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const out = await fn(c);
    if (commit) await c.query('COMMIT');
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const asApp = <T>(tenantId: string | null, fn: (c: pg.PoolClient) => Promise<T>) =>
  inTx(appPool, tenantId, fn);

const sqlError = (tenantId: string, sql: string, params: unknown[] = []) =>
  asApp(tenantId, (c) =>
    c.query(sql, params).then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    ),
  );

beforeAll(async () => {
  appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  migratorPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, max: 1 });
  const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = mod.createNestApplication();
  configureApp(app);
  await app.init();
});

beforeEach(async () => {
  await truncateBusinessTables();
  A = await setup('A', 'AA112233', 'PBA1234');
  B = await setup('B', 'BB998877', 'GBB5678');
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await migratorPool?.end();
  await truncateBusinessTables();
  await closeFixtures();
});

describe('db (T001)', () => {
  const insertWo = (c: pg.PoolClient, s: Setup, budgetId: string, n: number) =>
    c.query<{ id: string }>(
      `INSERT INTO work_orders (tenant_id, number, budget_id, checkin_id, vehicle_id, assignee_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
      [s.tenant.id, n, budgetId, s.checkinId, s.vehicleId, s.actor.userId],
    );

  const seedWo = async (s: Setup) => {
    const budgetId = await approvedBudget(s);
    await inTx(
      migratorPool,
      s.tenant.id,
      async (c) => {
        const wo = (await insertWo(c, s, budgetId, 1)).rows[0].id;
        const p = [s.tenant.id, wo, s.actor.userId];
        await c.query(
          `INSERT INTO work_order_items (tenant_id, work_order_id, position, kind, description, quantity)
           VALUES ($1, $2, 1, 'repuesto', 'x', 1)`,
          [s.tenant.id, wo],
        );
        await c.query(
          `INSERT INTO work_order_status_changes (tenant_id, work_order_id, status, changed_by)
           VALUES ($1, $2, 'abierta', $3)`,
          p,
        );
        await c.query(
          `INSERT INTO work_order_notes (tenant_id, work_order_id, body, created_by) VALUES ($1, $2, 'nota', $3)`,
          p,
        );
      },
      true,
    );
  };

  beforeEach(async () => {
    await seedWo(A);
    await seedWo(B);
  });

  it('[US3-AC2] motorsync_app sin tenant ve 0 filas', async () => {
    for (const t of TABLES) {
      const n = await asApp(null, async (c) =>
        Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n),
      );
      expect(n, t).toBe(0);
    }
  });

  it('[US3-AC2] con tenant A no se ven filas de B', async () => {
    for (const t of TABLES) {
      const rows = await asApp(A.tenant.id, async (c) => (await c.query(`SELECT tenant_id FROM ${t}`)).rows);
      expect(rows.length, t).toBeGreaterThan(0);
      expect(
        rows.every((r) => r.tenant_id === A.tenant.id),
        t,
      ).toBe(true);
    }
  });

  it('[US3-AC2] UPDATE/DELETE sobre items, historial y notas fallan por permisos', async () => {
    for (const t of TABLES.slice(1)) {
      expect((await sqlError(A.tenant.id, `UPDATE ${t} SET tenant_id = tenant_id`))?.code, t).toBe('42501');
      expect((await sqlError(A.tenant.id, `DELETE FROM ${t}`))?.code, t).toBe('42501');
    }
  });

  it('[US1-AC2] segunda OT activa del mismo check-in viola el indice unico parcial', async () => {
    const other = await approvedBudget(A);
    const err = await asApp(A.tenant.id, (c) =>
      insertWo(c, A, other, 2).then(
        () => null,
        (e: { code?: string }) => e,
      ),
    );
    expect(err?.code).toBe('23505');
  });
});

describe('Crear y asignar (T003, US1)', () => {
  it('[US1-AC1] crea abierta con numero 1, items copiados e historial', async () => {
    const budgetId = await approvedBudget(A);
    const res = await post(A.actor, `/budgets/${budgetId}/work-orders`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      number: 1,
      status: 'abierta',
      budgetId,
      checkinId: A.checkinId,
      vehicleId: A.vehicleId,
      assignee: { id: A.actor.userId },
      createdBy: { id: A.actor.userId },
    });
    expect(res.body.items).toMatchObject([
      { position: 1, kind: 'repuesto', description: 'pastillas de freno', quantity: '2.00' },
      { position: 2, kind: 'mano_obra', description: 'cambio de pastillas', quantity: '1.00' },
    ]);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toMatchObject({ status: 'abierta', changedBy: { id: A.actor.userId } });
  });

  it('[US1-AC2] 409 budget_not_approved y work_order_exists', async () => {
    const sent = await createBudget(A);
    expect((await post(A.actor, `/budgets/${sent}/send`)).status).toBe(200);
    const notApproved = await post(A.actor, `/budgets/${sent}/work-orders`);
    expect(notApproved.status).toBe(409);
    expect(notApproved.body.code).toBe('budget_not_approved');

    const ok = await approvedBudget(A);
    expect((await post(A.actor, `/budgets/${ok}/work-orders`)).status).toBe(201);
    const again = await post(A.actor, `/budgets/${ok}/work-orders`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('work_order_exists');
    expect((await get(A.actor, '/work-orders')).body).toHaveLength(1);
  });

  it('[US1-AC3] admin reasigna; asesor 403; usuario de B 422', async () => {
    const wo = await createWo(A);
    const email = `admin-${randomUUID()}@wo.test`;
    const adminUser = await createUser({
      tenantId: A.tenant.id,
      name: 'Admin A',
      email,
      role: 'admin',
      password: PASSWORD,
    });
    const admin = { token: (await loginAs(app, email, PASSWORD)).accessToken, userId: adminUser.id };

    expect((await patch(A.actor, `/work-orders/${wo}/assignee`, { userId: admin.userId })).status).toBe(403);
    expect((await patch(admin, `/work-orders/${wo}/assignee`, { userId: B.actor.userId })).status).toBe(422);
    expect((await get(A.actor, `/work-orders/${wo}`)).body.assignee.id).toBe(A.actor.userId);
    const ok = await patch(admin, `/work-orders/${wo}/assignee`, { userId: admin.userId });
    expect(ok.status).toBe(200);
    expect(ok.body.assignee.id).toBe(admin.userId);
  });

  it('[US1-AC4] 404 con presupuesto u OT de B y nada cambia en B', async () => {
    const budgetB = await approvedBudget(B, await newCheckin(B.actor, B.vehicleId));
    expect((await post(A.actor, `/budgets/${budgetB}/work-orders`)).status).toBe(404);
    const woB = await createWo(B);
    expect((await get(A.actor, `/work-orders/${woB}`)).status).toBe(404);
    expect((await post(A.actor, `/work-orders/${woB}/start`)).status).toBe(404);
    expect((await post(A.actor, `/work-orders/${woB}/notes`, { body: 'x' })).status).toBe(404);
    const inB = await get(B.actor, `/work-orders/${woB}`);
    expect(inB.body).toMatchObject({ status: 'abierta', notes: [] });
    expect((await get(B.actor, '/work-orders')).body).toHaveLength(1);
  });
});

describe('Estados y notas (T004, US2)', () => {
  it('[US2-AC1] start -> finish -> deliver con historial y auditoria', async () => {
    const wo = await createWo(A);
    for (const [action, status] of [
      ['start', 'en_proceso'],
      ['finish', 'terminada'],
      ['deliver', 'entregada'],
    ]) {
      const res = await post(A.actor, `/work-orders/${wo}/${action}`);
      expect(res.status, action).toBe(200);
      expect(res.body.status).toBe(status);
    }
    const detail = await get(A.actor, `/work-orders/${wo}`);
    expect(detail.body.history.map((h: { status: string }) => h.status)).toEqual([
      'abierta',
      'en_proceso',
      'terminada',
      'entregada',
    ]);
    const audit = (await readAuditLog(A.tenant.id, wo)).filter((r) => r.action === 'work_order.status_changed');
    expect(audit).toHaveLength(3);
    expect(audit.map((r) => [r.before, r.after])).toEqual([
      [{ status: 'abierta' }, { status: 'en_proceso' }],
      [{ status: 'en_proceso' }, { status: 'terminada' }],
      [{ status: 'terminada' }, { status: 'entregada' }],
    ]);
    for (const r of audit) {
      expect(r.actorUserId).toBe(A.actor.userId);
      expect(r.reason).toBeTruthy();
    }
  });

  it('[US2-AC2] cancelar con motivo audita; sin motivo 400', async () => {
    const wo = await createWo(A);
    expect((await post(A.actor, `/work-orders/${wo}/cancel`, {})).status).toBe(400);
    const res = await post(A.actor, `/work-orders/${wo}/cancel`, { reason: 'cliente desistio' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelada');
    expect(res.body.history.at(-1)).toMatchObject({ status: 'cancelada', reason: 'cliente desistio' });
    const audit = (await readAuditLog(A.tenant.id, wo)).filter((r) => r.action === 'work_order.cancelled');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      before: { status: 'abierta' },
      after: { status: 'cancelada' },
      reason: 'cliente desistio',
    });
  });

  it('[US2-AC3] 409 con currentStatus en transiciones invalidas', async () => {
    const wo = await createWo(A);
    const skip = await post(A.actor, `/work-orders/${wo}/finish`);
    expect(skip.status).toBe(409);
    expect(skip.body.currentStatus).toBe('abierta');
    await post(A.actor, `/work-orders/${wo}/start`);
    await post(A.actor, `/work-orders/${wo}/finish`);
    const cancel = await post(A.actor, `/work-orders/${wo}/cancel`, { reason: 'x' });
    expect(cancel.status).toBe(409);
    expect(cancel.body.currentStatus).toBe('terminada');
    expect((await get(A.actor, `/work-orders/${wo}`)).body.status).toBe('terminada');
  });

  it('[US2-AC4] nota visible en detalle; 409 en OT entregada', async () => {
    const wo = await createWo(A);
    const res = await post(A.actor, `/work-orders/${wo}/notes`, { body: 'cambiadas las pastillas' });
    expect(res.status).toBe(201);
    const detail = await get(A.actor, `/work-orders/${wo}`);
    expect(detail.body.notes).toHaveLength(1);
    expect(detail.body.notes[0]).toMatchObject({
      body: 'cambiadas las pastillas',
      createdBy: { id: A.actor.userId },
    });
    for (const a of ['start', 'finish', 'deliver']) await post(A.actor, `/work-orders/${wo}/${a}`);
    expect((await post(A.actor, `/work-orders/${wo}/notes`, { body: 'tarde' })).status).toBe(409);
  });
});

describe('Consulta (T006, US3)', () => {
  it('[US3-AC1] filtro por estado, detalle y lista por vehiculo', async () => {
    const first = await createWo(A);
    await post(A.actor, `/work-orders/${first}/cancel`, { reason: 'x' });
    const second = await createWo(A);
    await post(A.actor, `/work-orders/${second}/start`);
    const third = await createWo(A, await newCheckin(A.actor, A.vehicleId));
    await post(A.actor, `/work-orders/${third}/start`);
    const open = await createWo(A, await newCheckin(A.actor, A.vehicleId));

    const board = await get(A.actor, '/work-orders?status=en_proceso');
    expect(board.status).toBe(200);
    expect(ids(board.body)).toEqual([third, second]);
    expect(board.body[0]).toMatchObject({
      number: 3,
      status: 'en_proceso',
      plate: 'PBA1234',
      assignee: { id: A.actor.userId },
    });

    const detail = await get(A.actor, `/work-orders/${second}`);
    expect(detail.body.items).toHaveLength(2);
    expect(detail.body.history).toHaveLength(2);
    expect(detail.body.notes).toEqual([]);

    const byVehicle = await get(A.actor, `/vehicles/${A.vehicleId}/work-orders`);
    expect(byVehicle.status).toBe(200);
    expect(ids(byVehicle.body)).toEqual([open, third, second, first]);
  });

  it('[US3-AC2] tablero de A sin OT de B; 404 en vehiculo de B', async () => {
    const own = await createWo(A);
    await createWo(B);
    expect(ids((await get(A.actor, '/work-orders')).body)).toEqual([own]);
    expect((await get(A.actor, `/vehicles/${B.vehicleId}/work-orders`)).status).toBe(404);
  });
});
