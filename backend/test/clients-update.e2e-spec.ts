// T068: e2e of client editing (US4-AC4, AC5, AC11, AC12, AC13, AC15, AC16; FR-019, FR-020) over
// the full app wiring (AppModule + configureApp) and the real PostgreSQL, the API connecting as
// motorsync_app. Contract: PATCH /api/v1/clients/{clientId} (ClientUpdate, ClientDetail, Reason,
// Problem with VERSION_CONFLICT + current). Audit: data-model.md, audit_log with action
// client.document_changed and before/after { documentType, documentNumber }.
// Decisions of the leader: the admin reason is optional but, if given, 10 to 500 characters; an
// empty or blank reason counts as omitted; a normalized value equal to the stored one is not a
// change and does not ask for a reason.
// Every test builds its own tenants and clients through the API (beforeEach).
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
const VALID_REASON = 'Error de digitación en el registro inicial';

/** Valid cédulas (módulo 10) and RUC used across the suite. */
const CEDULA_ANA = '1710034065';
const CEDULA_OTHER = '1712345675';
const RUC_OF_ANA = '1710034065001';

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

interface ClientRow {
  id: string;
  tenant_id: string;
  document_type: string;
  document_number: string;
  first_names: string | null;
  last_names: string | null;
  phone: string;
  email: string | null;
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
  occurred_at_utc: string;
  ip: string | null;
  channel: string;
}

