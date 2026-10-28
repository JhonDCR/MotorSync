// T001, T002: Historial clínico consolidado por placa (feature 007).
// Contract: specs/007-historial-placa/contracts/openapi.yaml.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
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
const PASSWORD = 'Clave-Segura-123';

const STANDARD_LINES = {
  lines: [
    { kind: 'repuesto', description: 'pastillas de freno', quantity: '2', unitPrice: '18.50' },
    { kind: 'mano_obra', description: 'cambio de pastillas', quantity: '1', unitPrice: '25.00' },
  ],
};

interface Actor {
  token: string;
  userId: string;
  name: string;
}

interface Setup {
  tenant: TenantFixture;
  actor: Actor;
  clientId: string;
  clientDoc: string;
  clientName: string;
  vehicleId: string;
  vehiclePlate: string;
  initialMileage: number;
}

let app: INestApplication<App>;
let A: Setup;
let B: Setup;

const http = () => request(app.getHttpServer());
const get = (a: Actor, path: string) => http().get(`/api/v1${path}`).set(authHeader(a.token));
const post = (a: Actor, path: string, payload?: object) =>
  http().post(`/api/v1${path}`).set(authHeader(a.token)).send(payload);

const getHistory = (actor: Actor, vehicleId: string) =>
  get(actor, `/vehicles/${vehicleId}/history`);

async function createClient(
  actor: Actor,
  doc: string,
  firstNames = 'Carlos',
  lastNames = 'Ruiz',
  phone = '0987654321',
  documentType = 'passport',
): Promise<string> {
  const res = await post(actor, '/clients', {
    clientType: 'natural',
    documentType,
    documentNumber: doc,
    firstNames,
    lastNames,
    phone,
  });
  expect(res.status, 'POST /clients').toBe(201);
  return res.body.id as string;
}

async function createVehicle(
  actor: Actor,
  ownerClientId: string,
  plate: string,
  initialMileage = 45000,
): Promise<string> {
  const res = await post(actor, '/vehicles', {
    ownerClientId,
    plate,
    brand: 'Toyota',
    model: 'Corolla',
    year: 2020,
    color: 'Blanco',
    bodyType: 'sedan',
    initialMileage,
  });
  expect(res.status, 'POST /vehicles').toBe(201);
  return res.body.id as string;
}

async function newCheckin(
  actor: Actor,
  vehicleId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await post(actor, `/vehicles/${vehicleId}/checkins`, {
    mileage: 50000,
    fuelLevel: '1/2',
    reason: 'mantenimiento preventivo',
    inventory: ['gata', 'llanta de repuesto'],
    damages: [
      {
        view: 'izquierda',
        type: 'rayon',
        note: 'puerta delantera',
        photo: { mime: 'image/jpeg', base64: JPEG.toString('base64') },
      },
    ],
    signature: { mime: 'image/png', base64: PNG.toString('base64') },
    ...overrides,
  });
  expect(res.status, 'POST checkin').toBe(201);
  return res.body.id as string;
}

async function createBudget(
  actor: Actor,
  checkinId: string,
  payload: object = STANDARD_LINES,
): Promise<string> {
  const res = await post(actor, `/checkins/${checkinId}/budgets`, payload);
  expect(res.status, 'POST budget').toBe(201);
  return res.body.id as string;
}

async function approvedBudget(
  actor: Actor,
  checkinId: string,
  payload: object = STANDARD_LINES,
): Promise<string> {
  const id = await createBudget(actor, checkinId, payload);
  expect((await post(actor, `/budgets/${id}/send`)).status, 'POST /budgets/:id/send').toBe(200);
  expect((await post(actor, `/budgets/${id}/approve`)).status, 'POST /budgets/:id/approve').toBe(200);
  return id;
}

async function rejectedBudget(
  actor: Actor,
  checkinId: string,
  payload: object = STANDARD_LINES,
): Promise<string> {
  const id = await createBudget(actor, checkinId, payload);
  expect((await post(actor, `/budgets/${id}/send`)).status, 'POST /budgets/:id/send').toBe(200);
  expect((await post(actor, `/budgets/${id}/reject`)).status, 'POST /budgets/:id/reject').toBe(200);
  return id;
}

