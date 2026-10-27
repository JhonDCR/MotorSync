// T001, T003, T009: check-in 360 (feature 004) over AppModule and the real PostgreSQL.
// Contract: specs/004-checkin-360/contracts/openapi.yaml. Actors are real users with a 002 session
// (created_by references users).
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
  truncateBusinessTables,
  type TenantFixture,
} from './setup/db-fixtures.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
const img = (buf: Buffer, mime = 'image/jpeg') => ({ mime, base64: buf.toString('base64') });
const CHECKIN_TABLES = ['checkins', 'checkin_damages', 'checkin_images'];
const PASSWORD = 'Clave-Segura-123';

interface Actor {
  token: string;
  userId: string;
  name: string;
}
interface Setup {
  tenant: TenantFixture;
  actor: Actor;
  clientId: string;
  vehicleId: string;
}
interface Checkin {
  id: string;
  signatureImageId: string;
  damages: { photoImageId: string | null }[];
}

let app: INestApplication<App>;
let appPool: pg.Pool;
let A: Setup;
let B: Setup;

const http = () => request(app.getHttpServer());

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mileage: 85000,
    fuelLevel: '1/2',
    reason: 'ruido al frenar',
    inventory: ['gata', 'llanta de emergencia'],
    damages: [{ view: 'izquierda', type: 'rayon', note: 'puerta trasera', photo: img(JPEG) }],
    signature: img(PNG, 'image/png'),
    ...overrides,
  };
}

function postCheckin(actor: Actor, vehicleId: string, payload = body()) {
  return http()
    .post(`/api/v1/vehicles/${vehicleId}/checkins`)
    .set(authHeader(actor.token))
    .send(payload);
}

async function setup(label: string, doc: string, plate: string): Promise<Setup> {
  const tenant = await createTenant(`Taller ${label} checkins ${randomUUID()}`);
  const email = `asesor-${label.toLowerCase()}-${randomUUID()}@checkins.test`;
  const user = await createUser({
    tenantId: tenant.id,
    name: `Asesor ${label}`,
    email,
    role: 'asesor',
    password: PASSWORD,
  });
  const { accessToken } = await loginAs(app, email, PASSWORD);
  const actor = { token: accessToken, userId: user.id, name: user.name };
  const client = await http().post('/api/v1/clients').set(authHeader(accessToken)).send({
    clientType: 'natural',
    documentType: 'passport',
    documentNumber: doc,
    firstNames: 'Ana',
    lastNames: 'Pérez',
    phone: '0991234567',
  });
  expect(client.status, 'POST /clients').toBe(201);
  const vehicle = await http().post('/api/v1/vehicles').set(authHeader(accessToken)).send({
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
  return { tenant, actor, clientId: client.body.id as string, vehicleId: vehicle.body.id as string };
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

const countAs = (tenantId: string | null, table: string) =>
  asApp(tenantId, async (c) => Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n));

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
  beforeEach(async () => {
    expect((await postCheckin(A.actor, A.vehicleId)).status).toBe(201);
    expect((await postCheckin(B.actor, B.vehicleId)).status).toBe(201);
  });

  it('[US2-AC2] motorsync_app sin tenant ve 0 filas en las tres tablas', async () => {
    for (const t of CHECKIN_TABLES) expect(await countAs(null, t), t).toBe(0);
  });

  it('[US2-AC2] con tenant A no se ven filas de B', async () => {
    for (const t of CHECKIN_TABLES) {
      const rows = await asApp(A.tenant.id, async (c) => (await c.query(`SELECT tenant_id FROM ${t}`)).rows);
      expect(rows.length, t).toBeGreaterThan(0);
      expect(rows.every((r) => r.tenant_id === A.tenant.id), t).toBe(true);
    }
  });

  it('[US2-AC3] UPDATE y DELETE sobre checkins fallan por permisos', async () => {
    for (const sql of ['UPDATE checkins SET mileage = 0', 'DELETE FROM checkins']) {
      const err = await asApp(A.tenant.id, (c) =>
        c.query(sql).then(
          () => null,
          (e: { code?: string }) => e,
        ),
      );
      expect(err?.code, sql).toBe('42501');
    }
  });
});

