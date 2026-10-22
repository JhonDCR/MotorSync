// T072: e2e of the vehicle ownership transfer and its history (US4-AC7 to US4-AC10, US4-AC13 to
// US4-AC16, edge case SAME_OWNER, FR-019, FR-020) over the full app wiring (AppModule +
// configureApp) and the real PostgreSQL, the API connecting as motorsync_app.
// Contract: POST /api/v1/vehicles/{vehicleId}/ownership-transfers (OwnershipTransferRequest →
// VehicleDetail), GET /api/v1/vehicles/{vehicleId}/ownership-history ({ items: OwnershipChange[] }),
// Problem (CLIENT_NOT_FOUND, NOT_FOUND 404; VERSION_CONFLICT 409 with current; SAME_OWNER 422).
// Field codes (REASON_REQUIRED, REQUIRED, UNKNOWN_FIELD) travel in errors[].code with
// code = VALIDATION_ERROR. audit_log is read as motorsync_app with the tenant pinned (RLS).
// Every test builds its own tenants, clients and vehicles through the API (beforeEach).
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AuditService } from '../src/audit/audit.service.js';
import { authHeader, issueTestToken, type TestRole } from './setup/auth.js';
import {
  closeFixtures,
  createTenant,
  truncateBusinessTables,
  type TenantFixture,
} from './setup/db-fixtures.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Exact message of spec.md US4-AC15 (also US4-AC16 for admin). */
const REASON_REQUIRED_MESSAGE =
  'El motivo es obligatorio (entre 10 y 500 caracteres)';
const VALID_REASON = 'Venta del vehículo a Carlos Ruiz';

interface FieldErrorBody {
  field: string;
  code: string;
  message: string;
}

interface Actor {
  userId: string;
  name: string;
  role: TestRole;
  token: string;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  actor_user_id: string;
  actor_name: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  occurred_at: Date;
  occurred_at_type: string;
  ip: string | null;
  channel: string;
}

interface VehicleRow {
  id: string;
  tenant_id: string;
  owner_client_id: string;
  version: number;
}

type Json = Record<string, unknown>;

