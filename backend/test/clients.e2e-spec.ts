// T021: e2e of client creation and retrieval (US2, FR-017) over the full app wiring
// (AppModule + configureApp) and the real PostgreSQL, the API connecting as motorsync_app.
// Contract: POST /api/v1/clients, GET /api/v1/clients/{clientId} (ClientCreate, ClientDetail, Problem).
// Field codes travel in errors[].code with code = VALIDATION_ERROR (normative note of tasks.md).
// Document vectors come from src/common/identifiers/ec-document.spec.ts (T015).
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

describe('Clients (e2e, T021, US2)', () => {
  let app: INestApplication<App>;
  let appPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let actorA: Actor;
  let actorB: Actor;

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

  function naturalCedula(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: '1710034065',
      firstNames: 'Juan Carlos',
      lastNames: 'Pérez Andrade',
      phone: '0991234567',
      email: 'juan.perez@example.com',
      ...overrides,
    };
  }

  function companyRuc(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      clientType: 'company',
      documentType: 'ruc',
      documentNumber: '1790011674001',
      businessName: 'Transportes Andinos S.A.',
      phone: '022345678',
      ...overrides,
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

  function fieldErrors(body: { errors?: FieldErrorBody[] }): FieldErrorBody[] {
    return Array.isArray(body.errors) ? body.errors : [];
  }

  function expectValidationError(
    res: request.Response,
    field: string,
    code: string,
  ): void {
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
  }

  /** Rows of `clients` visible to motorsync_app with the tenant pinned (as the API sees them). */
  async function clientRowsAs(
    tenantId: string,
  ): Promise<{ id: string; tenant_id: string; document_number: string }[]> {
    const conn = await appPool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const result = await conn.query<{
        id: string;
        tenant_id: string;
        document_number: string;
      }>(
        'SELECT id, tenant_id, document_number FROM clients ORDER BY created_at',
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
    tenantA = await createTenant(`Taller A clients e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B clients e2e ${randomUUID()}`);
    actorA = actorOf(tenantA, 'Ana Pérez');
    actorB = actorOf(tenantB, 'Bruno Salazar');
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- US2-AC1 / FR-017

  it('US2-AC1 registra una persona natural con cédula válida → 201 ClientDetail con Location', async () => {
    const before = Date.now();
    const res = await postClient(actorA, naturalCedula());

    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.id).toMatch(UUID_RE);
    expect(res.headers.location).toBe(`/api/v1/clients/${res.body.id}`);
    expect(res.body).toMatchObject({
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: '1710034065',
      firstNames: 'Juan Carlos',
      lastNames: 'Pérez Andrade',
      businessName: null,
      displayName: 'Juan Carlos Pérez Andrade',
      phone: '0991234567',
      email: 'juan.perez@example.com',
      version: 1,
      vehicles: [],
    });
    expect(res.body).not.toHaveProperty('tenantId');
    expect(res.body).not.toHaveProperty('tenant_id');
    expect(Date.parse(res.body.createdAt as string)).toBeGreaterThanOrEqual(
      before - 5_000,
    );
  });

  it('US2-AC1 GET /api/v1/clients/{id} devuelve la ficha recién creada con vehicles: []', async () => {
    const created = await postClient(actorA, naturalCedula());
    expect(created.status).toBe(201);

    const res = await getClient(actorA, created.body.id as string);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
    expect(res.body.vehicles).toEqual([]);
  });

  it('US2-AC1 FR-017 la ficha incluye createdAt y updatedAt en ISO UTC, updatedBy = sub y updatedByName = name del token', async () => {
    const created = await postClient(actorA, naturalCedula());
    expect(created.status).toBe(201);

    const res = await getClient(actorA, created.body.id as string);

    expect(res.status).toBe(200);
    expect(res.body.createdAt).toMatch(ISO_UTC_RE);
    expect(res.body.updatedAt).toMatch(ISO_UTC_RE);
    expect(Date.parse(res.body.updatedAt as string)).toBeGreaterThanOrEqual(
      Date.parse(res.body.createdAt as string),
    );
    expect(res.body.updatedBy).toBe(actorA.userId);
    expect(res.body.updatedByName).toBe('Ana Pérez');
  });

  it('US2-AC1 normaliza documento, teléfono y correo (sin espacios ni guiones; correo en minúsculas)', async () => {
    const res = await postClient(
      actorA,
      naturalCedula({
        documentNumber: ' 171003406-5 ',
        phone: '+593 (99) 123-4567',
        email: '  Juan.Perez@Example.COM ',
        firstNames: '  Juan Carlos ',
        lastNames: ' Pérez Andrade  ',
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      documentNumber: '1710034065',
      phone: '+593991234567',
      email: 'juan.perez@example.com',
      firstNames: 'Juan Carlos',
      lastNames: 'Pérez Andrade',
    });
  });

  // ---------------------------------------------------------------- US2-AC2

  it('US2-AC2 registra una empresa con RUC válido y razón social → 201 como company', async () => {
    const res = await postClient(actorA, companyRuc());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      clientType: 'company',
      documentType: 'ruc',
      documentNumber: '1790011674001',
      businessName: 'Transportes Andinos S.A.',
      firstNames: null,
      lastNames: null,
      displayName: 'Transportes Andinos S.A.',
      phone: '022345678',
      email: null,
      vehicles: [],
    });
  });

  it('US2-AC2 acepta un RUC de sociedad que no cumple módulo 11 (decisión P1, solo estructura)', async () => {
    const res = await postClient(
      actorA,
      companyRuc({ documentNumber: '1790000000001' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.documentNumber).toBe('1790000000001');
  });

  it.each([
    ['cedula', '1710034065'],
    ['passport', 'AB123456'],
  ])(
    'US2-AC2 una empresa con documentType %s → 400 INVALID_DOCUMENT_TYPE y no se guarda',
    async (documentType, documentNumber) => {
      const res = await postClient(
        actorA,
        companyRuc({ documentType, documentNumber }),
      );

      expectValidationError(res, 'documentType', 'INVALID_DOCUMENT_TYPE');
      expect(await clientRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  // ---------------------------------------------------------------- US2-AC3

  it.each(['A1234', '12345', 'AB123456', 'X'.repeat(20)])(
    'US2-AC3 registra una persona natural con pasaporte alfanumérico %s (5 a 20) → 201',
    async (passport) => {
      const res = await postClient(
        actorA,
        naturalCedula({ documentType: 'passport', documentNumber: passport }),
      );

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        documentType: 'passport',
        documentNumber: passport,
      });
    },
  );

  it('US2-AC3 normaliza el pasaporte a mayúsculas sin espacios ni guiones', async () => {
    const res = await postClient(
      actorA,
      naturalCedula({ documentType: 'passport', documentNumber: 'ab-123 456' }),
    );
    expect(res.status).toBe(201);
    expect(res.body.documentNumber).toBe('AB123456');
  });

  it.each([
    ['A123', '4 caracteres'],
    ['A'.repeat(21), '21 caracteres'],
    ['AB.123456', 'otro símbolo'],
  ])(
    'US2-AC3 rechaza el pasaporte %s (%s) → 400 INVALID_PASSPORT',
    async (passport) => {
      const res = await postClient(
        actorA,
        naturalCedula({ documentType: 'passport', documentNumber: passport }),
      );
      expectValidationError(res, 'documentNumber', 'INVALID_PASSPORT');
    },
  );

  // ---------------------------------------------------------------- US2-AC4

  it.each([
    ['1710034064', 'dígito verificador incorrecto'],
    ['171003406', '9 dígitos'],
    ['17100340650', '11 dígitos'],
    ['2500000001', 'provincia 25'],
    ['1760000008', 'tercer dígito 6'],
    ['17100340A5', 'contiene una letra'],
  ])(
    'US2-AC4 rechaza la cédula %s (%s) → 400 INVALID_CEDULA y no se guarda',
    async (cedula) => {
      const res = await postClient(
        actorA,
        naturalCedula({ documentNumber: cedula }),
      );

      expectValidationError(res, 'documentNumber', 'INVALID_CEDULA');
      expect(await clientRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  // ---------------------------------------------------------------- US2-AC5

  it.each([
    ['1710034065002', 'persona natural que no termina en 001'],
    ['1710034064001', 'persona natural con cédula inválida'],
    ['1770000000001', 'tercer dígito 7'],
    ['2590000000001', 'sociedad con provincia 25'],
    ['179001167400', '12 dígitos'],
    ['17900116740011', '14 dígitos'],
    ['1710034065', 'una cédula no es un RUC'],
  ])(
    'US2-AC5 rechaza el RUC %s (%s) → 400 INVALID_RUC y no se guarda',
    async (ruc) => {
      const res = await postClient(actorA, companyRuc({ documentNumber: ruc }));

      expectValidationError(res, 'documentNumber', 'INVALID_RUC');
      expect(await clientRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('US2-AC5 una persona natural con RUC válido de persona natural → 201 (natural admite ruc)', async () => {
    const res = await postClient(
      actorA,
      naturalCedula({ documentType: 'ruc', documentNumber: '1710034065001' }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      clientType: 'natural',
      documentType: 'ruc',
    });
  });

  // ---------------------------------------------------------------- US2-AC6

  it.each(['1710034065', '171003406-5', '17 1003 4065', ' 1710-034-065 '])(
    'US2-AC6 documento ya registrado en el taller, enviado como "%s" → 409 DOCUMENT_ALREADY_EXISTS con existingId',
    async (repeated) => {
      const first = await postClient(actorA, naturalCedula());
      expect(first.status).toBe(201);

      const res = await postClient(
        actorA,
        naturalCedula({
          documentNumber: repeated,
          firstNames: 'Otro',
          lastNames: 'Cliente',
        }),
      );

      expect(res.status).toBe(409);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({
        status: 409,
        code: 'DOCUMENT_ALREADY_EXISTS',
        existingId: first.body.id,
      });
      const rows = await clientRowsAs(tenantA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.body.id);
    },
  );

  // ---------------------------------------------------------------- US2-AC7

  it.each(['juan.perez', 'juan@', '@example.com', 'juan perez@example.com'])(
    'US2-AC7 correo con formato inválido "%s" → 400 INVALID_EMAIL',
    async (email) => {
      const res = await postClient(actorA, naturalCedula({ email }));
      expectValidationError(res, 'email', 'INVALID_EMAIL');
    },
  );

  it.each([
    ['099123', '6 dígitos'],
    ['1234567890123456', '16 dígitos'],
    ['+5939912345678901', '+ y 16 dígitos'],
    ['09912345a7', 'contiene una letra'],
  ])('US2-AC7 teléfono %s (%s) → 400 INVALID_PHONE', async (phone) => {
    const res = await postClient(actorA, naturalCedula({ phone }));
    expectValidationError(res, 'phone', 'INVALID_PHONE');
  });

  it.each([
    ['0991234', '7 dígitos'],
    ['123456789012345', '15 dígitos'],
    ['+593991234567', 'con prefijo +'],
  ])('US2-AC7 acepta el teléfono %s (%s) → 201', async (phone) => {
    const res = await postClient(actorA, naturalCedula({ phone }));
    expect(res.status).toBe(201);
    expect(res.body.phone).toBe(phone);
  });

  it('US2-AC7 correo omitido → 201 con email null', async () => {
    const body = naturalCedula();
    delete body.email;
    const res = await postClient(actorA, body);

    expect(res.status).toBe(201);
    expect(res.body.email).toBeNull();
  });

  it('US2-AC7 correo null → 201 con email null', async () => {
    const res = await postClient(actorA, naturalCedula({ email: null }));

    expect(res.status).toBe(201);
    expect(res.body.email).toBeNull();
  });

  // ---------------------------------------------------------------- US2-AC8

  it.each([
    'clientType',
    'documentType',
    'documentNumber',
    'firstNames',
    'lastNames',
    'phone',
  ])(
    'US2-AC8 persona natural sin %s → 400 con errors[].code = REQUIRED en ese campo',
    async (field) => {
      const body = naturalCedula();
      delete body[field];
      const res = await postClient(actorA, body);

      expectValidationError(res, field, 'REQUIRED');
      expect(await clientRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('US2-AC8 empresa sin businessName → 400 con errors[].code = REQUIRED en businessName', async () => {
    const body = companyRuc();
    delete body.businessName;
    const res = await postClient(actorA, body);

    expectValidationError(res, 'businessName', 'REQUIRED');
    expect(await clientRowsAs(tenantA.id)).toHaveLength(0);
  });

  it('US2-AC8 cuerpo vacío → 400 marcando cada obligatorio (clientType, documentType, documentNumber, phone)', async () => {
    const res = await postClient(actorA, {});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    const errors = fieldErrors(res.body as { errors?: FieldErrorBody[] });
    for (const field of [
      'clientType',
      'documentType',
      'documentNumber',
      'phone',
    ]) {
      expect(errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field, code: 'REQUIRED' }),
        ]),
      );
    }
  });

  // ---------------------------------------------------------------- US2-AC9

  it('US2-AC9 el mismo documento ya registrado en el taller B → el taller A lo registra con 201 sin revelar nada', async () => {
    const inB = await postClient(
      actorB,
      naturalCedula({ firstNames: 'Cliente', lastNames: 'De B' }),
    );
    expect(inB.status).toBe(201);

    const inA = await postClient(actorA, naturalCedula());

    expect(inA.status).toBe(201);
    expect(inA.body.id).not.toBe(inB.body.id);
    expect(inA.body).not.toHaveProperty('existingId');
    expect(inA.body.firstNames).toBe('Juan Carlos');
    expect(await clientRowsAs(tenantA.id)).toEqual([
      expect.objectContaining({ id: inA.body.id, tenant_id: tenantA.id }),
    ]);
    expect(await clientRowsAs(tenantB.id)).toEqual([
      expect.objectContaining({ id: inB.body.id, tenant_id: tenantB.id }),
    ]);
  });

  // ---------------------------------------------------------------- US2-AC10

  it.each(['tenantId', 'tenant_id'])(
    'US2-AC10 %s en el body → 400 UNKNOWN_FIELD y no se guarda',
    async (field) => {
      const res = await postClient(
        actorA,
        naturalCedula({ [field]: tenantB.id }),
      );

      expectValidationError(res, field, 'UNKNOWN_FIELD');
      expect(await clientRowsAs(tenantA.id)).toHaveLength(0);
      expect(await clientRowsAs(tenantB.id)).toHaveLength(0);
    },
  );

  it('US2-AC10 la cabecera X-Tenant-Id del taller B se ignora: el cliente queda en el taller del token (A)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/clients')
      .set(authHeader(actorA.token))
      .set('X-Tenant-Id', tenantB.id)
      .send(naturalCedula());

    expect(res.status).toBe(201);
    expect(await clientRowsAs(tenantA.id)).toEqual([
      expect.objectContaining({ id: res.body.id, tenant_id: tenantA.id }),
    ]);
    expect(await clientRowsAs(tenantB.id)).toHaveLength(0);
  });

  it('US2-AC10 un usuario del taller B pide el cliente de A por id → 404 NOT_FOUND, igual que uno inexistente', async () => {
    const created = await postClient(actorA, naturalCedula());
    expect(created.status).toBe(201);

    const fromB = await getClient(actorB, created.body.id as string);
    const missing = await getClient(actorB, randomUUID());

    expect(fromB.status).toBe(404);
    expect(fromB.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(fromB.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(fromB.body).toEqual(missing.body);
    expect(JSON.stringify(fromB.body)).not.toContain('1710034065');
  });

  it('US2-AC10 B con X-Tenant-Id de A tampoco ve el cliente de A → 404 NOT_FOUND', async () => {
    const created = await postClient(actorA, naturalCedula());
    expect(created.status).toBe(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/clients/${created.body.id}`)
      .set(authHeader(actorB.token))
      .set('X-Tenant-Id', tenantA.id);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  // ---------------------------------------------------------------- Contract edges

  it('US2-AC1 GET /clients/{id} con un uuid inexistente o un id que no es uuid → 404 NOT_FOUND', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await getClient(actorA, id);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
  });

  it('US2-AC1 POST /clients sin token → 401 UNAUTHORIZED y no se guarda', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/clients')
      .send(naturalCedula());

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await clientRowsAs(tenantA.id)).toHaveLength(0);
  });
});
