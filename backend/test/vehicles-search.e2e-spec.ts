// T053: e2e of the vehicle search (US1-AC1 to US1-AC8, FR-001 to FR-003, FR-023) over the full
// app wiring (AppModule + configureApp) and the real PostgreSQL, the API connecting as motorsync_app.
// Contract: GET /api/v1/vehicles/search?q= → VehicleSearchResponse { items, hasMore } (max 20 items),
// each item = VehicleSummary + { vin, color, bodyType, initialMileage, owner: ClientSummary };
// 400 SEARCH_TERM_TOO_SHORT (problem+json) when q has fewer than 2 characters after normalizing
// (uppercase, only [A-Z0-9]: in the search any other character is discarded, FR-002).
// Reference query: data-model.md "Búsqueda de vehículos" (plate contains, VIN only by equality;
// exact → prefix → contains, then plate; LIMIT 21).
// US1-AC9 lives in vehicles.e2e-spec.ts (T043); US1-AC10 (performance) in test/perf (T059).
// Every test builds its own tenants, owners and vehicles through POST /api/v1/clients and
// POST /api/v1/vehicles (beforeEach): no dependency on db:seed:dev or on the order of the suites.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
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

const VALID_VIN = '1HGCM82633A004352';
const OTHER_VALID_VIN = '2T1BURHE0JC123456';

interface ClientSummaryBody {
  id: string;
  clientType: string;
  documentType: string;
  documentNumber: string;
  displayName: string;
  phone: string;
  email: string | null;
}

interface VehicleSearchItemBody {
  id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
  vin: string | null;
  color: string;
  bodyType: string;
  initialMileage: number;
  owner: ClientSummaryBody;
}

interface SearchBody {
  items: VehicleSearchItemBody[];
  hasMore: boolean;
}

interface CreatedVehicle {
  id: string;
  plate: string;
}

