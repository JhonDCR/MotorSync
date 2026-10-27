// T001, T005, T006, T008: presupuestos (feature 005) over AppModule and the real PostgreSQL.
// Contract: specs/005-presupuestos/contracts/openapi.yaml.
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
const TABLES = ['budgets', 'budget_lines'];
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
let A: Setup;
let B: Setup;

const http = () => request(app.getHttpServer());
const get = (a: Actor, path: string) => http().get(`/api/v1${path}`).set(authHeader(a.token));
const post = (a: Actor, path: string, payload?: object) =>
  http().post(`/api/v1${path}`).set(authHeader(a.token)).send(payload);
const put = (a: Actor, path: string, payload: object) =>
  http().put(`/api/v1${path}`).set(authHeader(a.token)).send(payload);
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

async function setup(label: string, doc: string, plate: string): Promise<Setup> {
  const tenant = await createTenant(`Taller ${label} budgets ${randomUUID()}`);
  const email = `asesor-${label.toLowerCase()}-${randomUUID()}@budgets.test`;
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

/** Runs fn as motorsync_app with the tenant pinned (or not) and always rolls back. */
async function asApp<T>(tenantId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await appPool.connect();
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

const sqlError = (tenantId: string, sql: string, params: unknown[] = []) =>
  asApp(tenantId, (c) =>
    c.query(sql, params).then(
      () => null,
      (e: { code?: string; message?: string }) => e,
    ),
  );

beforeAll(async () => {
  appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
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
  await truncateBusinessTables();
  await closeFixtures();
});

describe('db (T001)', () => {
  let budgetA: string;
  beforeEach(async () => {
    budgetA = await createBudget(A);
    await createBudget(B);
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
      expect(rows.every((r) => r.tenant_id === A.tenant.id), t).toBe(true);
    }
  });

  it('[US3-AC2] DELETE sobre budgets falla por permisos', async () => {
    expect((await sqlError(A.tenant.id, 'DELETE FROM budgets'))?.code).toBe('42501');
  });

  it('[US2-AC2] insertar una linea en un presupuesto enviado falla por el trigger', async () => {
    expect((await post(A.actor, `/budgets/${budgetA}/send`)).status).toBe(200);
    const err = await sqlError(
      A.tenant.id,
      `INSERT INTO budget_lines (tenant_id, budget_id, position, kind, description, quantity, unit_price, line_total)
       VALUES ($1, $2, 9, 'repuesto', 'x', 1, 1, 1)`,
      [A.tenant.id, budgetA],
    );
    expect(err).not.toBeNull();
    expect(err?.code).not.toBe('42501');
    expect(err?.message).toMatch(/borrador|budget_lines_draft_only/i);
  });
});

describe('Borrador (T005, US1)', () => {
  it('[US1-AC1] crea con numero correlativo y montos calculados', async () => {
    const first = await post(A.actor, `/checkins/${A.checkinId}/budgets`, LINES);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      number: 1,
      status: 'borrador',
      checkinId: A.checkinId,
      vehicleId: A.vehicleId,
      taxRate: '0.1500',
      subtotal: '62.00',
      tax: '9.30',
      total: '71.30',
      createdBy: { id: A.actor.userId },
    });
    expect(first.body.lines.map((l: { lineTotal: string }) => l.lineTotal)).toEqual(['37.00', '25.00']);
    const second = await post(A.actor, `/checkins/${A.checkinId}/budgets`, LINES);
    expect(second.body.number).toBe(2);
  });

  it('[US1-AC2] PUT reemplaza lineas y recalcula', async () => {
    const id = await createBudget(A);
    const res = await put(A.actor, `/budgets/${id}`, {
      lines: [{ kind: 'mano_obra', description: 'diagnostico', quantity: '1', unitPrice: '10.00' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subtotal: '10.00', tax: '1.50', total: '11.50' });
    expect(res.body.lines).toHaveLength(1);
  });

  it('[US1-AC3] 400 con entradas invalidas', async () => {
    const line = LINES.lines[0];
    for (const payload of [
      { lines: [] },
      { lines: [{ ...line, quantity: '0' }] },
      { lines: [{ ...line, unitPrice: '1.234' }] },
      { lines: [{ ...line, kind: 'otro' }] },
    ]) {
      const res = await post(A.actor, `/checkins/${A.checkinId}/budgets`, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
    }
    expect((await get(A.actor, `/checkins/${A.checkinId}/budgets`)).body).toEqual([]);
  });

  it('[US1-AC4] 404 con recursos de B y nada cambia en B', async () => {
    const budgetB = await createBudget(B);
    expect((await post(A.actor, `/checkins/${B.checkinId}/budgets`, LINES)).status).toBe(404);
    expect((await get(A.actor, `/budgets/${budgetB}`)).status).toBe(404);
    expect((await put(A.actor, `/budgets/${budgetB}`, { lines: [LINES.lines[0]] })).status).toBe(404);
    const inB = await get(B.actor, `/budgets/${budgetB}`);
    expect(inB.body).toMatchObject({ total: '71.30', status: 'borrador' });
    expect(inB.body.lines).toHaveLength(2);
    expect((await get(B.actor, `/checkins/${B.checkinId}/budgets`)).body).toHaveLength(1);
  });
});

describe('Envio y decision (T006, US2)', () => {
  it.each([
    ['approve', 'aprobado', 'budget.approved'],
    ['reject', 'rechazado', 'budget.rejected'],
  ])('[US2-AC1] send -> %s deja %s y audita', async (action, status, auditAction) => {
    const id = await createBudget(A);
    const sent = await post(A.actor, `/budgets/${id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('enviado');
    expect(sent.body.sentAt).toBeTruthy();
    const res = await post(A.actor, `/budgets/${id}/${action}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(status);
    expect(res.body.decidedBy).toMatchObject({ id: A.actor.userId });
    expect(res.body.decidedAt).toBeTruthy();
    const audit = (await readAuditLog(A.tenant.id, id)).filter((r) => r.action === auditAction);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: A.actor.userId,
      before: { status: 'enviado' },
      after: { status },
    });
  });

  it('[US2-AC2] 409 con currentStatus en transiciones no permitidas', async () => {
    const sentId = await createBudget(A);
    expect((await post(A.actor, `/budgets/${sentId}/send`)).status).toBe(200);
    const edit = await put(A.actor, `/budgets/${sentId}`, LINES);
    expect(edit.status).toBe(409);
    expect(edit.body.currentStatus).toBe('enviado');

    const draftId = await createBudget(A);
    const approve = await post(A.actor, `/budgets/${draftId}/approve`);
    expect(approve.status).toBe(409);
    expect(approve.body.currentStatus).toBe('borrador');

    expect((await post(A.actor, `/budgets/${sentId}/approve`)).status).toBe(200);
    const reject = await post(A.actor, `/budgets/${sentId}/reject`);
    expect(reject.status).toBe(409);
    expect(reject.body.currentStatus).toBe('aprobado');
  });
});

describe('Consulta (T008, US3)', () => {
  it('[US3-AC1] listas por vehiculo y check-in, y detalle con lineas', async () => {
    const first = await createBudget(A);
    const otherCheckin = await newCheckin(A.actor, A.vehicleId);
    const second = await createBudget(A, otherCheckin);

    const byVehicle = await get(A.actor, `/vehicles/${A.vehicleId}/budgets`);
    expect(byVehicle.status).toBe(200);
    expect(ids(byVehicle.body)).toEqual([second, first]);
    expect(byVehicle.body[0]).toMatchObject({ number: 2, status: 'borrador', total: '71.30' });

    expect(ids((await get(A.actor, `/checkins/${otherCheckin}/budgets`)).body)).toEqual([second]);

    const detail = await get(A.actor, `/budgets/${first}`);
    expect(detail.status).toBe(200);
    expect(detail.body.lines).toHaveLength(2);
  });

  it('[US3-AC2] 404 en listas de B y listas de A sin filas de B', async () => {
    const own = await createBudget(A);
    await createBudget(B);
    expect((await get(A.actor, `/vehicles/${B.vehicleId}/budgets`)).status).toBe(404);
    expect((await get(A.actor, `/checkins/${B.checkinId}/budgets`)).status).toBe(404);
    expect(ids((await get(A.actor, `/vehicles/${A.vehicleId}/budgets`)).body)).toEqual([own]);
    expect(ids((await get(A.actor, `/checkins/${A.checkinId}/budgets`)).body)).toEqual([own]);
  });
});
