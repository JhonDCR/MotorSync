// T074: regression e2e of FR-021 / US4-AC17 (no deletion nor deactivation of clients or vehicles)
// over the full app wiring (AppModule + configureApp) and the real PostgreSQL.
// Contract: "DELETE sobre cualquier ruta responde 404 sin efectos" (openapi.yaml, reglas
// transversales). Besides the HTTP checks, it walks the routes registered in the Express router
// to prove that no controller declares @Delete.
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

type Json = Record<string, unknown>;

interface RegisteredRoute {
  path: string;
  methods: string[];
}

/** Minimal shape of the Express 5 router internals that the walk needs. */
interface RouterLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle?: { stack?: RouterLayer[] };
}

describe('No deletion of clients or vehicles (e2e, T074, US4-AC17, FR-021)', () => {
  let app: INestApplication<App>;
  let appPool: pg.Pool;
  let tenant: TenantFixture;
  let tokens: Record<TestRole, string>;
  let client: Json;
  let vehicle: Json;

  function tokenOf(role: TestRole): string {
    return issueTestToken({
      tenantId: tenant.id,
      userId: randomUUID(),
      role,
      name: role === 'admin' ? 'Alberto Admin' : 'Ana Asesora',
    });
  }

  async function countAs(tenantId: string, table: string): Promise<number> {
    const conn = await appPool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const result = await conn.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table}`,
      );
      await conn.query('ROLLBACK');
      return result.rows[0].n;
    } finally {
      conn.release();
    }
  }

  /** Every route registered in the Express router (recursing into mounted sub-routers). */
  function registeredRoutes(): RegisteredRoute[] {
    const express = app.getHttpAdapter().getInstance() as {
      router?: { stack: RouterLayer[] };
      _router?: { stack: RouterLayer[] };
    };
    const root = express.router ?? express._router;
    if (!root) throw new Error('Express router not found');
    const routes: RegisteredRoute[] = [];
    const walk = (stack: RouterLayer[]): void => {
      for (const layer of stack) {
        if (layer.route) {
          const paths = Array.isArray(layer.route.path)
            ? layer.route.path
            : [layer.route.path];
          const methods = Object.keys(layer.route.methods).filter(
            (method) => layer.route?.methods[method],
          );
          for (const path of paths) routes.push({ path, methods });
        } else if (layer.handle?.stack) {
          walk(layer.handle.stack);
        }
      }
    };
    walk(root.stack);
    return routes;
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
    tenant = await createTenant(`Taller no-delete e2e ${randomUUID()}`);
    tokens = { asesor: tokenOf('asesor'), admin: tokenOf('admin') };

    const createdClient = await request(app.getHttpServer())
      .post('/api/v1/clients')
      .set(authHeader(tokens.asesor))
      .send({
        clientType: 'natural',
        documentType: 'cedula',
        documentNumber: '1710034065',
        firstNames: 'Ana',
        lastNames: 'Pérez',
        phone: '0991234567',
      });
    expect(createdClient.status).toBe(201);
    client = createdClient.body as Json;

    const createdVehicle = await request(app.getHttpServer())
      .post('/api/v1/vehicles')
      .set(authHeader(tokens.asesor))
      .send({
        ownerClientId: client.id,
        plate: 'PBA1234',
        brand: 'Toyota',
        model: 'Corolla',
        year: 2020,
        color: 'Blanco',
        bodyType: 'sedan',
        initialMileage: 45000,
      });
    expect(createdVehicle.status).toBe(201);
    vehicle = createdVehicle.body as Json;
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  it.each(['asesor', 'admin'] as const)(
    'US4-AC17 FR-021 DELETE /api/v1/clients/{id} como %s → 404 NOT_FOUND y el cliente sigue existiendo',
    async (role) => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/clients/${client.id as string}`)
        .set(authHeader(tokens[role]));

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });

      const after = await request(app.getHttpServer())
        .get(`/api/v1/clients/${client.id as string}`)
        .set(authHeader(tokens[role]));
      expect(after.status).toBe(200);
      expect(after.body).toMatchObject({
        id: client.id,
        version: client.version,
        vehicles: [expect.objectContaining({ id: vehicle.id })],
      });
      expect(await countAs(tenant.id, 'clients')).toBe(1);
      expect(await countAs(tenant.id, 'vehicles')).toBe(1);
    },
  );

  it.each(['asesor', 'admin'] as const)(
    'US4-AC17 FR-021 DELETE /api/v1/vehicles/{id} como %s → 404 NOT_FOUND y el vehículo sigue existiendo',
    async (role) => {
      const res = await request(app.getHttpServer())
        .delete(`/api/v1/vehicles/${vehicle.id as string}`)
        .set(authHeader(tokens[role]));

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });

      const after = await request(app.getHttpServer())
        .get(`/api/v1/vehicles/${vehicle.id as string}`)
        .set(authHeader(tokens[role]));
      expect(after.status).toBe(200);
      expect(after.body).toEqual(vehicle);
      expect(await countAs(tenant.id, 'vehicles')).toBe(1);
      expect(await countAs(tenant.id, 'audit_log')).toBe(0);
    },
  );

  it('US4-AC17 FR-021 DELETE sobre las colecciones y sin token tampoco borra nada', async () => {
    for (const path of ['/api/v1/clients', '/api/v1/vehicles']) {
      const res = await request(app.getHttpServer())
        .delete(path)
        .set(authHeader(tokens.admin));
      expect(res.status, `DELETE ${path}`).toBe(404);
    }
    for (const path of [
      `/api/v1/clients/${client.id as string}`,
      `/api/v1/vehicles/${vehicle.id as string}`,
    ]) {
      const res = await request(app.getHttpServer()).delete(path);
      expect([401, 404], `DELETE ${path} sin token`).toContain(res.status);
    }
    expect(await countAs(tenant.id, 'clients')).toBe(1);
    expect(await countAs(tenant.id, 'vehicles')).toBe(1);
  });

  it('US4-AC17 FR-021 ninguna ruta registrada en la app declara el método DELETE', () => {
    const routes = registeredRoutes();

    // Sanity check of the walk: the known routes are found.
    const paths = routes.map((route) => route.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/clients/:clientId',
        '/api/v1/vehicles/:vehicleId',
      ]),
    );
    expect(
      routes.find((route) => route.path === '/api/v1/vehicles/:vehicleId')
        ?.methods,
    ).toContain('get');

    // An @All() route would also accept DELETE. The only allowed catch-all is the one Nest
    // registers itself ('*path') to answer 404 to unknown routes.
    const deleteRoutes = routes.filter(
      (route) =>
        route.methods.includes('delete') ||
        (route.methods.includes('_all') && route.path !== '*path'),
    );
    expect(deleteRoutes).toEqual([]);
  });
});