describe('Clients update (e2e, T068, US4)', () => {
  let app: INestApplication<App>;
  let appPool: pg.Pool;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Creates the clients of tenant A. */
  let creatorA: Actor;
  /** Another asesor of tenant A, the one who edits. */
  let asesorA: Actor;
  let adminA: Actor;
  let asesorB: Actor;
  /** "Ana Pérez", natural with cédula, in tenant A (recreated in every test). */
  let clientA: Record<string, unknown>;
  /** "Transportes Andinos S.A.", company with RUC, in tenant A. */
  let companyA: Record<string, unknown>;
  /** A client of tenant B. */
  let clientB: Record<string, unknown>;

  function actorOf(tenant: TenantFixture, name: string, role: TestRole): Actor {
    const userId = randomUUID();
    return {
      userId,
      name,
      role,
      token: issueTestToken({ tenantId: tenant.id, userId, role, name }),
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

  function patchClient(actor: Actor, id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/v1/clients/${id}`)
      .set(authHeader(actor.token))
      .send(body);
  }

  async function createClient(
    actor: Actor,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const res = await postClient(actor, body);
    expect(res.status, 'client creation via POST /clients').toBe(201);
    return res.body as Record<string, unknown>;
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

  async function clientRowAs(
    tenantId: string,
    id: string,
  ): Promise<ClientRow | undefined> {
    const rows = await readAs<ClientRow>(
      tenantId,
      `SELECT id, tenant_id, document_type, document_number, first_names, last_names,
              phone, email, version
         FROM clients WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function auditRowsAs(tenantId: string): Promise<AuditRow[]> {
    return readAs<AuditRow>(
      tenantId,
      `SELECT id, tenant_id, actor_user_id, actor_name, actor_role, action, entity_type,
              entity_id, before, after, reason, occurred_at,
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS occurred_at_utc,
              ip, channel
         FROM audit_log ORDER BY occurred_at, action`,
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
    tenantA = await createTenant(`Taller A clients-update e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B clients-update e2e ${randomUUID()}`);
    creatorA = actorOf(tenantA, 'Ana Creadora', 'asesor');
    asesorA = actorOf(tenantA, 'Carla Editora', 'asesor');
    adminA = actorOf(tenantA, 'Diego Admin', 'admin');
    asesorB = actorOf(tenantB, 'Bruno Salazar', 'asesor');
    clientA = await createClient(creatorA, {
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: CEDULA_ANA,
      firstNames: 'Ana',
      lastNames: 'Pérez',
      phone: '0991234567',
      email: 'ana.perez@example.com',
    });
    companyA = await createClient(creatorA, {
      clientType: 'company',
      documentType: 'ruc',
      documentNumber: '1790011674001',
      businessName: 'Transportes Andinos S.A.',
      phone: '022345678',
    });
    clientB = await createClient(asesorB, {
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: CEDULA_OTHER,
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

  // ---------------------------------------------------------------- US4-AC4

  it('US4-AC4 el asesor edita teléfono, correo y nombre válidos → 200 ClientDetail con version + 1 y la última modificación del token', async () => {
    const before = Date.now();
    const res = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      firstNames: 'Ana María',
      lastNames: 'Pérez Andrade',
      phone: '0998887766',
      email: 'ana.maria@example.com',
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toMatchObject({
      id: clientA.id,
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: CEDULA_ANA,
      firstNames: 'Ana María',
      lastNames: 'Pérez Andrade',
      displayName: 'Ana María Pérez Andrade',
      phone: '0998887766',
      email: 'ana.maria@example.com',
      version: 2,
      updatedBy: asesorA.userId,
      updatedByName: 'Carla Editora',
      createdAt: clientA.createdAt,
      vehicles: [],
    });
    expect(Date.parse(res.body.updatedAt as string)).toBeGreaterThanOrEqual(
      before - 5_000,
    );
    expect(res.body).not.toHaveProperty('tenantId');

    const fetched = await getClient(asesorA, clientA.id as string);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(res.body);
  });

  it('US4-AC4 solo se cambian los campos enviados: un PATCH con el teléfono deja intactos nombre, correo y documento', async () => {
    const res = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      phone: '+593 (99) 888-7766',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      phone: '+593998887766',
      firstNames: 'Ana',
      lastNames: 'Pérez',
      email: 'ana.perez@example.com',
      documentNumber: CEDULA_ANA,
      version: 2,
    });
    expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject({
      phone: '+593998887766',
      first_names: 'Ana',
      version: 2,
    });
  });

  it('US4-AC4 el asesor edita la razón social de una empresa → 200 con displayName nuevo', async () => {
    const res = await patchClient(asesorA, companyA.id as string, {
      version: 1,
      businessName: 'Transportes Andinos Cía. Ltda.',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      businessName: 'Transportes Andinos Cía. Ltda.',
      displayName: 'Transportes Andinos Cía. Ltda.',
      version: 2,
    });
  });

  it('US4-AC4 US4-AC11 el correo puede borrarse con null y editar campos no identificadores no pide motivo ni audita', async () => {
    const res = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      email: null,
      phone: '0991112233',
    });

    expect(res.status).toBe(200);
    expect(res.body.email).toBeNull();
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- US4-AC5

  it.each([CEDULA_OTHER, '171234567-5', ' 1712 3456 75 '])(
    'US4-AC5 documento de otro cliente del taller, enviado como "%s" → 409 DOCUMENT_ALREADY_EXISTS con existingId, sin cambios ni auditoría',
    async (repeated) => {
      const other = await createClient(creatorA, {
        clientType: 'natural',
        documentType: 'cedula',
        documentNumber: CEDULA_OTHER,
        firstNames: 'Carlos',
        lastNames: 'Ruiz',
        phone: '0981234567',
      });

      const res = await patchClient(asesorA, clientA.id as string, {
        version: 1,
        documentNumber: repeated,
        reason: VALID_REASON,
      });

      expect(res.status).toBe(409);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({
        status: 409,
        code: 'DOCUMENT_ALREADY_EXISTS',
        existingId: other.id,
      });
      expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject(
        { document_number: CEDULA_ANA, version: 1 },
      );
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('US4-AC5 el mismo documento existe solo en el taller B → el cambio en A se acepta sin revelar nada de B', async () => {
    const res = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      documentNumber: CEDULA_OTHER,
      reason: VALID_REASON,
    });

    expect(res.status).toBe(200);
    expect(res.body.documentNumber).toBe(CEDULA_OTHER);
    expect(res.body).not.toHaveProperty('existingId');
    expect(await clientRowAs(tenantB.id, clientB.id as string)).toMatchObject({
      document_number: CEDULA_OTHER,
      first_names: 'Beatriz',
    });
  });

  it.each([
    ['1710034064', 'dígito verificador incorrecto'],
    ['171003406', '9 dígitos'],
    ['17100340A5', 'contiene una letra'],
  ])(
    'US4-AC5 cédula inválida %s (%s) → 400 INVALID_CEDULA, sin cambios ni auditoría',
    async (cedula) => {
      const res = await patchClient(asesorA, clientA.id as string, {
        version: 1,
        documentNumber: cedula,
        reason: VALID_REASON,
      });

      expectValidationError(res, 'documentNumber', 'INVALID_CEDULA');
      expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject(
        { document_number: CEDULA_ANA, version: 1 },
      );
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('US4-AC5 RUC inválido en una empresa → 400 INVALID_RUC', async () => {
    const res = await patchClient(asesorA, companyA.id as string, {
      version: 1,
      documentNumber: '179001167400',
      reason: VALID_REASON,
    });
    expectValidationError(res, 'documentNumber', 'INVALID_RUC');
  });

  it('US4-AC5 una empresa no puede pasar a cédula → 400 INVALID_DOCUMENT_TYPE', async () => {
    const res = await patchClient(asesorA, companyA.id as string, {
      version: 1,
      documentType: 'cedula',
      documentNumber: CEDULA_OTHER,
      reason: VALID_REASON,
    });
    expectValidationError(res, 'documentType', 'INVALID_DOCUMENT_TYPE');
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
  });

  it.each([
    ['email', 'ana@', 'INVALID_EMAIL'],
    ['phone', '099123', 'INVALID_PHONE'],
  ])(
    'US4-AC5 %s inválido (%s) → 400 %s, sin cambios',
    async (field, value, code) => {
      const res = await patchClient(asesorA, clientA.id as string, {
        version: 1,
        [field]: value,
      });

      expectValidationError(res, field, code);
      expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject(
        { phone: '0991234567', email: 'ana.perez@example.com', version: 1 },
      );
    },
  );

  // ---------------------------------------------------------------- US4-AC11 / FR-020

  it('US4-AC11 el asesor cambia el documento con motivo → 200 y un registro client.document_changed con before, after, motivo, actor, ip y fecha UTC', async () => {
    const before = Date.now();
    const res = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      documentNumber: ' 171234567-5 ',
      reason: `  ${VALID_REASON}  `,
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      documentType: 'cedula',
      documentNumber: CEDULA_OTHER,
      version: 2,
      updatedBy: asesorA.userId,
      updatedByName: 'Carla Editora',
    });
    expect(res.body).not.toHaveProperty('reason');

    const rows = await auditRowsAs(tenantA.id);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      tenant_id: tenantA.id,
      actor_user_id: asesorA.userId,
      actor_name: 'Carla Editora',
      actor_role: 'asesor',
      action: 'client.document_changed',
      entity_type: 'client',
      entity_id: clientA.id,
      reason: VALID_REASON,
      channel: 'web',
    });
    expect(row.before).toEqual({
      documentType: 'cedula',
      documentNumber: CEDULA_ANA,
    });
    expect(row.after).toEqual({
      documentType: 'cedula',
      documentNumber: CEDULA_OTHER,
    });
    expect(typeof row.ip).toBe('string');
    expect((row.ip as string).length).toBeGreaterThan(0);
    expect(row.occurred_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(row.occurred_at.getTime()).toBeLessThanOrEqual(after + 5_000);
    expect(`${row.occurred_at_utc}Z`).toBe(
      row.occurred_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );
  });

  it('US4-AC11 cambiar solo documentType (cédula → RUC de la misma persona) cuenta como cambio y se audita', async () => {
    const res = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      documentType: 'ruc',
      documentNumber: RUC_OF_ANA,
      reason: VALID_REASON,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      documentType: 'ruc',
      documentNumber: RUC_OF_ANA,
    });
    const rows = await auditRowsAs(tenantA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toEqual({
      documentType: 'cedula',
      documentNumber: CEDULA_ANA,
    });
    expect(rows[0].after).toEqual({
      documentType: 'ruc',
      documentNumber: RUC_OF_ANA,
    });
  });

  it.each(['171003406-5', ' 1710 034 065 '])(
    'US4-AC11 un documento que normalizado es igual al guardado ("%s") no es un cambio: 200 sin motivo y sin auditoría',
    async (same) => {
      const res = await patchClient(asesorA, clientA.id as string, {
        version: 1,
        documentNumber: same,
        phone: '0995554433',
      });

      expect(res.status).toBe(200);
      expect(res.body.documentNumber).toBe(CEDULA_ANA);
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it('US4-AC11 si el cambio de documento falla por validación no queda registro de auditoría', async () => {
    const res = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      documentNumber: CEDULA_OTHER,
      phone: '12',
      reason: VALID_REASON,
    });

    expect(res.status).toBe(400);
    expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject({
      document_number: CEDULA_ANA,
      version: 1,
    });
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------- US4-AC12

  it('US4-AC12 un segundo guardado sobre la versión antigua → 409 VERSION_CONFLICT con current = datos actuales', async () => {
    const first = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      phone: '0991110000',
    });
    expect(first.status).toBe(200);

    const second = await patchClient(adminA, clientA.id as string, {
      version: 1,
      phone: '0992220000',
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
      id: clientA.id,
      phone: '0991110000',
      version: 2,
      updatedByName: 'Carla Editora',
    });
    expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject({
      phone: '0991110000',
      version: 2,
    });
  });

  it('US4-AC12 un cambio de documento con versión antigua → 409 VERSION_CONFLICT sin cambios ni auditoría', async () => {
    const first = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      email: 'otro@example.com',
    });
    expect(first.status).toBe(200);

    const res = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      documentNumber: CEDULA_OTHER,
      reason: VALID_REASON,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect(res.body.current).toMatchObject({
      documentNumber: CEDULA_ANA,
      email: 'otro@example.com',
      version: 2,
    });
    expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject({
      document_number: CEDULA_ANA,
      version: 2,
    });
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
  });

  it('US4-AC12 con la versión vigente el guardado repetido sí se acepta → 200 y version 3', async () => {
    const first = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      phone: '0991110000',
    });
    expect(first.status).toBe(200);

    const retry = await patchClient(adminA, clientA.id as string, {
      version: first.body.version as number,
      phone: '0992220000',
    });

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      phone: '0992220000',
      version: 3,
      updatedByName: 'Diego Admin',
    });
  });

  // ---------------------------------------------------------------- US4-AC13 (multi-tenant)

  it('US4-AC13 un usuario del taller A edita un cliente del taller B → 404 NOT_FOUND igual que uno inexistente, sin cambios', async () => {
    const fromA = await patchClient(asesorA, clientB.id as string, {
      version: 1,
      phone: '0990000000',
    });
    const missing = await patchClient(asesorA, randomUUID(), {
      version: 1,
      phone: '0990000000',
    });

    expect(fromA.status).toBe(404);
    expect(fromA.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(fromA.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(fromA.body).toEqual(missing.body);
    expect(JSON.stringify(fromA.body)).not.toContain(CEDULA_OTHER);
    expect(await clientRowAs(tenantB.id, clientB.id as string)).toMatchObject({
      phone: '0987654321',
      version: 1,
    });
  });

  it('US4-AC13 A cambia el documento de un cliente de B (con motivo y como admin) → 404, sin cambios ni auditoría en ninguno de los dos talleres', async () => {
    for (const actor of [asesorA, adminA]) {
      const res = await patchClient(actor, clientB.id as string, {
        version: 1,
        documentNumber: CEDULA_ANA,
        reason: VALID_REASON,
      });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    }

    expect(await clientRowAs(tenantB.id, clientB.id as string)).toMatchObject({
      document_number: CEDULA_OTHER,
      version: 1,
    });
    expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    expect(await auditRowsAs(tenantB.id)).toHaveLength(0);
  });

  it('US4-AC13 A con la cabecera X-Tenant-Id de B tampoco edita el cliente de B → 404', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/clients/${clientB.id}`)
      .set(authHeader(asesorA.token))
      .set('X-Tenant-Id', tenantB.id)
      .send({ version: 1, phone: '0990000000' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(await clientRowAs(tenantB.id, clientB.id as string)).toMatchObject({
      phone: '0987654321',
      version: 1,
    });
  });

  it('US4-AC13 la cabecera X-Tenant-Id se ignora: A edita su propio cliente aunque envíe la de B', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/clients/${clientA.id}`)
      .set(authHeader(asesorA.token))
      .set('X-Tenant-Id', tenantB.id)
      .send({ version: 1, phone: '0993334455' });

    expect(res.status).toBe(200);
    expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject({
      tenant_id: tenantA.id,
      phone: '0993334455',
    });
  });

  // ---------------------------------------------------------------- US4-AC15 (asesor)

  it.each([
    ['sin motivo', undefined],
    ['motivo de 9 caracteres', '123456789'],
    ['motivo de 9 caracteres tras trim', '   123456789   '],
    ['motivo de 501 caracteres', 'x'.repeat(501)],
    ['motivo vacío', ''],
    ['motivo de solo espacios', '            '],
  ])(
    'US4-AC15 el asesor cambia el documento %s → 400 REASON_REQUIRED, sin cambios ni auditoría',
    async (_label, reason) => {
      const body: Record<string, unknown> = {
        version: 1,
        documentNumber: CEDULA_OTHER,
      };
      if (reason !== undefined) body.reason = reason;

      const res = await patchClient(asesorA, clientA.id as string, body);

      expectReasonRequired(res);
      expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject(
        { document_number: CEDULA_ANA, version: 1 },
      );
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  it.each([
    ['10 caracteres', '1234567890', '1234567890'],
    ['500 caracteres', 'm'.repeat(500), 'm'.repeat(500)],
    ['10 caracteres con espacios alrededor', '   1234567890   ', '1234567890'],
  ])(
    'US4-AC15 el asesor cambia el documento con un motivo de %s → 200 y el motivo queda auditado sin espacios',
    async (_label, reason, stored) => {
      const res = await patchClient(asesorA, clientA.id as string, {
        version: 1,
        documentNumber: CEDULA_OTHER,
        reason,
      });

      expect(res.status).toBe(200);
      const rows = await auditRowsAs(tenantA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_role: 'asesor', reason: stored });
    },
  );

  // ---------------------------------------------------------------- US4-AC16 (admin)

  it('US4-AC16 el admin cambia el documento sin motivo → 200 y auditoría con reason null y actor_role admin', async () => {
    const res = await patchClient(adminA, clientA.id as string, {
      version: 1,
      documentNumber: CEDULA_OTHER,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      documentNumber: CEDULA_OTHER,
      updatedBy: adminA.userId,
      updatedByName: 'Diego Admin',
    });
    const rows = await auditRowsAs(tenantA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'client.document_changed',
      actor_user_id: adminA.userId,
      actor_name: 'Diego Admin',
      actor_role: 'admin',
      reason: null,
    });
  });

  it.each([
    ['vacío', ''],
    ['de solo espacios', '      '],
  ])(
    'US4-AC16 el admin envía un motivo %s → cuenta como omitido: 200 y reason null',
    async (_label, reason) => {
      const res = await patchClient(adminA, clientA.id as string, {
        version: 1,
        documentNumber: CEDULA_OTHER,
        reason,
      });

      expect(res.status).toBe(200);
      const rows = await auditRowsAs(tenantA.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_role: 'admin', reason: null });
    },
  );

  it('US4-AC16 el admin cambia el documento con motivo válido → el motivo queda en la auditoría', async () => {
    const res = await patchClient(adminA, clientA.id as string, {
      version: 1,
      documentNumber: CEDULA_OTHER,
      reason: VALID_REASON,
    });

    expect(res.status).toBe(200);
    const rows = await auditRowsAs(tenantA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_role: 'admin', reason: VALID_REASON });
  });

  it.each([
    ['de 9 caracteres', '123456789'],
    ['de 501 caracteres', 'x'.repeat(501)],
  ])(
    'US4-AC16 el admin informa un motivo %s → 400 REASON_REQUIRED, sin cambios ni auditoría',
    async (_label, reason) => {
      const res = await patchClient(adminA, clientA.id as string, {
        version: 1,
        documentNumber: CEDULA_OTHER,
        reason,
      });

      expectReasonRequired(res);
      expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject(
        { document_number: CEDULA_ANA, version: 1 },
      );
      expect(await auditRowsAs(tenantA.id)).toHaveLength(0);
    },
  );

  // ---------------------------------------------------------------- Contract (ClientUpdate)

  it('US4-AC4 clientType en el body → 400 UNKNOWN_FIELD (no se puede cambiar), sin cambios', async () => {
    const res = await patchClient(asesorA, clientA.id as string, {
      version: 1,
      clientType: 'company',
      businessName: 'Ana Pérez S.A.',
    });

    expectValidationError(res, 'clientType', 'UNKNOWN_FIELD');
    expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject({
      version: 1,
    });
    const fetched = await getClient(asesorA, clientA.id as string);
    expect(fetched.body.clientType).toBe('natural');
  });

  it.each(['tenantId', 'tenant_id'])(
    'US4-AC13 %s en el body del PATCH → 400 UNKNOWN_FIELD, sin cambios en ningún taller',
    async (field) => {
      const res = await patchClient(asesorA, clientA.id as string, {
        version: 1,
        phone: '0990000000',
        [field]: tenantB.id,
      });

      expectValidationError(res, field, 'UNKNOWN_FIELD');
      expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject(
        { tenant_id: tenantA.id, phone: '0991234567', version: 1 },
      );
      expect(await clientRowAs(tenantB.id, clientA.id as string)).toBeUndefined();
    },
  );

  it('US4-AC12 PATCH sin version → 400 REQUIRED en version, sin cambios', async () => {
    const res = await patchClient(asesorA, clientA.id as string, {
      phone: '0990000000',
    });

    expectValidationError(res, 'version', 'REQUIRED');
    expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject({
      phone: '0991234567',
      version: 1,
    });
  });

  it('US4-AC4 PATCH sin token → 401 UNAUTHORIZED, sin cambios', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/clients/${clientA.id}`)
      .send({ version: 1, phone: '0990000000' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await clientRowAs(tenantA.id, clientA.id as string)).toMatchObject({
      phone: '0991234567',
    });
  });
});
