// T070: e2e of vehicle editing (US4-AC5, AC6, AC11, AC12, AC13, AC15, AC16; US3-AC14; FR-019,
// FR-020) over the full app wiring (AppModule + configureApp) and the real PostgreSQL, the API
// connecting as motorsync_app. Contract: PATCH /api/v1/vehicles/{vehicleId} (VehicleUpdate,
// VehicleDetail, Reason, Problem with VERSION_CONFLICT + current). Audit: data-model.md, audit_log
// with actions vehicle.plate_changed ({ plate }) and vehicle.vin_changed ({ vin }, may be null);
// a PATCH that changes both writes two records with the same reason.
// Decisions of the leader: the admin reason is optional but, if given, 10 to 500 characters; an
// empty or blank reason counts as omitted; a normalized value equal to the stored one is not a
// change and does not ask for a reason.
// Every test builds its own tenants, owners and vehicles through the API (beforeEach).
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { authHeader, issueTestToken, type TestRole } from './setup/auth.js';
import {
  closeFixtures,
  createTenant,
  truncateBusinessTables,
  type TenantFixture,
} from './setup/db-fixtures.js';

const REASON_MESSAGE = 'El motivo es obligatorio (entre 10 y 500 caracteres)';
const VALID_REASON = 'Placa reemplazada por la ANT tras robo';

/** Exact messages of spec.md US3-AC12 and US3-AC13. */
const CAR_PLATE_MESSAGE =
  'Placa inválida: para autos use 3 letras y 3 o 4 dígitos (ej. PBA1234)';
const MOTORCYCLE_PLATE_MESSAGE =
  'Placa inválida: para motos use 2 letras, 3 dígitos y 1 letra (ej. AB123C)';

const VALID_VIN = '1HGCM82633A004352';
const OTHER_VALID_VIN = '2T1BURHE0JC123456';

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

interface VehicleRow {
  id: string;
  tenant_id: string;
  owner_client_id: string;
  plate: string;
  vin: string | null;
  brand: string;
  body_type: string;
  version: number;
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
  ip: string | null;
  channel: string;
}