describe('Vehicles search (e2e, T053, US1)', () => {
  let app: INestApplication<App>;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let tokenB: string;
  /** "Ana Pérez" in tenant A (recreated in every test). */
  let ownerA: ClientSummaryBody;
  /** "Beatriz Torres" in tenant B (recreated in every test). */
  let ownerB: ClientSummaryBody;

  function tokenOf(tenant: TenantFixture, name: string): string {
    return issueTestToken({
      tenantId: tenant.id,
      userId: randomUUID(),
      role: 'asesor',
      name,
    });
  }

  async function createClient(
    token: string,
    body: Record<string, unknown>,
  ): Promise<ClientSummaryBody> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/clients')
      .set(authHeader(token))
      .send(body);
    expect(res.status, `owner via POST /clients: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as ClientSummaryBody;
  }

  async function createVehicle(
    token: string,
    ownerClientId: string,
    plate: string,
    overrides: Record<string, unknown> = {},
  ): Promise<CreatedVehicle> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/vehicles')
      .set(authHeader(token))
      .send({
        ownerClientId,
        plate,
        brand: 'Toyota',
        model: 'Corolla',
        year: 2020,
        color: 'Blanco',
        bodyType: 'sedan',
        initialMileage: 45000,
        ...overrides,
      });
    expect(res.status, `vehicle ${plate} via POST /vehicles: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body as CreatedVehicle;
  }

  function search(token: string, q: string) {
    return request(app.getHttpServer())
      .get('/api/v1/vehicles/search')
      .query({ q })
      .set(authHeader(token));
  }

  async function searchOk(token: string, q: string): Promise<SearchBody> {
    const res = await search(token, q);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(typeof res.body.hasMore).toBe('boolean');
    return res.body as SearchBody;
  }

  function plates(body: SearchBody): string[] {
    return body.items.map((item) => item.plate);
  }

  function expectTooShort(res: request.Response): void {
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 400, code: 'SEARCH_TERM_TOO_SHORT' });
    expect(
      typeof res.body.detail === 'string' || typeof res.body.title === 'string',
    ).toBe(true);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  beforeEach(async () => {
    await truncateBusinessTables();
    tenantA = await createTenant(`Taller A vehicles search e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B vehicles search e2e ${randomUUID()}`);
    tokenA = tokenOf(tenantA, 'Ana Asesora');
    tokenB = tokenOf(tenantB, 'Bruno Salazar');
    ownerA = await createClient(tokenA, {
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: '1710034065',
      firstNames: 'Ana',
      lastNames: 'Pérez',
      phone: '0991234567',
      email: 'ana.perez@example.com',
    });
    ownerB = await createClient(tokenB, {
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
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- Routing / contract

  it('US1-AC1 GET /vehicles/search es su propia ruta (no se confunde con /vehicles/:vehicleId) y responde VehicleSearchResponse', async () => {
    const res = await search(tokenA, 'PBA1234');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });

  it('US1-AC1 sin token → 401 UNAUTHORIZED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/vehicles/search')
      .query({ q: 'PBA1234' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  // ---------------------------------------------------------------- US1-AC1

  it('US1-AC1 buscar PBA1234 → es el primer resultado, con todos los campos del vehículo y del propietario', async () => {
    const target = await createVehicle(tokenA, ownerA.id, 'PBA1234', {
      vin: VALID_VIN,
      brand: 'Chevrolet',
      model: 'Aveo',
      year: 2018,
      color: 'Rojo',
      bodyType: 'sedan',
      initialMileage: 87500,
    });
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, 'PBA1234');

    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toEqual({
      id: target.id,
      plate: 'PBA1234',
      brand: 'Chevrolet',
      model: 'Aveo',
      year: 2018,
      vin: VALID_VIN,
      color: 'Rojo',
      bodyType: 'sedan',
      initialMileage: 87500,
      owner: {
        id: ownerA.id,
        clientType: 'natural',
        documentType: 'cedula',
        documentNumber: '1710034065',
        displayName: 'Ana Pérez',
        phone: '0991234567',
        email: 'ana.perez@example.com',
      },
    });
    expect(plates(body)).not.toContain('GYE0123');
    expect(body.items[0]).not.toHaveProperty('tenantId');
    expect(body.items[0]).not.toHaveProperty('tenant_id');
    expect(body.items[0]).not.toHaveProperty('ownerClientId');
    expect(body.hasMore).toBe(false);
  });

  it('US1-AC1 sin VIN registrado el item trae vin: null; un propietario sin correo trae email: null', async () => {
    const owner = await createClient(tokenA, {
      clientType: 'company',
      documentType: 'ruc',
      documentNumber: '1790011674001',
      businessName: 'Transportes Andinos S.A.',
      phone: '022345678',
    });
    const target = await createVehicle(tokenA, owner.id, 'PBA1234', {
      bodyType: 'pickup',
    });

    const body = await searchOk(tokenA, 'PBA1234');

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: target.id,
      vin: null,
      bodyType: 'pickup',
      owner: {
        id: owner.id,
        clientType: 'company',
        documentType: 'ruc',
        documentNumber: '1790011674001',
        displayName: 'Transportes Andinos S.A.',
        email: null,
      },
    });
  });

  // ---------------------------------------------------------------- US1-AC2

  it.each(['pba-1234', 'PBA 1234', ' pba1234 '])(
    'US1-AC2 "%s" se normaliza y da el mismo resultado que PBA1234',
    async (q) => {
      const target = await createVehicle(tokenA, ownerA.id, 'PBA1234');
      await createVehicle(tokenA, ownerA.id, 'GYE0123');

      const variant = await searchOk(tokenA, q);
      const plain = await searchOk(tokenA, 'PBA1234');

      expect(variant.items[0]?.id).toBe(target.id);
      expect(variant).toEqual(plain);
    },
  );

  // ---------------------------------------------------------------- US1-AC3

  it('US1-AC3 el fragmento BA12 → PBA1234 y PBA1299, sin GYE0123', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1234');
    await createVehicle(tokenA, ownerA.id, 'PBA1299');
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, 'BA12');

    expect(plates(body).sort()).toEqual(['PBA1234', 'PBA1299']);
    expect(plates(body)).not.toContain('GYE0123');
    expect(body.hasMore).toBe(false);
  });

  it('US1-AC3 el fragmento en minúsculas (ba12) encuentra lo mismo', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1234');
    await createVehicle(tokenA, ownerA.id, 'PBA1299');
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, 'ba12');

    expect(plates(body).sort()).toEqual(['PBA1234', 'PBA1299']);
  });

  it('US1-AC3 FR-001 el fragmento puede estar al final de la placa (0123 → GYE0123)', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1234');
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, '0123');

    expect(plates(body)).toEqual(['GYE0123']);
  });

  it('US1-AC3 FR-001 una placa de moto se encuentra por fragmento (B123 → AB123C)', async () => {
    await createVehicle(tokenA, ownerA.id, 'AB123C', {
      bodyType: 'motorcycle',
      brand: 'Honda',
      model: 'CB190',
    });
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, 'B123');

    expect(plates(body)).toEqual(['AB123C']);
    expect(body.items[0]?.bodyType).toBe('motorcycle');
  });

  // ---------------------------------------------------------------- US1-AC4 ordering

  it('US1-AC4 FR-003 exacta antes que prefijo: PBA123 → PBA123, luego PBA1230 y PBA1239', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1239');
    await createVehicle(tokenA, ownerA.id, 'PBA1230');
    await createVehicle(tokenA, ownerA.id, 'PBA123');
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, 'PBA123');

    expect(plates(body)).toEqual(['PBA123', 'PBA1230', 'PBA1239']);
  });

  it('US1-AC4 FR-003 prefijo antes que contiene, por encima del orden alfabético (ZA12 → ZA123C antes que AZA1234)', async () => {
    // Alphabetical order would put AZA1234 first: only relevance puts the prefix match first.
    await createVehicle(tokenA, ownerA.id, 'AZA1234');
    await createVehicle(tokenA, ownerA.id, 'ZA123C', {
      bodyType: 'motorcycle',
      brand: 'Honda',
      model: 'CB190',
    });
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, 'ZA12');

    expect(plates(body)).toEqual(['ZA123C', 'AZA1234']);
  });

  it('US1-AC4 FR-003 la coincidencia exacta por VIN cuenta como exacta y no arrastra otros vehículos', async () => {
    const byVin = await createVehicle(tokenA, ownerA.id, 'ZZZ9999', {
      vin: VALID_VIN,
    });
    await createVehicle(tokenA, ownerA.id, 'PBA1234', { vin: OTHER_VALID_VIN });

    const body = await searchOk(tokenA, VALID_VIN);

    expect(body.items.map((item) => item.id)).toEqual([byVin.id]);
  });

  it('US1-AC4 FR-003 dentro del mismo nivel de relevancia ordena por placa', async () => {
    await createVehicle(tokenA, ownerA.id, 'XBA1200');
    await createVehicle(tokenA, ownerA.id, 'PBA1299');
    await createVehicle(tokenA, ownerA.id, 'ABA1234');
    await createVehicle(tokenA, ownerA.id, 'PBA1234');

    const body = await searchOk(tokenA, 'BA12');

    expect(plates(body)).toEqual(['ABA1234', 'PBA1234', 'PBA1299', 'XBA1200']);
  });

  // ---------------------------------------------------------------- US1-AC4 limit

  it('US1-AC4 FR-003 25 coincidencias → 20 items y hasMore: true', async () => {
    for (let i = 0; i < 25; i++) {
      await createVehicle(tokenA, ownerA.id, `PBA${1000 + i}`);
    }

    const body = await searchOk(tokenA, 'PBA1');

    expect(body.items).toHaveLength(20);
    expect(body.hasMore).toBe(true);
    expect(new Set(body.items.map((item) => item.id)).size).toBe(20);
    // Same relevance level (prefix): ordered by plate, so the first 20 plates are returned.
    expect(plates(body)).toEqual(
      Array.from({ length: 20 }, (_, i) => `PBA${1000 + i}`),
    );
  });

  it('US1-AC4 FR-003 exactamente 20 coincidencias → 20 items y hasMore: false', async () => {
    for (let i = 0; i < 20; i++) {
      await createVehicle(tokenA, ownerA.id, `PBA${1000 + i}`);
    }

    const body = await searchOk(tokenA, 'PBA1');

    expect(body.items).toHaveLength(20);
    expect(body.hasMore).toBe(false);
  });

  // ---------------------------------------------------------------- US1-AC5

  it.each([
    ['P', '1 carácter válido'],
    ['  p  ', '1 carácter tras quitar espacios'],
    ['*%', 'solo caracteres que se descartan'],
    ['P*', '1 carácter válido tras descartar "*"'],
    ['%%', 'solo "%"'],
    ['__', 'solo "_"'],
    ['- -', 'solo espacios y guiones'],
    ['', 'vacío'],
  ])(
    'US1-AC5 término "%s" (%s) → 400 SEARCH_TERM_TOO_SHORT en problem+json',
    async (q) => {
      await createVehicle(tokenA, ownerA.id, 'PBA1234');

      expectTooShort(await search(tokenA, q));
    },
  );

  it('US1-AC5 sin el parámetro q → 400 SEARCH_TERM_TOO_SHORT', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/vehicles/search')
      .set(authHeader(tokenA));

    expectTooShort(res);
  });

  it('US1-AC5 2 caracteres válidos es el mínimo → 200 (pb → PBA1234)', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1234');
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, 'pb');

    expect(plates(body)).toEqual(['PBA1234']);
  });

  // ---------------------------------------------------------------- FR-002 discarded characters / LIKE

  it('FR-002 en la búsqueda los caracteres no alfanuméricos se descartan: PBA*12 → PBA1234', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1234');
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, 'PBA*12');

    expect(plates(body)).toEqual(['PBA1234']);
  });

  it('FR-002 "%" no actúa como comodín: P%4 se busca como P4 y no encuentra PBA1234', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1234');
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, 'P%4');

    expect(body).toEqual({ items: [], hasMore: false });
  });

  it('FR-002 "_" no actúa como comodín: P_A1234 se busca como PA1234 y no encuentra PBA1234', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1234');

    const body = await searchOk(tokenA, 'P_A1234');

    expect(body).toEqual({ items: [], hasMore: false });
  });

  it('FR-002 "\\" no escapa nada: PB\\A1 se busca como PBA1 y encuentra PBA1234', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1234');
    await createVehicle(tokenA, ownerA.id, 'GYE0123');

    const body = await searchOk(tokenA, 'PB\\A1');

    expect(plates(body)).toEqual(['PBA1234']);
  });

  it('FR-002 un término con comodines y 2 caracteres válidos no devuelve todas las placas (%B%A% → BA)', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1234');
    await createVehicle(tokenA, ownerA.id, 'GYE0123');
    await createVehicle(tokenA, ownerA.id, 'ABC1234');

    const body = await searchOk(tokenA, '%B%A%');

    expect(plates(body)).toEqual(['PBA1234']);
  });

  // ---------------------------------------------------------------- US1-AC6

  it('US1-AC6 una placa completa inexistente → 200 con items vacío y hasMore: false', async () => {
    await createVehicle(tokenA, ownerA.id, 'PBA1234');

    const res = await search(tokenA, 'GYE9999');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });

  // ---------------------------------------------------------------- US1-AC7

  it('US1-AC7 buscar por el VIN completo → el vehículo y su propietario', async () => {
    const target = await createVehicle(tokenA, ownerA.id, 'PBA1234', {
      vin: VALID_VIN,
    });
    await createVehicle(tokenA, ownerA.id, 'GYE0123', { vin: OTHER_VALID_VIN });

    const body = await searchOk(tokenA, VALID_VIN);

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: target.id,
      plate: 'PBA1234',
      vin: VALID_VIN,
      owner: { id: ownerA.id, displayName: 'Ana Pérez' },
    });
    expect(body.hasMore).toBe(false);
  });

  it('US1-AC7 FR-002 el VIN se normaliza en la búsqueda (minúsculas, espacios y guiones)', async () => {
    const target = await createVehicle(tokenA, ownerA.id, 'PBA1234', {
      vin: VALID_VIN,
    });

    const body = await searchOk(tokenA, ' 1hgcm-82633 a004352 ');

    expect(body.items.map((item) => item.id)).toEqual([target.id]);
  });

  it.each([
    ['HGCM82633A00', 'fragmento intermedio'],
    ['1HGCM82633A00435', 'los primeros 16 caracteres'],
    ['004352', 'el final'],
  ])(
    'US1-AC7 FR-001 un fragmento de VIN (%s, %s) no coincide por VIN → items vacío',
    async (q) => {
      await createVehicle(tokenA, ownerA.id, 'PBA1234', { vin: VALID_VIN });

      const body = await searchOk(tokenA, q);

      expect(body).toEqual({ items: [], hasMore: false });
    },
  );

  // ---------------------------------------------------------------- US1-AC8 isolation

  it('US1-AC8 PBA1234 solo en B: A busca PBA1234 o BA12 → items vacío, igual que una placa inexistente', async () => {
    await createVehicle(tokenB, ownerB.id, 'PBA1234', { vin: VALID_VIN });

    const nonexistent = await search(tokenA, 'GYE9999');
    const exact = await search(tokenA, 'PBA1234');
    const fragment = await search(tokenA, 'BA12');

    expect(nonexistent.status).toBe(200);
    expect(nonexistent.body).toEqual({ items: [], hasMore: false });
    for (const res of [exact, fragment]) {
      expect(res.status).toBe(nonexistent.status);
      expect(res.headers['content-type']).toBe(
        nonexistent.headers['content-type'],
      );
      expect(res.body).toEqual(nonexistent.body);
      expect(JSON.stringify(res.body)).not.toContain('Beatriz');
    }
  });

  it('US1-AC8 el taller B sí encuentra su propio PBA1234 (los datos existen; A no los ve)', async () => {
    const inB = await createVehicle(tokenB, ownerB.id, 'PBA1234');

    const fromB = await searchOk(tokenB, 'PBA1234');

    expect(fromB.items.map((item) => item.id)).toEqual([inB.id]);
    expect(fromB.items[0]?.owner).toMatchObject({
      id: ownerB.id,
      displayName: 'Beatriz Torres',
      email: null,
    });
  });

  it('US1-AC8 la misma placa en A y en B: cada taller solo ve la suya, con su propietario', async () => {
    const inA = await createVehicle(tokenA, ownerA.id, 'PBA1234');
    const inB = await createVehicle(tokenB, ownerB.id, 'PBA1234');

    const fromA = await searchOk(tokenA, 'BA12');
    const fromB = await searchOk(tokenB, 'BA12');

    expect(fromA.items.map((item) => item.id)).toEqual([inA.id]);
    expect(fromA.items[0]?.owner.id).toBe(ownerA.id);
    expect(JSON.stringify(fromA)).not.toContain('Beatriz');
    expect(fromB.items.map((item) => item.id)).toEqual([inB.id]);
    expect(fromB.items[0]?.owner.id).toBe(ownerB.id);
  });

  it('US1-AC8 el VIN de un vehículo de B buscado desde A → items vacío', async () => {
    await createVehicle(tokenB, ownerB.id, 'PBA1234', { vin: VALID_VIN });

    const res = await search(tokenA, VALID_VIN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });

  it('US1-AC8 hasMore no cuenta vehículos de otro taller: 20 en A + 5 en B → hasMore: false para A', async () => {
    for (let i = 0; i < 20; i++) {
      await createVehicle(tokenA, ownerA.id, `PBA${1000 + i}`);
    }
    for (let i = 0; i < 5; i++) {
      await createVehicle(tokenB, ownerB.id, `PBA${1100 + i}`);
    }

    const body = await searchOk(tokenA, 'PBA1');

    expect(body.items).toHaveLength(20);
    expect(body.hasMore).toBe(false);
    expect(plates(body)).not.toContain('PBA1100');
  });

  it('US1-AC8 la cabecera X-Tenant-Id de B se ignora en la búsqueda de A', async () => {
    await createVehicle(tokenB, ownerB.id, 'PBA1234');

    const res = await search(tokenA, 'PBA1234').set('X-Tenant-Id', tenantB.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });
});