describe('POST /vehicles/{id}/checkins (T003, US1)', () => {
  it('[US1-AC1] crea con número correlativo, autor y propietario vigente', async () => {
    const first = await postCheckin(A.actor, A.vehicleId);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      number: 1,
      vehicleId: A.vehicleId,
      ownerClientId: A.clientId,
      createdByName: A.actor.name,
      mileage: 85000,
      fuelLevel: '1/2',
      reason: 'ruido al frenar',
      inventory: ['gata', 'llanta de emergencia'],
      damageCount: 1,
      damages: [
        expect.objectContaining({
          view: 'izquierda',
          type: 'rayon',
          note: 'puerta trasera',
          photoImageId: expect.any(String),
        }),
      ],
      signatureImageId: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(first.body.createdAt))).toBe(false);
    const second = await postCheckin(A.actor, A.vehicleId, body({ mileage: 86000 }));
    expect(second.status).toBe(201);
    expect(second.body.number).toBe(2);
    const author = await asApp(A.tenant.id, async (c) =>
      (await c.query('SELECT created_by FROM checkins WHERE id = $1', [first.body.id])).rows[0],
    );
    expect(author.created_by).toBe(A.actor.userId);
  });

  it.each([
    ['sin firma', body({ signature: undefined })],
    ['mileage -1', body({ mileage: -1 })],
    ['fuelLevel inválido', body({ fuelLevel: 'medio' })],
    ['view inválida', body({ damages: [{ view: 'techo', type: 'rayon' }] })],
  ])('[US1-AC2] 400 %s y no crea nada', async (_label, payload) => {
    const res = await postCheckin(A.actor, A.vehicleId, payload);
    expect(res.status).toBe(400);
    expect(await countAs(A.tenant.id, 'checkins')).toBe(0);
  });

  it('[US1-AC3] 409 con lastMileage si el kilometraje es menor al último', async () => {
    expect((await postCheckin(A.actor, A.vehicleId)).status).toBe(201);
    const res = await postCheckin(A.actor, A.vehicleId, body({ mileage: 80000 }));
    expect(res.status).toBe(409);
    expect(res.body.lastMileage).toBe(85000);
    expect(await countAs(A.tenant.id, 'checkins')).toBe(1);
  });

  it.each([
    ['no JPEG/PNG por magic bytes', img(Buffer.from('GIF89a-not-an-image'))],
    ['mayor a 1 MB', img(Buffer.concat([JPEG, Buffer.alloc(1_048_576)]))],
  ])('[US1-AC4] 400 foto %s y no crea nada', async (_label, photo) => {
    const res = await postCheckin(
      A.actor,
      A.vehicleId,
      body({ damages: [{ view: 'frente', type: 'golpe', photo }] }),
    );
    expect(res.status).toBe(400);
    for (const t of CHECKIN_TABLES) expect(await countAs(A.tenant.id, t), t).toBe(0);
  });

  it('[US1-AC5] 404 para vehículo de B o inexistente; nada creado en ningún taller', async () => {
    expect((await postCheckin(A.actor, B.vehicleId)).status).toBe(404);
    expect((await postCheckin(A.actor, randomUUID())).status).toBe(404);
    expect(await countAs(A.tenant.id, 'checkins')).toBe(0);
    expect(await countAs(B.tenant.id, 'checkins')).toBe(0);
  });
});

describe('Consulta de check-ins (T009, US2)', () => {
  let a1: Checkin;
  let a2: Checkin;
  let b1: Checkin;

  beforeEach(async () => {
    a1 = (await postCheckin(A.actor, A.vehicleId)).body;
    a2 = (await postCheckin(A.actor, A.vehicleId, body({ mileage: 90000, damages: [] }))).body;
    b1 = (await postCheckin(B.actor, B.vehicleId)).body;
  });

  const get = (actor: Actor, path: string) =>
    http().get(`/api/v1${path}`).set(authHeader(actor.token));

  it('[US2-AC1] lista desc con damageCount, detalle completo e imagen con los mismos bytes', async () => {
    const list = await get(A.actor, `/vehicles/${A.vehicleId}/checkins`);
    expect(list.status).toBe(200);
    expect(list.body.map((c: Checkin) => c.id)).toEqual([a2.id, a1.id]);
    expect(list.body[0]).toMatchObject({ number: 2, mileage: 90000, damageCount: 0, createdByName: A.actor.name });
    expect(list.body[1]).toMatchObject({ number: 1, damageCount: 1, reason: 'ruido al frenar' });

    const detail = await get(A.actor, `/checkins/${a1.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toEqual(a1);

    const sig = await get(A.actor, `/checkins/${a1.id}/images/${a1.signatureImageId}`).buffer(true);
    expect(sig.status).toBe(200);
    expect(sig.headers['content-type']).toMatch(/^image\/png/);
    expect(Buffer.compare(sig.body as Buffer, PNG)).toBe(0);
    const photo = await get(A.actor, `/checkins/${a1.id}/images/${a1.damages[0].photoImageId}`).buffer(true);
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(Buffer.compare(photo.body as Buffer, JPEG)).toBe(0);
  });

  it('[US2-AC2] 404 en lista, detalle e imagen de B; la lista de A no incluye B', async () => {
    expect((await get(A.actor, `/vehicles/${B.vehicleId}/checkins`)).status).toBe(404);
    expect((await get(A.actor, `/checkins/${b1.id}`)).status).toBe(404);
    expect((await get(A.actor, `/checkins/${b1.id}/images/${b1.signatureImageId}`)).status).toBe(404);
    const list = await get(A.actor, `/vehicles/${A.vehicleId}/checkins`);
    expect(list.body.map((c: Checkin) => c.id)).not.toContain(b1.id);
  });

  it('[US2-AC3] PUT, PATCH y DELETE /checkins/{id} responden 404', async () => {
    const path = `/api/v1/checkins/${a1.id}`;
    const auth = authHeader(A.actor.token);
    expect((await http().put(path).set(auth).send(body())).status).toBe(404);
    expect((await http().patch(path).set(auth).send({ mileage: 1 })).status).toBe(404);
    expect((await http().delete(path).set(auth)).status).toBe(404);
    expect((await get(A.actor, `/checkins/${a1.id}`)).body).toEqual(a1);
  });
});