describe('Vehicles update (e2e, T070, US4)', () => {
  let app: INestApplication<App>;
  let appPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let creatorA: Actor;
  /** Another asesor of tenant A, the one who edits. */
  let asesorA: Actor;
  let adminA: Actor;
  let asesorB: Actor;
  let ownerA: Record<string, unknown>;
  let ownerB: Record<string, unknown>;
  /** Sedan PBA1234 without VIN, owned by ownerA (recreated in every test). */
  let vehicleA: Record<string, unknown>;
  /** Vehicle of tenant B: sedan PBA1234 with VALID_VIN. */
  let vehicleB: Record<string, unknown>;

  function actorOf(tenant: TenantFixture, name: string, role: TestRole): Actor {
    const userId = randomUUID();
    return {
      userId,
      name,
      role,
      token: issueTestToken({ tenantId: tenant.id, userId, role, name }),
    };
  }

  function post(actor: Actor, path: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/v1/${path}`)
      .set(authHeader(actor.token))
      .send(body);
  }

  function getVehicle(actor: Actor, id: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/vehicles/${id}`)
      .set(authHeader(actor.token));
  }

  function patchVehicle(
    actor: Actor,
    id: string,
    body: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .patch(`/api/v1/vehicles/${id}`)
      .set(authHeader(actor.token))
      .send(body);
  }

  async function create(
    actor: Actor,
    path: 'clients' | 'vehicles',
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await post(actor, path, body);
    expect(res.status, `creation via POST /${path}`).toBe(201);
    return res.body as Record<string, unknown>;
  }

  function sedan(
    ownerClientId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      ownerClientId,
      plate: 'PBA1234',
      brand: 'Toyota',
      model: 'Corolla',
      year: 2020,
      color: 'Blanco',
      bodyType: 'sedan',
      initialMileage: 45000,
      ...overrides,
    };
  }

  function fieldErrors(body: { errors?: FieldErrorBody[] }): FieldErrorBody[] {
    return Array.isArray(body.errors) ? body.errors : [];
  }

  function expectValidationError(
    res: request.Response,
    field: string,
    code: string,
  ): FieldErrorBody {
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    const errors = fieldErrors(res.body as { errors?: FieldErrorBody[] });
    expect(errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field, code })]),
    );
    for (const error of errors) {
      expect(typeof error.message).toBe('string');
      expect(error.message.length).toBeGreaterThan(0);
    }
    return errors.find(
      (error) => error.field === field && error.code === code,
    ) as FieldErrorBody;
  }

  function expectReasonRequired(res: request.Response): void {
    const error = expectValidationError(res, 'reason', 'REASON_REQUIRED');
    expect(error.message).toBe(REASON_MESSAGE);
  }

  /** Runs a read as motorsync_app with the tenant pinned (as the API sees the data, under RLS). */
  async function readAs<T extends pg.QueryResultRow>(
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

  async function vehicleRowAs(
    tenantId: string,
    id: string,
  ): Promise<VehicleRow | undefined> {
    const rows = await readAs<VehicleRow>(
      tenantId,
      `SELECT id, tenant_id, owner_client_id, plate, vin, brand, body_type, version
         FROM vehicles WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function auditRowsAs(tenantId: string): Promise<AuditRow[]> {
    return readAs<AuditRow>(
      tenantId,
      `SELECT id, tenant_id, actor_user_id, actor_name, actor_role, action, entity_type,
              entity_id, before, after, reason, occurred_at, ip, channel
         FROM audit_log ORDER BY occurred_at, action`,
    );
  }

  /** The stored vehicle A still has its original identifiers and version 1. */
  async function expectVehicleAUnchanged(): Promise<void> {
    expect(await vehicleRowAs(tenantA.id, vehicleA.id as string)).toMatchObject(
      {
        plate: 'PBA1234',
        vin: null,
        brand: 'Toyota',
        body_type: 'sedan',
        owner_client_id: ownerA.id,
        version: 1,
      },
    );
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
    tenantA = await createTenant(`Taller A vehicles-update e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B vehicles-update e2e ${randomUUID()}`);
    creatorA = actorOf(tenantA, 'Ana Creadora', 'asesor');
    asesorA = actorOf(tenantA, 'Carla Editora', 'asesor');
    adminA = actorOf(tenantA, 'Diego Admin', 'admin');
    asesorB = actorOf(tenantB, 'Bruno Salazar', 'asesor');
    ownerA = await create(creatorA, 'clients', {
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: '1710034065',
      firstNames: 'Ana',
      lastNames: 'Pérez',
      phone: '0991234567',
    });
    ownerB = await create(asesorB, 'clients', {
      clientType: 'natural',
      documentType: 'passport',
      documentNumber: 'BB998877',
      firstNames: 'Beatriz',
      lastNames: 'Torres',
      phone: '0987654321',
    });
    vehicleA = await create(creatorA, 'vehicles', sedan(ownerA.id as string));
    vehicleB = await create(
      asesorB,
      'vehicles',
      sedan(ownerB.id as string, { vin: VALID_VIN }),
    );
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US4-AC6

  it('US4-AC6 el asesor edita marca, modelo, año, color, carrocería y kilometraje → 200 VehicleDetail con version + 1, sin motivo ni auditoría', async () => {
    const before = Date.now();
    const res = await patchVehicle(asesorA, vehicleA.id as string, {
      version: 1,
      brand: 'Chevrolet',
      model: 'D-Max',
      year: 2021,
      color: 'Gris',
      bodyType: 'pickup',
      initialMileage: 52000,
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({
      id: vehicleA.id,
      plate: 'PBA1234',
      vin: null,
      brand: 'Chevrolet',
      model: 'D-Max',
      year: 2021,
      color: 'Gris',
      bodyType: 'pickup',
      initialMileage: 52000,
      version: 2,
      updatedBy: asesorA.userId,
      updatedByName: 'Carla Editora',
      createdAt: vehicleA.createdAt,
    });
    expect(res.body.owner).toEqual(vehicleA.owner);
    expect(Date.parse(res.body.updatedAt as string)).toBeGreaterThanOrEqual(
      before - 5_000,
    );
    expect(res.body).not.toHaveProperty('tenantId');
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);

    const fetched = await getVehicle(asesorA, vehicleA.id as string);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(res.body);
  });

  it('US4-AC6 solo se cambian los campos enviados: un PATCH con el color deja intacto el resto', async () => {
    const res = await patchVehicle(asesorA, vehicleA.id as string, {
      version: 1,
      color: 'Rojo',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      color: 'Rojo',
      brand: 'Toyota',
      model: 'Corolla',
      year: 2020,
      bodyType: 'sedan',
      initialMileage: 45000,
      plate: 'PBA1234',
      version: 2,
    });
  });

  // ---------------------------------------------------------------- US4-AC5

  it.each(['GYE0123', 'gye-0123', ' Gye 0123 '])(
    'US4-AC5 placa de otro vehículo del taller, enviada como "%s" → 409 PLATE_ALREADY_EXISTS con existingId, sin cambios ni auditoría',
    async (repeated) => {
      const other = await create(
        creatorA,
        'vehicles',
        sedan(ownerA.id as string, { plate: 'GYE0123' }),
      );

      const res = await patchVehicle(asesorA, vehicleA.id as string, {
        version: 1,
        plate: repeated,
        reason: VALID_REASON,
      });

      expect(res.status).toBe(409);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({
        status: 409,
        code: 'PLATE_ALREADY_EXISTS',
        existingId: other.id,
      });
      await expectVehicleAUnchanged();
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('US4-AC5 VIN de otro vehículo del taller → 409 VIN_ALREADY_EXISTS con existingId, sin cambios ni auditoría', async () => {
    const other = await create(
      creatorA,
      'vehicles',
      sedan(ownerA.id as string, { plate: 'GYE0123', vin: VALID_VIN }),
    );

    const res = await patchVehicle(asesorA, vehicleA.id as string, {
      version: 1,
      vin: '1hgcm-82633 a004352',
      reason: VALID_REASON,
    });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      status: 409,
      code: 'VIN_ALREADY_EXISTS',
      existingId: other.id,
    });
    await expectVehicleAUnchanged();
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
  });

  it('US4-AC5 la placa y el VIN existen solo en el taller B → el cambio en A se acepta sin revelar nada de B', async () => {
    const other = await create(
      creatorA,
      'vehicles',
      sedan(ownerA.id as string, { plate: 'GYE0123' }),
    );

    const res = await patchVehicle(asesorA, other.id as string, {
      version: 1,
      vin: VALID_VIN,
      reason: VALID_REASON,
    });

    expect(res.status).toBe(200);
    expect(res.body.vin).toBe(VALID_VIN);
    expect(res.body).not.toHaveProperty('existingId');
    expect(await vehicleRowAs(tenantB.id, vehicleB.id as string)).toMatchObject(
      { vin: VALID_VIN, version: 1 },
    );
  });

  it.each([
    ['PB1234', 'dos letras'],
    ['PBA12', 'dos dígitos'],
    ['PBA12345', 'cinco dígitos'],
    ['AB123C', 'formato de moto en un sedán'],
  ])(
    'US4-AC5 placa %s (%s) en un sedán → 400 INVALID_PLATE con el mensaje de autos, sin cambios ni auditoría',
    async (plate) => {
      const res = await patchVehicle(asesorA, vehicleA.id as string, {
        version: 1,
        plate,
        reason: VALID_REASON,
      });

      const error = expectValidationError(res, 'plate', 'INVALID_PLATE');
      expect(error.message).toBe(CAR_PLATE_MESSAGE);
      await expectVehicleAUnchanged();
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it.each(['PBA*1234', 'PBA.1234', 'PBA_1234'])(
    'US4-AC5 US3-AC14 placa con caracteres no permitidos "%s" → 400 INVALID_PLATE en lugar de limpiarse',
    async (plate) => {
      const res = await patchVehicle(asesorA, vehicleA.id as string, {
        version: 1,
        plate,
        reason: VALID_REASON,
      });

      expectValidationError(res, 'plate', 'INVALID_PLATE');
      await expectVehicleAUnchanged();
    },
  );

  it.each([
    ['1HGCM82633A00435', '16 caracteres'],
    ['1HGCM82633A0043521', '18 caracteres'],
    ['1HGCM82633A00435I', 'contiene I'],
    ['1HGCM82633A00435O', 'contiene O'],
  ])(
    'US4-AC5 VIN %s (%s) → 400 INVALID_VIN "VIN inválido", sin cambios ni auditoría',
    async (vin) => {
      const res = await patchVehicle(asesorA, vehicleA.id as string, {
        version: 1,
        vin,
        reason: VALID_REASON,
      });

      const error = expectValidationError(res, 'vin', 'INVALID_VIN');
      expect(error.message).toMatch(/^VIN inválido/);
      await expectVehicleAUnchanged();
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it.each([
    ['year', 1949, 'INVALID_YEAR'],
    ['year', new Date().getUTCFullYear() + 2, 'INVALID_YEAR'],
    ['initialMileage', -1, 'INVALID_MILEAGE'],
    ['initialMileage', 10_000_000, 'INVALID_MILEAGE'],
    ['initialMileage', 1500.5, 'INVALID_MILEAGE'],
  ])(
    'US4-AC5 US3-AC7 %s = %s → 400 %s, sin cambios',
    async (field, value, code) => {
      const res = await patchVehicle(asesorA, vehicleA.id as string, {
        version: 1,
        [field]: value,
      });

      expectValidationError(res, field, code);
      await expectVehicleAUnchanged();
    },
  );

  // ---------------------------------------------------------------- US3-AC14

  it('US3-AC14 cambiar bodyType a motorcycle dejando PBA1234 → 400 INVALID_PLATE con el mensaje de motos, sin cambios', async () => {
    const res = await patchVehicle(asesorA, vehicleA.id as string, {
      version: 1,
      bodyType: 'motorcycle',
    });

    const error = expectValidationError(res, 'plate', 'INVALID_PLATE');
    expect(error.message).toBe(MOTORCYCLE_PLATE_MESSAGE);
    await expectVehicleAUnchanged();
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
  });

  it('US3-AC14 una moto AB123C que pasa a sedan sin cambiar la placa → 400 INVALID_PLATE con el mensaje de autos', async () => {
    const moto = await create(
      creatorA,
      'vehicles',
      sedan(ownerA.id as string, { plate: 'AB123C', bodyType: 'motorcycle' }),
    );

    const res = await patchVehicle(asesorA, moto.id as string, {
      version: 1,
      bodyType: 'sedan',
    });

    const error = expectValidationError(res, 'plate', 'INVALID_PLATE');
    expect(error.message).toBe(CAR_PLATE_MESSAGE);
    expect(await vehicleRowAs(tenantA.id, moto.id as string)).toMatchObject({
      plate: 'AB123C',
      body_type: 'motorcycle',
      version: 1,
    });
  });

  it('US3-AC14 cambiar a motorcycle junto con una placa de moto válida → 200, con motivo por ser cambio de placa', async () => {
    const res = await patchVehicle(asesorA, vehicleA.id as string, {
      version: 1,
      bodyType: 'motorcycle',
      plate: 'ab-123 c',
      reason: VALID_REASON,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      plate: 'AB123C',
      bodyType: 'motorcycle',
      version: 2,
    });
    const rows = await auditRowsAs(tenantA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'vehicle.plate_changed',
      before: { plate: 'PBA1234' },
      after: { plate: 'AB123C' },
    });
  });

  // ---------------------------------------------------------------- US4-AC11 / FR-020

  it('US4-AC11 el asesor cambia placa y VIN en un solo PATCH → 200 y dos registros (vehicle.plate_changed, vehicle.vin_changed) con el mismo motivo', async () => {
    const before = Date.now();
    const res = await patchVehicle(asesorA, vehicleA.id as string, {
      version: 1,
      plate: 'gye-0123',
      vin: ' 1hgcm-82633 a004352 ',
      reason: `  ${VALID_REASON}  `,
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      plate: 'GYE0123',
      vin: VALID_VIN,
      version: 2,
      updatedBy: asesorA.userId,
      updatedByName: 'Carla Editora',
    });
    expect(res.body).not.toHaveProperty('reason');

    const rows = await auditRowsAs(tenantA.id);
    expect(rows).toHaveLength(2);
    const plate = rows.find((row) => row.action === 'vehicle.plate_changed');
    const vin = rows.find((row) => row.action === 'vehicle.vin_changed');
    expect(plate).toBeDefined();
    expect(vin).toBeDefined();
    const common = {
      tenant_id: tenantA.id,
      actor_user_id: asesorA.userId,
      actor_name: 'Carla Editora',
      actor_role: 'asesor',
      entity_type: 'vehicle',
      entity_id: vehicleA.id,
      reason: VALID_REASON,
      channel: 'web',
    };
    expect(plate).toMatchObject(common);
    expect(vin).toMatchObject(common);
    expect(plate?.before).toEqual({ plate: 'PBA1234' });
    expect(plate?.after).toEqual({ plate: 'GYE0123' });
    expect(vin?.before).toEqual({ vin: null });
    expect(vin?.after).toEqual({ vin: VALID_VIN });
    for (const row of rows) {
      expect(typeof row.ip).toBe('string');
      expect((row.ip as string).length).toBeGreaterThan(0);
      expect(row.occurred_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
      expect(row.occurred_at.getTime()).toBeLessThanOrEqual(after + 5_000);
    }
    expect(plate?.occurred_at.getTime()).toBe(vin?.occurred_at.getTime());
  });

  it('US4-AC11 cambiar solo la placa → un único registro vehicle.plate_changed', async () => {
    const res = await patchVehicle(asesorA, vehicleA.id as string, {
      version: 1,
      plate: 'PBA1235',
      color: 'Negro',
      reason: VALID_REASON,
    });

    expect(res.status).toBe(200);
    const rows = await auditRowsAs(tenantA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'vehicle.plate_changed',
      before: { plate: 'PBA1234' },
      after: { plate: 'PBA1235' },
    });
  });

  it('US4-AC11 quitar el VIN (vin: null) es un cambio de VIN → registro vehicle.vin_changed con after { vin: null }', async () => {
    const res = await patchVehicle(asesorB, vehicleB.id as string, {
      version: 1,
      vin: null,
      reason: VALID_REASON,
    });

    expect(res.status).toBe(200);
    expect(res.body.vin).toBeNull();
    const rows = await auditRowsAs(tenantB.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'vehicle.vin_changed',
      before: { vin: VALID_VIN },
      after: { vin: null },
      reason: VALID_REASON,
    });
  });

  it.each([
    ['plate', 'pba-1234'],
    ['plate', ' PBA 1234 '],
    ['vin', null],
  ])(
    'US4-AC11 %s normalizado igual al guardado (%s) no es un cambio: 200 sin motivo y sin auditoría',
    async (field, value) => {
      const res = await patchVehicle(asesorA, vehicleA.id as string, {
        version: 1,
        [field]: value,
        color: 'Azul',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ plate: 'PBA1234', vin: null });
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('US4-AC11 el mismo VIN escrito con minúsculas y guiones no es un cambio para el asesor sin motivo', async () => {
    const res = await patchVehicle(asesorB, vehicleB.id as string, {
      version: 1,
      vin: '1hgcm-82633-a004352',
    });

    expect(res.status).toBe(200);
    expect(res.body.vin).toBe(VALID_VIN);
    expect(await auditRowsAs(tenantB.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- US4-AC12

  it('US4-AC12 un segundo guardado sobre la versión antigua → 409 VERSION_CONFLICT con current = datos actuales', async () => {
    const first = await patchVehicle(asesorA, vehicleA.id as string, {
      version: 1,
      color: 'Negro',
    });
    expect(first.status).toBe(200);

    const second = await patchVehicle(adminA, vehicleA.id as string, {
      version: 1,
      color: 'Verde',
    });

    expect(second.status).toBe(409);
    expect(second.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(second.body).toMatchObject({
      status: 409,
      code: 'VERSION_CONFLICT',
    });
    expect(second.body.current).toEqual(first.body);
    expect(second.body.current).toMatchObject({
      id: vehicleA.id,
      color: 'Negro',
      version: 2,
      updatedByName: 'Carla Editora',
    });
    expect(await vehicleRowAs(tenantA.id, vehicleA.id as string)).toMatchObject(
      { version: 2 },
    );
  });

  it('US4-AC12 un cambio de placa con versión antigua → 409 VERSION_CONFLICT sin cambios ni auditoría', async () => {
    const first = await patchVehicle(asesorA, vehicleA.id as string, {
      version: 1,
      color: 'Negro',
    });
    expect(first.status).toBe(200);

    const res = await patchVehicle(asesorA, vehicleA.id as string, {
      version: 1,
      plate: 'GYE0123',
      reason: VALID_REASON,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.current).toMatchObject({ plate: 'PBA1234', version: 2 });
    expect(await vehicleRowAs(tenantA.id, vehicleA.id as string)).toMatchObject(
      { plate: 'PBA1234', version: 2 },
    );
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- US4-AC13 (multi-tenant)

  it('US4-AC13 un usuario del taller A edita un vehículo del taller B → 404 NOT_FOUND igual que uno inexistente, sin cambios', async () => {
    const fromA = await patchVehicle(asesorA, vehicleB.id as string, {
      version: 1,
      color: 'Negro',
    });
    const missing = await patchVehicle(asesorA, randomUUID(), {
      version: 1,
      color: 'Negro',
    });

    expect(fromA.status).toBe(404);
    expect(fromA.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(fromA.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(fromA.body).toEqual(missing.body);
    expect(JSON.stringify(fromA.body)).not.toContain(VALID_VIN);
    expect(await vehicleRowAs(tenantB.id, vehicleB.id as string)).toMatchObject(
      { version: 1 },
    );
  });

  it('US4-AC13 A cambia placa y VIN de un vehículo de B (asesor con motivo y admin) → 404, sin cambios ni auditoría en ninguno de los dos talleres', async () => {
    for (const actor of [asesorA, adminA]) {
      const res = await patchVehicle(actor, vehicleB.id as string, {
        version: 1,
        plate: 'GYE0123',
        vin: OTHER_VALID_VIN,
        reason: VALID_REASON,
      });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    }

    expect(await vehicleRowAs(tenantB.id, vehicleB.id as string)).toMatchObject(
      { plate: 'PBA1234', vin: VALID_VIN, version: 1 },
    );
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    expect(await auditRowsAs(tenantB.id)).toHaveLength(0);
  });

  it('US4-AC13 A con la cabecera X-Tenant-Id de B tampoco edita el vehículo de B → 404', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/vehicles/${vehicleB.id}`)
      .set(authHeader(asesorA.token))
      .set('X-Tenant-Id', tenantB.id)
      .send({ version: 1, color: 'Negro' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(await vehicleRowAs(tenantB.id, vehicleB.id as string)).toMatchObject(
      { version: 1 },
    );
  });

  it('US4-AC13 la cabecera X-Tenant-Id se ignora: A edita su propio vehículo aunque envíe la de B', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/vehicles/${vehicleA.id}`)
      .set(authHeader(asesorA.token))
      .set('X-Tenant-Id', tenantB.id)
      .send({ version: 1, color: 'Negro' });

    expect(res.status).toBe(200);
    expect(await vehicleRowAs(tenantA.id, vehicleA.id as string)).toMatchObject(
      { tenant_id: tenantA.id, version: 2 },
    );
    expect(await vehicleRowAs(tenantB.id, vehicleB.id as string)).toMatchObject(
      { version: 1 },
    );
  });

  // ---------------------------------------------------------------- US4-AC15 (asesor)

  const invalidReasons: [string, string | undefined][] = [
    ['sin motivo', undefined],
    ['motivo de 9 caracteres', '123456789'],
    ['motivo de 9 caracteres tras trim', '   123456789   '],
    ['motivo de 501 caracteres', 'x'.repeat(501)],
    ['motivo vacío', ''],
    ['motivo de solo espacios', '            '],
  ];

  it.each(
    invalidReasons.flatMap(([label, reason]) => [
      ['la placa', label, { plate: 'GYE0123' }, reason],
      ['el VIN', label, { vin: VALID_VIN }, reason],
    ]) as [string, string, Record<string, unknown>, string | undefined][],
  )(
    'US4-AC15 el asesor cambia %s %s → 400 REASON_REQUIRED, sin cambios ni auditoría',
    async (_what, _label, change, reason) => {
      const body: Record<string, unknown> = { version: 1, ...change };
      if (reason !== undefined) body.reason = reason;

      const res = await patchVehicle(asesorA, vehicleA.id as string, body);

      expectReasonRequired(res);
      await expectVehicleAUnchanged();
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it.each([
    ['10 caracteres', '1234567890', '1234567890'],
    ['500 caracteres', 'm'.repeat(500), 'm'.repeat(500)],
    ['10 caracteres con espacios alrededor', '   1234567890   ', '1234567890'],
  ])(
    'US4-AC15 el asesor cambia la placa con un motivo de %s → 200 y el motivo queda auditado sin espacios',
    async (_label, reason, stored) => {
      const res = await patchVehicle(asesorA, vehicleA.id as string, {
        version: 1,
        plate: 'GYE0123',
        reason,
      });

      expect(res.status).toBe(200);
      const rows = await auditRowsAs(tenantA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_role: 'asesor', reason: stored });
    },
  );

  // ---------------------------------------------------------------- US4-AC16 (admin)

  it('US4-AC16 el admin cambia placa y VIN sin motivo → 200 y dos registros con reason null y actor_role admin', async () => {
    const res = await patchVehicle(adminA, vehicleA.id as string, {
      version: 1,
      plate: 'GYE0123',
      vin: VALID_VIN,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      plate: 'GYE0123',
      vin: VALID_VIN,
      updatedBy: adminA.userId,
      updatedByName: 'Diego Admin',
    });
    const rows = await auditRowsAs(tenantA.id);
    expect(rows.map((row) => row.action).sort()).toEqual([
      'vehicle.plate_changed',
      'vehicle.vin_changed',
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        actor_user_id: adminA.userId,
        actor_name: 'Diego Admin',
        actor_role: 'admin',
        reason: null,
      });
    }
  });

  it.each([
    ['vacío', ''],
    ['de solo espacios', '      '],
  ])(
    'US4-AC16 el admin envía un motivo %s al cambiar la placa → cuenta como omitido: 200 y reason null',
    async (_label, reason) => {
      const res = await patchVehicle(adminA, vehicleA.id as string, {
        version: 1,
        plate: 'GYE0123',
        reason,
      });

      expect(res.status).toBe(200);
      const rows = await auditRowsAs(tenantA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_role: 'admin', reason: null });
    },
  );

  it('US4-AC16 el admin cambia el VIN con motivo válido → el motivo queda en la auditoría', async () => {
    const res = await patchVehicle(adminA, vehicleA.id as string, {
      version: 1,
      vin: VALID_VIN,
      reason: VALID_REASON,
    });

    expect(res.status).toBe(200);
    const rows = await auditRowsAs(tenantA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'vehicle.vin_changed',
      actor_role: 'admin',
      reason: VALID_REASON,
    });
  });

  it.each([
    ['la placa', { plate: 'GYE0123' }, '123456789'],
    ['la placa', { plate: 'GYE0123' }, 'x'.repeat(501)],
    ['el VIN', { vin: VALID_VIN }, '123456789'],
    ['el VIN', { vin: VALID_VIN }, 'x'.repeat(501)],
  ] as [string, Record<string, unknown>, string][])(
    'US4-AC16 el admin cambia %s con un motivo fuera de 10 a 500 caracteres → 400 REASON_REQUIRED, sin cambios ni auditoría',
    async (_what, change, reason) => {
      const res = await patchVehicle(adminA, vehicleA.id as string, {
        version: 1,
        ...change,
        reason,
      });

      expectReasonRequired(res);
      await expectVehicleAUnchanged();
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  // ---------------------------------------------------------------- Contract (VehicleUpdate)

  it('US4-AC7 ownerClientId en el body del PATCH → 400 UNKNOWN_FIELD: el propietario solo cambia por ownership-transfers', async () => {
    const carlos = await create(creatorA, 'clients', {
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: '1712345675',
      firstNames: 'Carlos',
      lastNames: 'Ruiz',
      phone: '0981234567',
    });

    for (const actor of [asesorA, adminA]) {
      const res = await patchVehicle(actor, vehicleA.id as string, {
        version: 1,
        ownerClientId: carlos.id,
        reason: VALID_REASON,
      });
      expectValidationError(res, 'ownerClientId', 'UNKNOWN_FIELD');
    }

    await expectVehicleAUnchanged();
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
  });

  it.each(['tenantId', 'tenant_id'])(
    'US4-AC13 %s en el body del PATCH → 400 UNKNOWN_FIELD, sin cambios en ningún taller',
    async (field) => {
      const res = await patchVehicle(asesorA, vehicleA.id as string, {
        version: 1,
        color: 'Negro',
        [field]: tenantB.id,
      });

      expectValidationError(res, field, 'UNKNOWN_FIELD');
      await expectVehicleAUnchanged();
      expect(
        await vehicleRowAs(tenantB.id, vehicleA.id as string),
      ).toBeUndefined();
    },
  );

  it('US4-AC12 PATCH sin version → 400 REQUIRED en version, sin cambios', async () => {
    const res = await patchVehicle(asesorA, vehicleA.id as string, {
      color: 'Negro',
    });

    expectValidationError(res, 'version', 'REQUIRED');
    await expectVehicleAUnchanged();
  });

  it('US4-AC6 PATCH sin token → 401 UNAUTHORIZED, sin cambios', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/vehicles/${vehicleA.id}`)
      .send({ version: 1, color: 'Negro' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
    await expectVehicleAUnchanged();
  });
});