describe('Ownership transfers (e2e, T072, US4)', () => {
  let app: INestApplication<App>;
  let appPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let asesorA: Actor;
  let adminA: Actor;
  let asesorB: Actor;
  /** "Ana Pérez", client of A and current owner of vehicleA. */
  let ana: Json;
  /** "Carlos Ruiz", client of A. */
  let carlos: Json;
  /** "Diego Mora", client of A. */
  let diego: Json;
  /** "Beatriz Torres", client of B and owner of vehicleB. */
  let beatriz: Json;
  /** "Bruno Salazar", client of B. */
  let bruno: Json;
  /** PBA1234 of tenant A, owned by Ana (version 1). */
  let vehicleA: Json;
  /** PBA1234 of tenant B, owned by Beatriz (version 1). */
  let vehicleB: Json;

  function actorOf(tenant: TenantFixture, name: string, role: TestRole): Actor {
    const userId = randomUUID();
    return {
      userId,
      name,
      role,
      token: issueTestToken({ tenantId: tenant.id, userId, role, name }),
    };
  }

  function server(target: INestApplication<App> = app) {
    return request(target.getHttpServer());
  }

  function transfer(
    actor: Actor,
    vehicleId: string,
    body: Json,
    target: INestApplication<App> = app,
  ) {
    return server(target)
      .post(`/api/v1/vehicles/${vehicleId}/ownership-transfers`)
      .set(authHeader(actor.token))
      .send(body);
  }

  function history(actor: Actor, vehicleId: string) {
    return server()
      .get(`/api/v1/vehicles/${vehicleId}/ownership-history`)
      .set(authHeader(actor.token));
  }

  function getVehicle(actor: Actor, id: string) {
    return server()
      .get(`/api/v1/vehicles/${id}`)
      .set(authHeader(actor.token));
  }

  function getClient(actor: Actor, id: string) {
    return server().get(`/api/v1/clients/${id}`).set(authHeader(actor.token));
  }

  async function createClient(actor: Actor, body: Json): Promise<Json> {
    const res = await server()
      .post('/api/v1/clients')
      .set(authHeader(actor.token))
      .send(body);
    expect(res.status, 'client creation via POST /clients').toBe(201);
    return res.body as Json;
  }

  async function createVehicle(
    actor: Actor,
    ownerClientId: string,
    plate = 'PBA1234',
  ): Promise<Json> {
    const res = await server()
      .post('/api/v1/vehicles')
      .set(authHeader(actor.token))
      .send({
        ownerClientId,
        plate,
        brand: 'Toyota',
        model: 'Corolla',
        year: 2020,
        color: 'Blanco',
        bodyType: 'sedan',
        initialMileage: 45000,
      });
    expect(res.status, 'vehicle creation via POST /vehicles').toBe(201);
    return res.body as Json;
  }

  function naturalClient(
    documentType: string,
    documentNumber: string,
    firstNames: string,
    lastNames: string,
  ): Json {
    return {
      clientType: 'natural',
      documentType,
      documentNumber,
      firstNames,
      lastNames,
      phone: '0991234567',
    };
  }

  /** Body of a transfer of vehicleA to Carlos with the current version and a valid reason. */
  function toCarlos(overrides: Json = {}): Json {
    return {
      newOwnerClientId: carlos.id,
      version: vehicleA.version,
      reason: VALID_REASON,
      ...overrides,
    };
  }

  function fieldErrors(body: { errors?: FieldErrorBody[] }): FieldErrorBody[] {
    return Array.isArray(body.errors) ? body.errors : [];
  }

  function expectValidationError(
    res: request.Response,
    field: string,
    code?: string,
  ): FieldErrorBody {
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    const errors = fieldErrors(res.body as { errors?: FieldErrorBody[] });
    const expected = code ? { field, code } : { field };
    expect(errors).toEqual(
      expect.arrayContaining([expect.objectContaining(expected)]),
    );
    return errors.find(
      (error) => error.field === field && (!code || error.code === code),
    ) as FieldErrorBody;
  }

  function expectReasonRequired(res: request.Response): void {
    const error = expectValidationError(res, 'reason', 'REASON_REQUIRED');
    expect(error.message).toBe(REASON_REQUIRED_MESSAGE);
  }

  function expectProblem(
    res: request.Response,
    status: number,
    code: string,
  ): void {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status, code });
  }

  /** Runs a read as motorsync_app with the tenant pinned (as the API sees the data, under RLS). */
  async function asTenant<T extends pg.QueryResultRow>(
    tenantId: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const conn = await appPool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const result = await conn.query<T>(sql, params);
      await conn.query('ROLLBACK');
      return result.rows;
    } finally {
      conn.release();
    }
  }

  function auditRowsAs(tenantId: string): Promise<AuditRow[]> {
    return asTenant<AuditRow>(
      tenantId,
      `SELECT id, tenant_id, actor_user_id, actor_name, actor_role, action, entity_type,
              entity_id, before, after, reason, occurred_at,
              pg_typeof(occurred_at)::text AS occurred_at_type, ip, channel
         FROM audit_log
        ORDER BY occurred_at, id`,
    );
  }

  async function vehicleRowAs(
    tenantId: string,
    vehicleId: string,
  ): Promise<VehicleRow | undefined> {
    const rows = await asTenant<VehicleRow>(
      tenantId,
      'SELECT id, tenant_id, owner_client_id, version FROM vehicles WHERE id = $1',
      [vehicleId],
    );
    return rows[0];
  }

  /** vehicleA still belongs to Ana with version 1 and no audit exists in either tenant. */
  async function expectNothingChanged(): Promise<void> {
    expect(await vehicleRowAs(tenantA.id, vehicleA.id as string)).toMatchObject(
      { owner_client_id: ana.id, version: vehicleA.version },
    );
    expect(await vehicleRowAs(tenantB.id, vehicleB.id as string)).toMatchObject(
      { owner_client_id: beatriz.id, version: vehicleB.version },
    );
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    expect(await auditRowsAs(tenantB.id)).toHaveLength(0);
  }

  function snapshotOf(client: Json): Json {
    return {
      ownerClientId: client.id,
      ownerDisplayName: client.displayName,
      ownerDocumentNumber: client.documentNumber,
    };
  }

  function ownerSnapshotOf(client: Json): Json {
    return {
      clientId: client.id,
      displayName: client.displayName,
      documentNumber: client.documentNumber,
    };
  }

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString)
      throw new Error('DATABASE_URL is not set in the e2e environment');
    appPool = new pg.Pool({ connectionString, max: 2 });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    tenantA = await createTenant(`Taller A ownership e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B ownership e2e ${randomUUID()}`);
    asesorA = actorOf(tenantA, 'Ana Asesora', 'asesor');
    adminA = actorOf(tenantA, 'Alberto Admin', 'admin');
    asesorB = actorOf(tenantB, 'Bruno Asesor', 'asesor');

    ana = await createClient(
      asesorA,
      naturalClient('cedula', '1710034065', 'Ana', 'Pérez'),
    );
    carlos = await createClient(
      asesorA,
      naturalClient('passport', 'CR456789', 'Carlos', 'Ruiz'),
    );
    diego = await createClient(
      asesorA,
      naturalClient('passport', 'DM112233', 'Diego', 'Mora'),
    );
    beatriz = await createClient(
      asesorB,
      naturalClient('passport', 'BB998877', 'Beatriz', 'Torres'),
    );
    bruno = await createClient(
      asesorB,
      naturalClient('passport', 'BS554433', 'Bruno', 'Salazar'),
    );
    vehicleA = await createVehicle(asesorA, ana.id as string);
    vehicleB = await createVehicle(asesorB, beatriz.id as string);
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US4-AC7

  it('US4-AC7 el asesor transfiere PBA1234 de Ana a Carlos con motivo → 200 VehicleDetail con el nuevo owner', async () => {
    const res = await transfer(asesorA, vehicleA.id as string, toCarlos());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({
      id: vehicleA.id,
      plate: 'PBA1234',
      version: (vehicleA.version as number) + 1,
      updatedBy: asesorA.userId,
      updatedByName: 'Ana Asesora',
    });
    expect(res.body.owner).toEqual({
      id: carlos.id,
      clientType: 'natural',
      documentType: 'passport',
      documentNumber: 'CR456789',
      displayName: 'Carlos Ruiz',
      phone: '0991234567',
      email: null,
    });
    expect(res.body.updatedAt).toMatch(ISO_UTC_RE);
    expect(res.body).not.toHaveProperty('tenantId');
    expect(res.body).not.toHaveProperty('ownerClientId');
  });

  it('US4-AC7 tras la transferencia el vehículo sale de la ficha de Ana y aparece en la de Carlos, con un único propietario', async () => {
    const res = await transfer(asesorA, vehicleA.id as string, toCarlos());
    expect(res.status).toBe(200);

    const anaFile = await getClient(asesorA, ana.id as string);
    const carlosFile = await getClient(asesorA, carlos.id as string);
    const vehicleFile = await getVehicle(asesorA, vehicleA.id as string);

    expect(anaFile.status).toBe(200);
    expect(anaFile.body.vehicles).toEqual([]);
    expect(carlosFile.status).toBe(200);
    expect(carlosFile.body.vehicles).toEqual([
      expect.objectContaining({ id: vehicleA.id, plate: 'PBA1234' }),
    ]);
    expect(vehicleFile.body.owner).toMatchObject({
      id: carlos.id,
      displayName: 'Carlos Ruiz',
    });
    expect(await vehicleRowAs(tenantA.id, vehicleA.id as string)).toMatchObject(
      { owner_client_id: carlos.id, tenant_id: tenantA.id },
    );
  });

  // ---------------------------------------------------------------- US4-AC8

  it('US4-AC8 la transferencia deja exactamente un vehicle.owner_changed con taller, actor, rol, before, after, motivo, fecha UTC, ip y canal', async () => {
    const startedAt = Date.now();
    const res = await transfer(
      asesorA,
      vehicleA.id as string,
      toCarlos({ reason: `   ${VALID_REASON}  ` }),
    );
    const finishedAt = Date.now();
    expect(res.status).toBe(200);

    const rows = await auditRowsAs(tenantA.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.id).toMatch(UUID_RE);
    expect(row).toMatchObject({
      tenant_id: tenantA.id,
      actor_user_id: asesorA.userId,
      actor_name: 'Ana Asesora',
      actor_role: 'asesor',
      action: 'vehicle.owner_changed',
      entity_type: 'vehicle',
      entity_id: vehicleA.id,
      reason: VALID_REASON,
      channel: 'web',
    });
    expect(row.before).toEqual(snapshotOf(ana));
    expect(row.after).toEqual(snapshotOf(carlos));
    expect(row.before).toEqual({
      ownerClientId: ana.id,
      ownerDisplayName: 'Ana Pérez',
      ownerDocumentNumber: '1710034065',
    });
    expect(row.occurred_at_type).toBe('timestamp with time zone');
    expect(row.occurred_at.getTime()).toBeGreaterThanOrEqual(startedAt - 5_000);
    expect(row.occurred_at.getTime()).toBeLessThanOrEqual(finishedAt + 5_000);
    expect(typeof row.ip).toBe('string');
    expect((row.ip as string).length).toBeGreaterThan(0);
    expect(await auditRowsAs(tenantB.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- US4-AC9

  it('US4-AC9 cliente destino inexistente → 404 CLIENT_NOT_FOUND, el propietario no cambia y no hay auditoría', async () => {
    const res = await transfer(
      asesorA,
      vehicleA.id as string,
      toCarlos({ newOwnerClientId: randomUUID() }),
    );

    expectProblem(res, 404, 'CLIENT_NOT_FOUND');
    await expectNothingChanged();
    // Positive control: the endpoint exists and the same vehicle can be transferred.
    expect(
      (await transfer(asesorA, vehicleA.id as string, toCarlos())).status,
    ).toBe(200);
  });

  describe('con AuditService.record forzado a lanzar', () => {
    let failingApp: INestApplication<App>;
    const record = vi.fn(async () => {
      throw new Error('audit store unavailable (forced by T072)');
    });

    beforeAll(async () => {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(AuditService)
        .useValue({ record })
        .compile();
      failingApp = moduleFixture.createNestApplication();
      configureApp(failingApp);
      await failingApp.init();
    });

    afterAll(async () => {
      await failingApp?.close();
    });

    beforeEach(() => {
      record.mockClear();
    });

    it('US4-AC9 si la auditoría falla, la transferencia se revierte: 500 INTERNAL_ERROR, el propietario y la versión no cambian', async () => {
      const res = await transfer(
        asesorA,
        vehicleA.id as string,
        toCarlos(),
        failingApp,
      );

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'vehicle.owner_changed',
          entityType: 'vehicle',
          entityId: vehicleA.id,
        }),
      );
      expectProblem(res, 500, 'INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('audit store unavailable');
      await expectNothingChanged();
      const file = await getVehicle(asesorA, vehicleA.id as string);
      expect(file.body.owner).toMatchObject({ id: ana.id });
      const anaFile = await getClient(asesorA, ana.id as string);
      expect(anaFile.body.vehicles).toEqual([
        expect.objectContaining({ id: vehicleA.id }),
      ]);
    });
  });

  // ---------------------------------------------------------------- US4-AC10

  it('US4-AC10 el historial lista las transferencias del más reciente al más antiguo, con motivo cuando existe', async () => {
    const first = await transfer(asesorA, vehicleA.id as string, toCarlos());
    expect(first.status).toBe(200);
    const second = await transfer(adminA, vehicleA.id as string, {
      newOwnerClientId: diego.id,
      version: first.body.version,
    });
    expect(second.status).toBe(200);

    const res = await history(asesorA, vehicleA.id as string);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(Object.keys(res.body)).toEqual(['items']);
    expect(res.body.items).toHaveLength(2);
    const [latest, oldest] = res.body.items as Json[];
    expect(latest).toEqual({
      id: expect.stringMatching(UUID_RE),
      occurredAt: expect.stringMatching(ISO_UTC_RE),
      previousOwner: ownerSnapshotOf(carlos),
      newOwner: ownerSnapshotOf(diego),
      actorUserId: adminA.userId,
      actorName: 'Alberto Admin',
      actorRole: 'admin',
      reason: null,
    });
    expect(oldest).toEqual({
      id: expect.stringMatching(UUID_RE),
      occurredAt: expect.stringMatching(ISO_UTC_RE),
      previousOwner: {
        clientId: ana.id,
        displayName: 'Ana Pérez',
        documentNumber: '1710034065',
      },
      newOwner: ownerSnapshotOf(carlos),
      actorUserId: asesorA.userId,
      actorName: 'Ana Asesora',
      actorRole: 'asesor',
      reason: VALID_REASON,
    });
    expect(Date.parse(latest.occurredAt as string)).toBeGreaterThanOrEqual(
      Date.parse(oldest.occurredAt as string),
    );
    // The history is read from audit_log: same ids as the audit records.
    const auditIds = (await auditRowsAs(tenantA.id)).map((row) => row.id);
    expect([...auditIds].sort()).toEqual(
      [latest.id as string, oldest.id as string].sort(),
    );
  });

  it('US4-AC10 un vehículo sin transferencias tiene historial vacío y uno inexistente → 404 NOT_FOUND', async () => {
    const empty = await history(asesorA, vehicleA.id as string);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [] });

    const missing = await history(asesorA, randomUUID());
    expectProblem(missing, 404, 'NOT_FOUND');
  });

  it('US4-AC10 el historial no se puede editar ni borrar por la API: PUT, PATCH y DELETE → 404 sin cambios', async () => {
    const done = await transfer(asesorA, vehicleA.id as string, toCarlos());
    expect(done.status).toBe(200);
    const before = await history(asesorA, vehicleA.id as string);
    expect(before.status).toBe(200);
    expect(before.body.items).toHaveLength(1);
    const path = `/api/v1/vehicles/${vehicleA.id as string}/ownership-history`;
    const itemPath = `${path}/${before.body.items[0].id as string}`;

    for (const target of [path, itemPath]) {
      for (const method of ['put', 'patch', 'delete'] as const) {
        const res = await server()
          [method](target)
          .set(authHeader(adminA.token))
          .send({ reason: 'Intento de reescribir la historia' });
        expect(res.status, `${method.toUpperCase()} ${target}`).toBe(404);
      }
    }

    const after = await history(asesorA, vehicleA.id as string);
    expect(after.body).toEqual(before.body);
    expect(await auditRowsAs(tenantA.id)).toHaveLength(1);
  });

  // ---------------------------------------------------------------- US4-AC13

  it('US4-AC13 el taller A intenta transferir un vehículo del taller B → 404 NOT_FOUND igual que uno inexistente, sin cambios ni auditoría', async () => {
    const foreign = await transfer(asesorA, vehicleB.id as string, {
      newOwnerClientId: carlos.id,
      version: vehicleB.version,
      reason: VALID_REASON,
    });
    const missing = await transfer(asesorA, randomUUID(), {
      newOwnerClientId: carlos.id,
      version: 1,
      reason: VALID_REASON,
    });

    expectProblem(foreign, 404, 'NOT_FOUND');
    expect(foreign.body).toEqual(missing.body);
    const leaked = JSON.stringify(foreign.body);
    for (const secret of ['BB998877', 'Beatriz', 'PBA1234']) {
      expect(leaked).not.toContain(secret);
    }
    await expectNothingChanged();
    // Positive control: B itself can transfer its vehicle.
    const own = await transfer(asesorB, vehicleB.id as string, {
      newOwnerClientId: bruno.id,
      version: vehicleB.version,
      reason: VALID_REASON,
    });
    expect(own.status).toBe(200);
  });

  it('US4-AC13 el taller A intenta transferir su vehículo a un cliente del taller B → 404 CLIENT_NOT_FOUND igual que uno inexistente, sin auditoría en ningún taller', async () => {
    const foreign = await transfer(
      asesorA,
      vehicleA.id as string,
      toCarlos({ newOwnerClientId: beatriz.id }),
    );
    const missing = await transfer(
      asesorA,
      vehicleA.id as string,
      toCarlos({ newOwnerClientId: randomUUID() }),
    );

    expectProblem(foreign, 404, 'CLIENT_NOT_FOUND');
    expect(foreign.body).toEqual(missing.body);
    expect(JSON.stringify(foreign.body)).not.toContain('Beatriz');
    await expectNothingChanged();
  });

  it('US4-AC13 el admin del taller A tampoco transfiere un vehículo de B ni a un cliente de B', async () => {
    const foreignVehicle = await transfer(adminA, vehicleB.id as string, {
      newOwnerClientId: carlos.id,
      version: vehicleB.version,
    });
    const foreignClient = await transfer(adminA, vehicleA.id as string, {
      newOwnerClientId: bruno.id,
      version: vehicleA.version,
    });

    expectProblem(foreignVehicle, 404, 'NOT_FOUND');
    expectProblem(foreignClient, 404, 'CLIENT_NOT_FOUND');
    await expectNothingChanged();
  });

  it('US4-AC13 X-Tenant-Id se ignora: A con X-Tenant-Id de B transfiere su propio vehículo y la auditoría queda solo en A', async () => {
    const res = await server()
      .post(`/api/v1/vehicles/${vehicleA.id as string}/ownership-transfers`)
      .set(authHeader(asesorA.token))
      .set('X-Tenant-Id', tenantB.id)
      .send(toCarlos());

    expect(res.status).toBe(200);
    expect(await auditRowsAs(tenantA.id)).toHaveLength(1);
    expect(await auditRowsAs(tenantB.id)).toHaveLength(0);

    const foreign = await server()
      .post(`/api/v1/vehicles/${vehicleB.id as string}/ownership-transfers`)
      .set(authHeader(asesorA.token))
      .set('X-Tenant-Id', tenantB.id)
      .send({
        newOwnerClientId: carlos.id,
        version: vehicleB.version,
        reason: VALID_REASON,
      });
    expectProblem(foreign, 404, 'NOT_FOUND');
    expect(await auditRowsAs(tenantB.id)).toHaveLength(0);
  });

  it.each(['tenantId', 'tenant_id'])(
    'US4-AC13 FR-022 %s en el body → 400 UNKNOWN_FIELD, sin cambios ni auditoría',
    async (field) => {
      const res = await transfer(
        asesorA,
        vehicleA.id as string,
        toCarlos({ [field]: tenantB.id }),
      );

      expectValidationError(res, field, 'UNKNOWN_FIELD');
      await expectNothingChanged();
    },
  );

  // ---------------------------------------------------------------- US4-AC14

  it('US4-AC14 el historial y la auditoría de cada taller solo muestran sus propios registros', async () => {
    const inA = await transfer(asesorA, vehicleA.id as string, toCarlos());
    expect(inA.status).toBe(200);
    const inB = await transfer(asesorB, vehicleB.id as string, {
      newOwnerClientId: bruno.id,
      version: vehicleB.version,
      reason: 'Traspaso registrado en el taller B',
    });
    expect(inB.status).toBe(200);

    const historyA = await history(asesorA, vehicleA.id as string);
    const historyB = await history(asesorB, vehicleB.id as string);

    expect(historyA.status).toBe(200);
    expect(historyA.body.items).toHaveLength(1);
    expect(historyA.body.items[0]).toMatchObject({
      previousOwner: ownerSnapshotOf(ana),
      newOwner: ownerSnapshotOf(carlos),
      actorUserId: asesorA.userId,
    });
    expect(historyB.body.items).toHaveLength(1);
    expect(historyB.body.items[0]).toMatchObject({
      previousOwner: ownerSnapshotOf(beatriz),
      newOwner: ownerSnapshotOf(bruno),
      actorUserId: asesorB.userId,
    });
    expect(JSON.stringify(historyA.body)).not.toContain('Beatriz');
    expect(JSON.stringify(historyA.body)).not.toContain('taller B');

    const auditA = await auditRowsAs(tenantA.id);
    const auditB = await auditRowsAs(tenantB.id);
    expect(auditA.map((row) => row.id)).toEqual([historyA.body.items[0].id]);
    expect(auditB.map((row) => row.id)).toEqual([historyB.body.items[0].id]);
    expect(auditA.every((row) => row.tenant_id === tenantA.id)).toBe(true);
    expect(auditB.every((row) => row.tenant_id === tenantB.id)).toBe(true);
  });

  it('US4-AC14 un usuario del taller B no ve el historial de un vehículo de A → 404 NOT_FOUND igual que uno inexistente', async () => {
    const done = await transfer(asesorA, vehicleA.id as string, toCarlos());
    expect(done.status).toBe(200);

    const foreign = await history(asesorB, vehicleA.id as string);
    const missing = await history(asesorB, randomUUID());

    expectProblem(foreign, 404, 'NOT_FOUND');
    expect(foreign.body).toEqual(missing.body);
    expect(JSON.stringify(foreign.body)).not.toContain('Ana');
  });

  // ---------------------------------------------------------------- US4-AC15

  it.each([
    ['omitido', undefined],
    ['vacío', ''],
    ['solo espacios', '      '],
    ['de 9 caracteres', 'x'.repeat(9)],
    ['de 9 caracteres rodeado de espacios', `     ${'x'.repeat(9)}     `],
    ['de 501 caracteres', 'x'.repeat(501)],
  ])(
    'US4-AC15 asesor con motivo %s → 400 REASON_REQUIRED, sin cambios ni auditoría',
    async (_label, reason) => {
      const body = toCarlos({ reason });
      if (reason === undefined) delete body.reason;

      const res = await transfer(asesorA, vehicleA.id as string, body);

      expectReasonRequired(res);
      await expectNothingChanged();
    },
  );

  it.each([
    ['de 10 caracteres', 'x'.repeat(10), 'x'.repeat(10)],
    ['de 500 caracteres', 'y'.repeat(500), 'y'.repeat(500)],
    [
      'de 500 caracteres rodeado de espacios',
      `  ${'z'.repeat(500)}  `,
      'z'.repeat(500),
    ],
  ])(
    'US4-AC15 asesor con motivo %s → 200 y el motivo se audita sin espacios al inicio ni al final',
    async (_label, reason, stored) => {
      const res = await transfer(
        asesorA,
        vehicleA.id as string,
        toCarlos({ reason }),
      );

      expect(res.status).toBe(200);
      const rows = await auditRowsAs(tenantA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe(stored);
    },
  );

  // ---------------------------------------------------------------- US4-AC16

  it.each([
    ['omitido', undefined],
    ['vacío', ''],
    ['solo espacios', '    '],
  ])(
    'US4-AC16 admin con motivo %s → 200 y la auditoría queda con reason null y rol admin',
    async (_label, reason) => {
      const body = toCarlos({ reason });
      if (reason === undefined) delete body.reason;

      const res = await transfer(adminA, vehicleA.id as string, body);

      expect(res.status).toBe(200);
      expect(res.body.owner).toMatchObject({ id: carlos.id });
      const rows = await auditRowsAs(tenantA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: 'vehicle.owner_changed',
        actor_user_id: adminA.userId,
        actor_name: 'Alberto Admin',
        actor_role: 'admin',
        reason: null,
      });
    },
  );

  it('US4-AC16 admin con motivo válido → 200 y el motivo queda en la auditoría', async () => {
    const res = await transfer(adminA, vehicleA.id as string, toCarlos());

    expect(res.status).toBe(200);
    const rows = await auditRowsAs(tenantA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_role: 'admin', reason: VALID_REASON });
  });

  it.each([
    ['de 9 caracteres', 'x'.repeat(9)],
    ['de 501 caracteres', 'x'.repeat(501)],
  ])(
    'US4-AC16 admin con motivo %s → 400 REASON_REQUIRED, sin cambios ni auditoría',
    async (_label, reason) => {
      const res = await transfer(
        adminA,
        vehicleA.id as string,
        toCarlos({ reason }),
      );

      expectReasonRequired(res);
      await expectNothingChanged();
    },
  );

  // ---------------------------------------------------------------- Edge case SAME_OWNER

  it.each([
    ['asesor', () => asesorA],
    ['admin', () => adminA],
  ])(
    'Edge case SAME_OWNER: %s transfiere al propietario actual → 422 SAME_OWNER sin cambios ni auditoría',
    async (_label, actorFn) => {
      const res = await transfer(
        actorFn(),
        vehicleA.id as string,
        toCarlos({ newOwnerClientId: ana.id }),
      );

      expectProblem(res, 422, 'SAME_OWNER');
      await expectNothingChanged();
    },
  );

  // ---------------------------------------------------------------- US4-AC12 (VERSION_CONFLICT)

  it('US4-AC12 transferir con una version antigua → 409 VERSION_CONFLICT con current, sin cambios ni auditoría nueva', async () => {
    const first = await transfer(asesorA, vehicleA.id as string, toCarlos());
    expect(first.status).toBe(200);

    const stale = await transfer(asesorA, vehicleA.id as string, {
      newOwnerClientId: diego.id,
      version: vehicleA.version,
      reason: 'Segunda transferencia con versión vieja',
    });

    expectProblem(stale, 409, 'VERSION_CONFLICT');
    expect(stale.body.current).toMatchObject({
      id: vehicleA.id,
      plate: 'PBA1234',
      version: first.body.version,
      owner: expect.objectContaining({ id: carlos.id }),
    });
    expect(await vehicleRowAs(tenantA.id, vehicleA.id as string)).toMatchObject(
      { owner_client_id: carlos.id, version: first.body.version },
    );
    expect(await auditRowsAs(tenantA.id)).toHaveLength(1);
  });

  it('US4-AC12 transferir con una version futura → 409 VERSION_CONFLICT sin cambios ni auditoría', async () => {
    const res = await transfer(
      asesorA,
      vehicleA.id as string,
      toCarlos({ version: (vehicleA.version as number) + 5 }),
    );

    expectProblem(res, 409, 'VERSION_CONFLICT');
    expect(res.body.current).toMatchObject({
      id: vehicleA.id,
      version: vehicleA.version,
      owner: expect.objectContaining({ id: ana.id }),
    });
    await expectNothingChanged();
  });

  // ---------------------------------------------------------------- Contract validation

  it.each([
    ['newOwnerClientId omitido', { newOwnerClientId: undefined }, 'newOwnerClientId', 'REQUIRED'],
    ['version omitida', { version: undefined }, 'version', 'REQUIRED'],
    ['newOwnerClientId que no es uuid', { newOwnerClientId: 'not-a-uuid' }, 'newOwnerClientId', undefined],
    ['version 0', { version: 0 }, 'version', undefined],
    ['version no entera', { version: 1.5 }, 'version', undefined],
    ['ownerClientId (campo desconocido)', { ownerClientId: randomUUID() }, 'ownerClientId', 'UNKNOWN_FIELD'],
  ])(
    'Contrato OwnershipTransferRequest: %s → 400 VALIDATION_ERROR, sin cambios ni auditoría',
    async (_label, overrides, field, code) => {
      const body = toCarlos(overrides as Json);
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined) delete body[key];
      }

      const res = await transfer(asesorA, vehicleA.id as string, body);

      expectValidationError(res, field, code);
      await expectNothingChanged();
    },
  );

  it('Contrato: sin token → 401 UNAUTHORIZED en la transferencia y en el historial, sin cambios', async () => {
    const post = await server()
      .post(`/api/v1/vehicles/${vehicleA.id as string}/ownership-transfers`)
      .send(toCarlos());
    const get = await server().get(
      `/api/v1/vehicles/${vehicleA.id as string}/ownership-history`,
    );

    expectProblem(post, 401, 'UNAUTHORIZED');
    expectProblem(get, 401, 'UNAUTHORIZED');
    await expectNothingChanged();
  });

  it('Contrato: vehicleId que no es uuid → 404 NOT_FOUND en la transferencia y en el historial', async () => {
    const post = await transfer(asesorA, 'not-a-uuid', toCarlos());
    const get = await history(asesorA, 'not-a-uuid');

    expectProblem(post, 404, 'NOT_FOUND');
    expectProblem(get, 404, 'NOT_FOUND');
    await expectNothingChanged();
    // Positive control: the history endpoint exists.
    expect((await history(asesorA, vehicleA.id as string)).status).toBe(200);
  });
});