async function createWo(
  actor: Actor,
  checkinId: string,
  lines: object = STANDARD_LINES,
): Promise<{ woId: string; budgetId: string }> {
  const budgetId = await approvedBudget(actor, checkinId, lines);
  const res = await post(actor, `/budgets/${budgetId}/work-orders`);
  expect(res.status, 'POST work-order').toBe(201);
  return { woId: res.body.id as string, budgetId };
}

async function deliverWo(
  actor: Actor,
  checkinId: string,
  lines: object = STANDARD_LINES,
): Promise<{ woId: string; budgetId: string }> {
  const { woId, budgetId } = await createWo(actor, checkinId, lines);
  for (const action of ['start', 'finish', 'deliver']) {
    const res = await post(actor, `/work-orders/${woId}/${action}`);
    expect(res.status, `POST /work-orders/:id/${action}`).toBe(200);
  }
  return { woId, budgetId };
}

async function cancelWo(
  actor: Actor,
  checkinId: string,
  lines: object = STANDARD_LINES,
  reason = 'cliente cancela el servicio por viaje',
): Promise<{ woId: string; budgetId: string }> {
  const { woId, budgetId } = await createWo(actor, checkinId, lines);
  const res = await post(actor, `/work-orders/${woId}/cancel`, { reason });
  expect(res.status, 'POST cancel work-order').toBe(200);
  return { woId, budgetId };
}

async function transferOwnership(
  actor: Actor,
  vehicleId: string,
  newOwnerClientId: string,
  reason = 'Venta del vehículo a nuevo propietario',
): Promise<void> {
  const vehicle = await get(actor, `/vehicles/${vehicleId}`);
  expect(vehicle.status, 'GET vehicle before transfer').toBe(200);
  const version = vehicle.body.version;
  const res = await post(actor, `/vehicles/${vehicleId}/ownership-transfers`, {
    newOwnerClientId,
    version,
    reason,
  });
  expect(res.status, 'POST ownership-transfers').toBe(200);
}

async function setup(label: string, doc: string, plate: string): Promise<Setup> {
  const tenant = await createTenant(`Taller ${label} hist ${randomUUID()}`);
  const email = `asesor-${label.toLowerCase()}-${randomUUID()}@hist.test`;
  const name = `Asesor ${label}`;
  const user = await createUser({
    tenantId: tenant.id,
    name,
    email,
    role: 'asesor',
    password: PASSWORD,
  });
  const { accessToken } = await loginAs(app, email, PASSWORD);
  const actor = { token: accessToken, userId: user.id, name };
  const firstNames = `Ana${label}`;
  const lastNames = `Pérez${label}`;
  const client = await post(actor, '/clients', {
    clientType: 'natural',
    documentType: 'passport',
    documentNumber: doc,
    firstNames,
    lastNames,
    phone: '0991234567',
  });
  expect(client.status, 'POST /clients').toBe(201);
  const clientId = client.body.id as string;
  const initialMileage = 45000;

  const vehicleId = await createVehicle(actor, clientId, plate, initialMileage);

  return {
    tenant,
    actor,
    clientId,
    clientDoc: doc,
    clientName: `${firstNames} ${lastNames}`,
    vehicleId,
    vehiclePlate: plate,
    initialMileage,
  };
}

beforeAll(async () => {
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
  await truncateBusinessTables();
  await closeFixtures();
});

