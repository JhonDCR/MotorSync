// T043: e2e of vehicle creation and retrieval (US3, US1-AC9, US4-AC3, FR-014) over the full app
// wiring (AppModule + configureApp) and the real PostgreSQL, the API connecting as motorsync_app.
// Contract: POST /api/v1/vehicles, GET /api/v1/vehicles/{vehicleId}, GET /api/v1/clients/{clientId}
// (VehicleCreate, VehicleDetail, ClientDetail.vehicles, Problem).
// Field codes travel in errors[].code with code = VALIDATION_ERROR (normative note of tasks.md);
// CLIENT_NOT_FOUND, NOT_FOUND and *_ALREADY_EXISTS travel in code.
// Every test builds its own tenants and owners (beforeEach): no dependency on db:seed:dev or on
// the order of the suites.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { authHeader, issueTestToken } from './setup/auth.js';
import {
  closeFixtures,
  createTenant,
  truncateBusinessTables,
  type TenantFixture,
} from './setup/db-fixtures.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

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
  token: string;
}

interface VehicleRow {
  id: string;
  tenant_id: string;
  owner_client_id: string;
  plate: string;
  vin: string | null;
}

describe('Vehicles (e2e, T043, US3)', () => {
  let app: INestApplication<App>;
  let appPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let actorA: Actor;
  let actorB: Actor;
  /** Body of POST /clients for "Ana Pérez" in tenant A (recreated in every test). */
  let ownerA: Record<string, unknown>;
  /** A client of tenant B (recreated in every test). */
  let ownerB: Record<string, unknown>;

  function actorOf(tenant: TenantFixture, name: string): Actor {
    const userId = randomUUID();
    return {
      userId,
      name,
      token: issueTestToken({
        tenantId: tenant.id,
        userId,
        role: 'asesor',
        name,
      }),
    };
  }

  function postClient(actor: Actor, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/clients')
      .set(authHeader(actor.token))
      .send(body);
  }

  function getClient(actor: Actor, id: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/clients/${id}`)
      .set(authHeader(actor.token));
  }

  function postVehicle(actor: Actor, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/v1/vehicles')
      .set(authHeader(actor.token))
      .send(body);
  }

  function getVehicle(actor: Actor, id: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/vehicles/${id}`)
      .set(authHeader(actor.token));
  }

  async function createClient(
    actor: Actor,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await postClient(actor, body);
    expect(res.status, 'owner creation via POST /clients').toBe(201);
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
    for (const error of errors) {
      expect(typeof error.message).toBe('string');
      expect(error.message.length).toBeGreaterThan(0);
    }
    return errors.find(
      (error) => error.field === field && (!code || error.code === code),
    ) as FieldErrorBody;
  }

  /** Rows of `vehicles` visible to motorsync_app with the tenant pinned (as the API sees them). */
  async function vehicleRowsAs(tenantId: string): Promise<VehicleRow[]> {
    const conn = await appPool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const result = await conn.query<VehicleRow>(
        'SELECT id, tenant_id, owner_client_id, plate, vin FROM vehicles ORDER BY created_at',
      );
      await conn.query('ROLLBACK');
      return result.rows;
    } finally {
      conn.release();
    }
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
    tenantA = await createTenant(`Taller A vehicles e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B vehicles e2e ${randomUUID()}`);
    actorA = actorOf(tenantA, 'Ana Asesora');
    actorB = actorOf(tenantB, 'Bruno Salazar');
    ownerA = await createClient(actorA, {
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: '1710034065',
      firstNames: 'Ana',
      lastNames: 'Pérez',
      phone: '0991234567',
      email: 'ana.perez@example.com',
    });
    ownerB = await createClient(actorB, {
      clientType: 'natural',
      documentType: 'passport',
      documentNumber: 'BB998877',
      firstNames: 'Beatriz',
      lastNames: 'Torres',
      phone: '0987654321',
    });
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US3-AC1

  it('US3-AC1 registra un vehículo para Ana Pérez → 201 VehicleDetail con Location y owner', async () => {
    const before = Date.now();
    const res = await postVehicle(actorA, sedan(ownerA.id as string));

    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.id).toMatch(UUID_RE);
    expect(res.headers.location).toBe(`/api/v1/vehicles/${res.body.id}`);
    expect(res.body).toMatchObject({
      plate: 'PBA1234',
      vin: null,
      brand: 'Toyota',
      model: 'Corolla',
      year: 2020,
      color: 'Blanco',
      bodyType: 'sedan',
      initialMileage: 45000,
      version: 1,
      updatedBy: actorA.userId,
      updatedByName: 'Ana Asesora',
    });
    expect(res.body.owner).toEqual({
      id: ownerA.id,
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: '1710034065',
      displayName: 'Ana Pérez',
      phone: '0991234567',
      email: 'ana.perez@example.com',
    });
    expect(res.body).not.toHaveProperty('tenantId');
    expect(res.body).not.toHaveProperty('tenant_id');
    expect(res.body).not.toHaveProperty('ownerClientId');
    expect(res.body.createdAt).toMatch(ISO_UTC_RE);
    expect(res.body.updatedAt).toMatch(ISO_UTC_RE);
    expect(Date.parse(res.body.createdAt as string)).toBeGreaterThanOrEqual(
      before - 5_000,
    );
  });

  it('US3-AC1 GET /api/v1/vehicles/{id} devuelve la ficha recién creada con su owner', async () => {
    const created = await postVehicle(actorA, sedan(ownerA.id as string));
    expect(created.status).toBe(201);

    const res = await getVehicle(actorA, created.body.id as string);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual(created.body);
    expect(res.body.owner).toMatchObject({
      id: ownerA.id,
      displayName: 'Ana Pérez',
    });
  });

  it('US3-AC1 recorta brand, model y color', async () => {
    const res = await postVehicle(
      actorA,
      sedan(ownerA.id as string, {
        brand: '  Toyota ',
        model: ' Corolla  ',
        color: '  Blanco perla ',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      brand: 'Toyota',
      model: 'Corolla',
      color: 'Blanco perla',
    });
  });

  it('US3-AC1 POST /vehicles sin token → 401 UNAUTHORIZED y no se guarda', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vehicles')
      .send(sedan(ownerA.id as string));

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- US4-AC3

  it('US4-AC3 la ficha del cliente lista sus vehículos (VehicleSummary) ordenados por placa', async () => {
    const plates = ['PBA1299', 'GYE0123', 'PBA1234'];
    const created: Record<string, unknown>[] = [];
    for (const plate of plates) {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { plate, model: `Modelo ${plate}` }),
      );
      expect(res.status).toBe(201);
      created.push(res.body as Record<string, unknown>);
    }
    // A vehicle of another client of A must not appear in Ana's file.
    const other = await createClient(actorA, {
      clientType: 'natural',
      documentType: 'passport',
      documentNumber: 'AB123456',
      firstNames: 'Otro',
      lastNames: 'Cliente',
      phone: '0991112223',
    });
    const otherVehicle = await postVehicle(
      actorA,
      sedan(other.id as string, { plate: 'ABC123' }),
    );
    expect(otherVehicle.status).toBe(201);

    const res = await getClient(actorA, ownerA.id as string);

    expect(res.status).toBe(200);
    const byPlate = (plate: string) =>
      created.find((vehicle) => vehicle.plate === plate) as Record<
        string,
        unknown
      >;
    expect(res.body.vehicles).toEqual(
      ['GYE0123', 'PBA1234', 'PBA1299'].map((plate) => ({
        id: byPlate(plate).id,
        plate,
        brand: 'Toyota',
        model: `Modelo ${plate}`,
        year: 2020,
      })),
    );
  });

  // ---------------------------------------------------------------- US3-AC2

  it.each(['pba-1234', 'PBA-1234', ' pba 1234 ', 'Pba1234'])(
    'US3-AC2 la placa "%s" se guarda y se muestra como PBA1234',
    async (plate) => {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { plate }),
      );

      expect(res.status).toBe(201);
      expect(res.body.plate).toBe('PBA1234');
      const rows = await vehicleRowsAs(tenantA.id);
      expect(rows).toEqual([
        expect.objectContaining({ id: res.body.id, plate: 'PBA1234' }),
      ]);
    },
  );

  // ---------------------------------------------------------------- US3-AC3

  it.each(['PBA-1234', 'pba 1234', 'PBA1234'])(
    'US3-AC3 placa ya registrada en el taller, enviada como "%s" → 409 PLATE_ALREADY_EXISTS con existingId',
    async (repeated) => {
      const first = await postVehicle(actorA, sedan(ownerA.id as string));
      expect(first.status).toBe(201);

      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, {
          plate: repeated,
          brand: 'Chevrolet',
          model: 'Aveo',
        }),
      );

      expect(res.status).toBe(409);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({
        status: 409,
        code: 'PLATE_ALREADY_EXISTS',
        existingId: first.body.id,
      });
      const rows = await vehicleRowsAs(tenantA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.body.id);
    },
  );

  // ---------------------------------------------------------------- US3-AC4

  it.each([
    ['1HGCM82633A00435', '16 caracteres'],
    ['1HGCM82633A0043521', '18 caracteres'],
    ['1HGCM82633I004352', 'contiene I'],
    ['1HGCM82633O004352', 'contiene O'],
    ['1HGCM82633Q004352', 'contiene Q'],
    ['1HGCM82633A00435*', 'contiene *'],
    ['1HGCM.82633A004352', 'contiene un punto'],
  ])(
    'US3-AC4 VIN %s (%s) → 400 INVALID_VIN "VIN inválido" y no se guarda',
    async (vin) => {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { vin }),
      );

      const error = expectValidationError(res, 'vin', 'INVALID_VIN');
      expect(error.message).toMatch(/^VIN inválido/);
      expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('US3-AC4 el VIN se guarda en mayúsculas sin espacios ni guiones', async () => {
    const res = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { vin: ' 1hgcm-82633 a004352 ' }),
    );

    expect(res.status).toBe(201);
    expect(res.body.vin).toBe(VALID_VIN);
    const rows = await vehicleRowsAs(tenantA.id);
    expect(rows).toEqual([
      expect.objectContaining({ id: res.body.id, vin: VALID_VIN }),
    ]);
  });

  // ---------------------------------------------------------------- US3-AC5

  it.each([VALID_VIN, '1hgcm-82633-a004352'])(
    'US3-AC5 VIN ya registrado en el taller, enviado como "%s" → 409 VIN_ALREADY_EXISTS con existingId',
    async (repeated) => {
      const first = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { vin: VALID_VIN }),
      );
      expect(first.status).toBe(201);

      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { plate: 'GYE0123', vin: repeated }),
      );

      expect(res.status).toBe(409);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({
        status: 409,
        code: 'VIN_ALREADY_EXISTS',
        existingId: first.body.id,
      });
      expect(await vehicleRowsAs(tenantA.id)).toHaveLength(1);
    },
  );

  // ---------------------------------------------------------------- US3-AC6

  it('US3-AC6 sin VIN (omitido o null) se acepta y varios vehículos sin VIN conviven', async () => {
    const omitted = sedan(ownerA.id as string, { plate: 'PBA1234' });
    delete omitted.vin;
    const first = await postVehicle(actorA, omitted);
    const second = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { plate: 'GYE0123', vin: null }),
    );
    const third = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { plate: 'PBA1299', vin: OTHER_VALID_VIN }),
    );

    expect(first.status).toBe(201);
    expect(first.body.vin).toBeNull();
    expect(second.status).toBe(201);
    expect(second.body.vin).toBeNull();
    expect(third.status).toBe(201);
    const rows = await vehicleRowsAs(tenantA.id);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.vin === null)).toHaveLength(2);
  });

  // ---------------------------------------------------------------- US3-AC7

  it('US3-AC7 año 1949 → 400 INVALID_YEAR y no se guarda', async () => {
    const res = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { year: 1949 }),
    );
    expectValidationError(res, 'year', 'INVALID_YEAR');
    expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
  });

  it('US3-AC7 año UTC en curso + 2 → 400 INVALID_YEAR y no se guarda', async () => {
    const year = new Date().getUTCFullYear() + 2;
    const res = await postVehicle(actorA, sedan(ownerA.id as string, { year }));
    expectValidationError(res, 'year', 'INVALID_YEAR');
    expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
  });

  it.each([2020.5, '2020'])(
    'US3-AC7 año no entero %s → 400 INVALID_YEAR',
    async (year) => {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { year }),
      );
      expectValidationError(res, 'year', 'INVALID_YEAR');
    },
  );

  it('US3-AC7 años límite 1950 y año UTC en curso + 1 → 201', async () => {
    const maxYear = new Date().getUTCFullYear() + 1;
    const oldest = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { plate: 'PBA1234', year: 1950 }),
    );
    const newest = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { plate: 'GYE0123', year: maxYear }),
    );

    expect(oldest.status).toBe(201);
    expect(oldest.body.year).toBe(1950);
    expect(newest.status).toBe(201);
    expect(newest.body.year).toBe(maxYear);
  });

  it.each([-1, 1.5, 10_000_000])(
    'US3-AC7 kilometraje %s → 400 INVALID_MILEAGE y no se guarda',
    async (initialMileage) => {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { initialMileage }),
      );
      expectValidationError(res, 'initialMileage', 'INVALID_MILEAGE');
      expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('US3-AC7 kilometrajes límite 0 y 9 999 999 → 201', async () => {
    const zero = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { plate: 'PBA1234', initialMileage: 0 }),
    );
    const max = await postVehicle(
      actorA,
      sedan(ownerA.id as string, {
        plate: 'GYE0123',
        initialMileage: 9_999_999,
      }),
    );

    expect(zero.status).toBe(201);
    expect(zero.body.initialMileage).toBe(0);
    expect(max.status).toBe(201);
    expect(max.body.initialMileage).toBe(9_999_999);
  });

  // ---------------------------------------------------------------- US3-AC8

  it.each(['truck', 'Sedan', 'moto', ''])(
    'US3-AC8 bodyType "%s" fuera del enum → 400 VALIDATION_ERROR en bodyType y no se guarda',
    async (bodyType) => {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { bodyType }),
      );
      expectValidationError(res, 'bodyType');
      expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it.each([
    ['sedan', 'PBA1234'],
    ['suv', 'PBA1234'],
    ['pickup', 'PBA1234'],
    ['other', 'PBA1234'],
    ['motorcycle', 'AB123C'],
  ])('US3-AC8 bodyType %s del enum → 201', async (bodyType, plate) => {
    const res = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { bodyType, plate }),
    );
    expect(res.status).toBe(201);
    expect(res.body.bodyType).toBe(bodyType);
  });

  // ---------------------------------------------------------------- US3-AC10

  it('US3-AC10 la placa PBA1234 registrada en el taller B → el taller A la registra con 201 sin revelar nada', async () => {
    const inB = await postVehicle(actorB, sedan(ownerB.id as string));
    expect(inB.status).toBe(201);

    const inA = await postVehicle(actorA, sedan(ownerA.id as string));

    expect(inA.status).toBe(201);
    expect(inA.body.id).not.toBe(inB.body.id);
    expect(inA.body).not.toHaveProperty('existingId');
    expect(inA.body.plate).toBe('PBA1234');
    expect(await vehicleRowsAs(tenantA.id)).toEqual([
      expect.objectContaining({ id: inA.body.id, tenant_id: tenantA.id }),
    ]);
    expect(await vehicleRowsAs(tenantB.id)).toEqual([
      expect.objectContaining({ id: inB.body.id, tenant_id: tenantB.id }),
    ]);
  });

  it('US3-AC10 el mismo VIN registrado en el taller B → el taller A lo registra con 201', async () => {
    const inB = await postVehicle(
      actorB,
      sedan(ownerB.id as string, { vin: VALID_VIN }),
    );
    expect(inB.status).toBe(201);

    const inA = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { vin: VALID_VIN }),
    );
    expect(inA.status).toBe(201);
    expect(inA.body.vin).toBe(VALID_VIN);
  });

  // ---------------------------------------------------------------- US3-AC11

  it('US3-AC11 ownerClientId de un cliente del taller B → 404 CLIENT_NOT_FOUND y no crea nada', async () => {
    const res = await postVehicle(actorA, sedan(ownerB.id as string));

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: 'CLIENT_NOT_FOUND' });
    expect(JSON.stringify(res.body)).not.toContain('BB998877');
    expect(JSON.stringify(res.body)).not.toContain('Beatriz');
    expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
    expect(await vehicleRowsAs(tenantB.id)).toHaveLength(0);
  });

  it('US3-AC11 el cliente de B responde igual que un ownerClientId inexistente', async () => {
    const fromB = await postVehicle(actorA, sedan(ownerB.id as string));
    const missing = await postVehicle(actorA, sedan(randomUUID()));

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'CLIENT_NOT_FOUND' });
    expect(fromB.body).toEqual(missing.body);
    expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- US3-AC12

  it.each([
    ['sedan', 'PBA123'],
    ['sedan', 'PBA1234'],
    ['suv', 'GYE0123'],
    ['pickup', 'abc-123'],
    ['other', 'XYZ 9876'],
  ])(
    'US3-AC12 carrocería %s con placa de auto "%s" → 201',
    async (bodyType, plate) => {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { bodyType, plate }),
      );
      expect(res.status).toBe(201);
    },
  );

  it.each([
    ['sedan', 'PB1234'],
    ['sedan', 'PBA12'],
    ['sedan', 'PBA12345'],
    ['sedan', '1234PBA'],
    ['sedan', 'AB123C'],
    ['suv', 'AB123C'],
    ['pickup', 'PB1234'],
    ['other', 'PBA12'],
  ])(
    'US3-AC12 carrocería %s con placa "%s" → 400 INVALID_PLATE con el mensaje de autos',
    async (bodyType, plate) => {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { bodyType, plate }),
      );

      const error = expectValidationError(res, 'plate', 'INVALID_PLATE');
      expect(error.message).toBe(CAR_PLATE_MESSAGE);
      expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  // ---------------------------------------------------------------- US3-AC13

  it.each(['AB123C', 'ab-123c', 'ab 123 c'])(
    'US3-AC13 moto con placa "%s" → 201 normalizada como AB123C',
    async (plate) => {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { bodyType: 'motorcycle', plate }),
      );
      expect(res.status).toBe(201);
      expect(res.body.plate).toBe('AB123C');
    },
  );

  it.each(['PBA1234', 'AB1234', 'PBA123', 'A123BC'])(
    'US3-AC13 moto con placa "%s" → 400 INVALID_PLATE con el mensaje de motos',
    async (plate) => {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { bodyType: 'motorcycle', plate }),
      );

      const error = expectValidationError(res, 'plate', 'INVALID_PLATE');
      expect(error.message).toBe(MOTORCYCLE_PLATE_MESSAGE);
      expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  // ---------------------------------------------------------------- US3-AC14

  it.each([
    ['sedan', 'PBA*1234'],
    ['sedan', 'PBA.1234'],
    ['sedan', 'PBA_1234'],
    ['motorcycle', 'AB*123C'],
  ])(
    'US3-AC14 carrocería %s con placa "%s" (carácter no permitido) → 400 INVALID_PLATE, no se limpia en silencio',
    async (bodyType, plate) => {
      const res = await postVehicle(
        actorA,
        sedan(ownerA.id as string, { bodyType, plate }),
      );

      const error = expectValidationError(res, 'plate', 'INVALID_PLATE');
      expect(error.message).toMatch(/^Placa inválida/);
      expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('US3-AC14 la misma placa se valida con el formato de la carrocería enviada (AB123C: moto sí, sedán no)', async () => {
    const asSedan = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { bodyType: 'sedan', plate: 'AB123C' }),
    );
    expectValidationError(asSedan, 'plate', 'INVALID_PLATE');

    const asMotorcycle = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { bodyType: 'motorcycle', plate: 'AB123C' }),
    );
    expect(asMotorcycle.status).toBe(201);
  });

  // ---------------------------------------------------------------- US1-AC9

  it('US1-AC9 un usuario del taller B abre el vehículo de A por id → 404 NOT_FOUND, igual que uno inexistente', async () => {
    const created = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { vin: VALID_VIN }),
    );
    expect(created.status).toBe(201);

    const fromB = await getVehicle(actorB, created.body.id as string);
    const missing = await getVehicle(actorB, randomUUID());

    expect(fromB.status).toBe(404);
    expect(fromB.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(fromB.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(fromB.body).toEqual(missing.body);
    const leaked = JSON.stringify(fromB.body);
    for (const secret of ['PBA1234', VALID_VIN, '1710034065', 'Ana']) {
      expect(leaked).not.toContain(secret);
    }
  });

  it('US1-AC9 B con X-Tenant-Id de A tampoco ve el vehículo de A → 404 NOT_FOUND', async () => {
    const created = await postVehicle(actorA, sedan(ownerA.id as string));
    expect(created.status).toBe(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/vehicles/${created.body.id}`)
      .set(authHeader(actorB.token))
      .set('X-Tenant-Id', tenantA.id);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('US1-AC9 GET /vehicles/{id} con un uuid inexistente o un id que no es uuid → 404 NOT_FOUND', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await getVehicle(actorA, id);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
  });

  // ---------------------------------------------------------------- FR-014

  it('FR-014 el vehículo queda con exactamente un propietario: owner_client_id en la BD y owner en la ficha', async () => {
    const res = await postVehicle(actorA, sedan(ownerA.id as string));
    expect(res.status).toBe(201);

    const rows = await vehicleRowsAs(tenantA.id);
    expect(rows).toEqual([
      expect.objectContaining({
        id: res.body.id,
        owner_client_id: ownerA.id,
        tenant_id: tenantA.id,
      }),
    ]);
    const detail = await getVehicle(actorA, res.body.id as string);
    expect(detail.body.owner).toBeTypeOf('object');
    expect(Array.isArray(detail.body.owner)).toBe(false);
    expect(detail.body.owner.id).toBe(ownerA.id);
  });

  it.each([
    ['omitido', undefined],
    ['null', null],
  ])(
    'FR-014 ownerClientId %s → 400 REQUIRED en ownerClientId y no se guarda',
    async (_label, ownerClientId) => {
      const body = sedan(ownerA.id as string);
      if (ownerClientId === undefined) delete body.ownerClientId;
      else body.ownerClientId = ownerClientId;

      const res = await postVehicle(actorA, body);

      expectValidationError(res, 'ownerClientId', 'REQUIRED');
      expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('FR-014 ownerClientId que no es uuid → 400 VALIDATION_ERROR en ownerClientId', async () => {
    const res = await postVehicle(
      actorA,
      sedan(ownerA.id as string, { ownerClientId: 'not-a-uuid' }),
    );
    expectValidationError(res, 'ownerClientId');
    expect(await vehicleRowsAs(tenantA.id)).toHaveLength(0);
  });
});