describe('Historial clínico consolidado (T001, US1)', () => {
  it('[US1-AC1] 200 con timeline cronológico unificado (más reciente primero) combinando check-ins, presupuestos, OT y transferencias de propietario', async () => {
    const checkinId = await newCheckin(A.actor, A.vehicleId, { mileage: 50000 });
    await deliverWo(A.actor, checkinId);
    const newOwnerId = await createClient(A.actor, 'PASS171234', 'Carlos', 'Ruiz');
    await transferOwnership(A.actor, A.vehicleId, newOwnerId, 'Transferencia por venta notariada');

    const res = await getHistory(A.actor, A.vehicleId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('vehicle');
    expect(res.body).toHaveProperty('owner');
    expect(res.body).toHaveProperty('metrics');
    expect(res.body).toHaveProperty('timeline');

    const timeline = res.body.timeline;
    expect(timeline).toBeInstanceOf(Array);
    expect(timeline).toHaveLength(4);

    const kinds = timeline.map((e: { kind: string }) => e.kind);
    expect(new Set(kinds)).toEqual(new Set(['checkin', 'budget', 'work_order', 'ownership_transfer']));

    for (let i = 0; i < timeline.length - 1; i++) {
      const cur = new Date(timeline[i].occurredAt).getTime();
      const next = new Date(timeline[i + 1].occurredAt).getTime();
      expect(cur).toBeGreaterThanOrEqual(next);
    }

    for (const event of timeline) {
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('kind');
      expect(event).toHaveProperty('occurredAt');
      expect(event).toHaveProperty('summary');
      expect(event).toHaveProperty('data');
    }
  });

  it('[US1-AC2] validación de payload y metadatos por cada tipo de evento (checkin, budget, work_order, ownership_transfer)', async () => {
    const checkinId = await newCheckin(A.actor, A.vehicleId, { mileage: 50000 });
    const budgetId = await approvedBudget(A.actor, checkinId, STANDARD_LINES);
    const woRes = await post(A.actor, `/budgets/${budgetId}/work-orders`);
    expect(woRes.status).toBe(201);
    const woId = woRes.body.id as string;

    await post(A.actor, `/work-orders/${woId}/start`);
    await post(A.actor, `/work-orders/${woId}/notes`, { body: 'Iniciando cambio de pastillas' });
    await post(A.actor, `/work-orders/${woId}/finish`);
    await post(A.actor, `/work-orders/${woId}/deliver`);

    const newOwnerId = await createClient(A.actor, 'PASS171234', 'Carlos', 'Ruiz');
    await transferOwnership(A.actor, A.vehicleId, newOwnerId, 'Transferencia por compraventa legal');

    const res = await getHistory(A.actor, A.vehicleId);
    expect(res.status).toBe(200);

    const checkinEv = res.body.timeline.find((e: { kind: string }) => e.kind === 'checkin');
    expect(checkinEv).toBeDefined();
    expect(checkinEv.id).toBe(checkinId);
    expect(checkinEv.occurredAt).toBeTruthy();
    expect(checkinEv.summary).toBeTruthy();
    expect(checkinEv.data).toMatchObject({
      mileage: 50000,
      fuelLevel: '1/2',
      hasInventory: true,
    });
    const damagesCount = checkinEv.data.damagesCount ?? checkinEv.data.damageCount;
    expect(damagesCount).toBe(1);
    const photosCount = checkinEv.data.photosCount ?? checkinEv.data.photoCount;
    expect(photosCount).toBeGreaterThanOrEqual(1);
    const authorName = checkinEv.data.authorName ?? checkinEv.data.createdByName;
    expect(authorName).toBe(A.actor.name);

    const budgetEv = res.body.timeline.find((e: { kind: string }) => e.kind === 'budget');
    expect(budgetEv).toBeDefined();
    expect(budgetEv.id).toBe(budgetId);
    expect(budgetEv.occurredAt).toBeTruthy();
    expect(budgetEv.summary).toBeTruthy();
    expect(budgetEv.data).toMatchObject({
      checkinId,
      number: 1,
      status: 'aprobado',
      subtotal: '62.00',
      tax: '9.30',
      total: '71.30',
    });
    const linesCount = budgetEv.data.linesCount ?? budgetEv.data.lineCount ?? budgetEv.data.itemsCount;
    expect(linesCount).toBe(2);

    const woEv = res.body.timeline.find((e: { kind: string }) => e.kind === 'work_order');
    expect(woEv).toBeDefined();
    expect(woEv.id).toBe(woId);
    expect(woEv.occurredAt).toBeTruthy();
    expect(woEv.summary).toBeTruthy();
    expect(woEv.data).toMatchObject({
      budgetId,
      checkinId,
      number: 1,
      status: 'entregada',
      itemsCount: 2,
      notesCount: 1,
    });
    expect(woEv.data.deliveredAt).toBeTruthy();
    const assignee = woEv.data.assigneeName ?? woEv.data.assignee?.name ?? woEv.data.assignee;
    expect(assignee).toBeTruthy();

    const transferEv = res.body.timeline.find((e: { kind: string }) => e.kind === 'ownership_transfer');
    expect(transferEv).toBeDefined();
    expect(transferEv.occurredAt).toBeTruthy();
    expect(transferEv.summary).toBeTruthy();
    expect(transferEv.data.previousOwner).toMatchObject({
      displayName: A.clientName,
      documentNumber: A.clientDoc,
    });
    expect(transferEv.data.newOwner).toMatchObject({
      displayName: 'Carlos Ruiz',
      documentNumber: 'PASS171234',
    });
    expect(transferEv.data.reason).toBe('Transferencia por compraventa legal');
    const transferredBy = transferEv.data.transferredBy ?? transferEv.data.actorName ?? transferEv.data.userName;
    expect(transferredBy).toBe(A.actor.name);
  });

  it('[US1-AC3] vehículo sin eventos devuelve timeline vacío y métricas basadas en odómetro inicial', async () => {
    const clientId = await createClient(A.actor, 'PASS992233', 'Elena', 'Viteri', '0990001122');
    const vehicleId = await createVehicle(A.actor, clientId, 'PCX9988', 32000);

    const res = await getHistory(A.actor, vehicleId);
    expect(res.status).toBe(200);
    expect(res.body.vehicle).toMatchObject({
      id: vehicleId,
      plate: 'PCX9988',
      brand: 'Toyota',
      model: 'Corolla',
      year: 2020,
      color: 'Blanco',
      bodyType: 'sedan',
      initialMileage: 32000,
    });
    expect(res.body.owner).toMatchObject({
      id: clientId,
      displayName: 'Elena Viteri',
      documentType: 'passport',
      documentNumber: 'PASS992233',
      phone: '0990001122',
    });
    expect(res.body.metrics).toMatchObject({
      currentMileage: 32000,
      mileageDelta: 0,
      totalCheckins: 0,
      totalWorkOrders: 0,
      totalDeliveredWorkOrders: 0,
      totalInvested: '0.00',
      lastVisitAt: null,
    });
    expect(res.body.timeline).toEqual([]);
  });

  it('[US1-AC4] aislamiento multi-tenant: usuario del taller A consultando vehículo del taller B recibe 404 (exactamente igual que inexistente)', async () => {
    const resOwn = await getHistory(A.actor, A.vehicleId);
    expect(resOwn.status).toBe(200);

    const resForeign = await getHistory(A.actor, B.vehicleId);
    expect(resForeign.status).toBe(404);

    const resNotFound = await getHistory(A.actor, randomUUID());
    expect(resNotFound.status).toBe(404);

    expect(resForeign.body.status).toBe(404);
    expect(resNotFound.body.status).toBe(404);
  });
});

describe('Resumen clínico y métricas (T002, US2)', () => {
  it('[US2-AC1] currentMileage calcula el valor máximo entre odómetro inicial y check-ins, y calcula mileageDelta', async () => {
    // Initial mileage = 45000
    await newCheckin(A.actor, A.vehicleId, { mileage: 48000 });
    await newCheckin(A.actor, A.vehicleId, { mileage: 52000 });
    await newCheckin(A.actor, A.vehicleId, { mileage: 56000 });

    const res = await getHistory(A.actor, A.vehicleId);
    expect(res.status).toBe(200);
    expect(res.body.metrics.currentMileage).toBe(56000);
    expect(res.body.metrics.mileageDelta).toBe(11000); // 56000 - 45000
  });

  it('[US2-AC2] conteos precisos de totalCheckins, totalWorkOrders y totalDeliveredWorkOrders', async () => {
    const ch1 = await newCheckin(A.actor, A.vehicleId, { mileage: 46000 });
    await deliverWo(A.actor, ch1);

    const ch2 = await newCheckin(A.actor, A.vehicleId, { mileage: 47000 });
    await createWo(A.actor, ch2); // Remains 'abierta'

    await newCheckin(A.actor, A.vehicleId, { mileage: 48000 }); // Only check-in

    const res = await getHistory(A.actor, A.vehicleId);
    expect(res.status).toBe(200);
    expect(res.body.metrics.totalCheckins).toBe(3);
    expect(res.body.metrics.totalWorkOrders).toBe(2);
    expect(res.body.metrics.totalDeliveredWorkOrders).toBe(1);
  });

  it('[US2-AC3] totalInvested suma exactamente los presupuestos de OT entregada (ignora canceladas, borradores o rechazados)', async () => {
    const clientId = await createClient(A.actor, 'PASS110022', 'Mario', 'Bros');
    const vehicleId = await createVehicle(A.actor, clientId, 'MBR1234', 20000);

    // 1. OT entregada: subtotal $100.00 + 15% IVA ($15.00) = $115.00
    const ch1 = await newCheckin(A.actor, vehicleId, { mileage: 21000 });
    await deliverWo(A.actor, ch1, {
      lines: [{ kind: 'repuesto', description: 'bomba de agua', quantity: '1', unitPrice: '100.00' }],
    });

    // 2. OT entregada: subtotal $200.00 + 15% IVA ($30.00) = $230.00
    const ch2 = await newCheckin(A.actor, vehicleId, { mileage: 22000 });
    await deliverWo(A.actor, ch2, {
      lines: [{ kind: 'mano_obra', description: 'reparación motor', quantity: '1', unitPrice: '200.00' }],
    });

    // 3. OT cancelada: subtotal $80.00 + 15% IVA ($12.00) = $92.00 (debe ignorarse)
    const ch3 = await newCheckin(A.actor, vehicleId, { mileage: 23000 });
    await cancelWo(A.actor, ch3, {
      lines: [{ kind: 'repuesto', description: 'filtro de aire', quantity: '1', unitPrice: '80.00' }],
    });

    // 4. Presupuesto borrador: subtotal $50.00 + 15% IVA ($7.50) = $57.50 (debe ignorarse)
    const ch4 = await newCheckin(A.actor, vehicleId, { mileage: 24000 });
    await createBudget(A.actor, ch4, {
      lines: [{ kind: 'mano_obra', description: 'alineación', quantity: '1', unitPrice: '50.00' }],
    });

    // 5. Presupuesto rechazado: subtotal $300.00 + 15% IVA ($45.00) = $345.00 (debe ignorarse)
    const ch5 = await newCheckin(A.actor, vehicleId, { mileage: 25000 });
    await rejectedBudget(A.actor, ch5, {
      lines: [{ kind: 'repuesto', description: 'embrague', quantity: '1', unitPrice: '300.00' }],
    });

    const res = await getHistory(A.actor, vehicleId);
    expect(res.status).toBe(200);
    // Solo suma 115.00 + 230.00 = 345.00
    expect(res.body.metrics.totalInvested).toBe('345.00');
  });

  it('[US2-AC4] lastVisitAt con la fecha más reciente de intervención y datos del propietario actual', async () => {
    await newCheckin(A.actor, A.vehicleId, { mileage: 46000 });

    const newOwnerId = await createClient(A.actor, 'PASS887766', 'Carlos', 'Ruiz', '0987654321');
    await transferOwnership(A.actor, A.vehicleId, newOwnerId, 'Venta notariada a Carlos');

    await newCheckin(A.actor, A.vehicleId, { mileage: 49000 });

    const res = await getHistory(A.actor, A.vehicleId);
    expect(res.status).toBe(200);
    expect(res.body.owner).toMatchObject({
      id: newOwnerId,
      displayName: 'Carlos Ruiz',
      documentNumber: 'PASS887766',
      phone: '0987654321',
    });
    expect(res.body.metrics.lastVisitAt).toBeTruthy();
    expect(new Date(res.body.metrics.lastVisitAt).getTime()).toBeGreaterThan(0);
  });
});
