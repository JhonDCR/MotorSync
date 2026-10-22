// T031: e2e of the client search (US4-AC1, US4-AC2, FR-003, FR-004, FR-023) over the full app
// wiring (AppModule + configureApp) and the real PostgreSQL, the API connecting as motorsync_app.
// Contract: GET /api/v1/clients/search?q= → ClientSearchResponse { items: ClientSummary[], hasMore }
// (max 20 items); 400 SEARCH_TERM_TOO_SHORT (problem+json) when q has fewer than 2 characters.
// Reference query: data-model.md "Búsqueda de clientes" (exact → prefix → contains on the
// normalized document, then display_name; name via search_name = immutable_unaccent(lower(...))).
// All data is created through POST /api/v1/clients with valid documents.
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

interface ClientSummaryBody {
  id: string;
  clientType: string;
  documentType: string;
  documentNumber: string;
  displayName: string;
  phone: string;
  email: string | null;
}

interface SearchBody {
  items: ClientSummaryBody[];
  hasMore: boolean;
}

/**
 * Valid Ecuadorian cédula: Pichincha (17), third digit 1, six digits from `seed`, check digit
 * by modulo 10 (coefficients 2,1,2,1,2,1,2,1,2; products > 9 minus 9), as in ec-document.ts.
 */
function cedula(seed: number): string {
  const first9 = `171${String(seed).padStart(6, '0')}`;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let product = Number(first9[i]) * (i % 2 === 0 ? 2 : 1);
    if (product > 9) product -= 9;
    sum += product;
  }
  return `${first9}${(10 - (sum % 10)) % 10}`;
}

// The spec example 1712345678 fails modulo 10 (its check digit is 5): the valid one is used.
const TARGET_CEDULA = '1712345675';
const TARGET_CEDULA_HYPHEN = '171234567-5';

describe('Clients search (e2e, T031, US4)', () => {
  let app: INestApplication<App>;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  let tokenA: string;
  let tokenB: string;

  function tokenOf(tenant: TenantFixture, name: string): string {
    return issueTestToken({
      tenantId: tenant.id,
      userId: randomUUID(),
      role: 'asesor',
      name,
    });
  }

  async function createNatural(
    token: string,
    firstNames: string,
    lastNames: string,
    documentNumber: string,
    documentType: 'cedula' | 'passport' = 'cedula',
  ): Promise<ClientSummaryBody> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/clients')
      .set(authHeader(token))
      .send({
        clientType: 'natural',
        documentType,
        documentNumber,
        firstNames,
        lastNames,
        phone: '0991234567',
        email: 'cliente@example.com',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as ClientSummaryBody;
  }

  async function createCompany(
    token: string,
    businessName: string,
    ruc: string,
  ): Promise<ClientSummaryBody> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/clients')
      .set(authHeader(token))
      .send({
        clientType: 'company',
        documentType: 'ruc',
        documentNumber: ruc,
        businessName,
        phone: '022345678',
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as ClientSummaryBody;
  }

  function search(token: string, q: string) {
    return request(app.getHttpServer())
      .get('/api/v1/clients/search')
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

  function ids(body: SearchBody): string[] {
    return body.items.map((item) => item.id);
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
    tenantA = await createTenant(`Taller A search e2e ${randomUUID()}`);
    tenantB = await createTenant(`Taller B search e2e ${randomUUID()}`);
    tokenA = tokenOf(tenantA, 'Ana Pérez');
    tokenB = tokenOf(tenantB, 'Bruno Salazar');
  });

  afterAll(async () => {
    await app?.close();
    await truncateBusinessTables();
    await closeFixtures();
  });

  // ---------------------------------------------------------------- Routing / contract

  it('US4-AC1 GET /clients/search es su propia ruta (no se confunde con /clients/:clientId) y responde ClientSearchResponse', async () => {
    const res = await search(tokenA, 'nunez');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });

  it('US4-AC1 sin token → 401 UNAUTHORIZED', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/clients/search')
      .query({ q: 'nunez' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  // ---------------------------------------------------------------- US4-AC1

  it('US4-AC1 buscar el documento exacto 1712345675 → el cliente es el primer resultado, como ClientSummary', async () => {
    const target = await createNatural(
      tokenA,
      'Zoila',
      'Zambrano',
      TARGET_CEDULA,
    );
    await createNatural(tokenA, 'Ana', 'Andrade', cedula(876543));

    const body = await searchOk(tokenA, TARGET_CEDULA);

    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]).toEqual({
      id: target.id,
      clientType: 'natural',
      documentType: 'cedula',
      documentNumber: TARGET_CEDULA,
      displayName: 'Zoila Zambrano',
      phone: '0991234567',
      email: 'cliente@example.com',
    });
    expect(body.items[0]).not.toHaveProperty('tenantId');
    expect(body.hasMore).toBe(false);
  });

  it('US4-AC1 buscar el documento con guion 171234567-5 → mismo resultado que sin guion, el cliente primero', async () => {
    const target = await createNatural(
      tokenA,
      'Zoila',
      'Zambrano',
      TARGET_CEDULA,
    );
    await createNatural(tokenA, 'Ana', 'Andrade', cedula(876543));

    const withHyphen = await searchOk(tokenA, TARGET_CEDULA_HYPHEN);
    const plain = await searchOk(tokenA, TARGET_CEDULA);

    expect(withHyphen.items[0]?.id).toBe(target.id);
    expect(withHyphen).toEqual(plain);
  });

  it('US4-AC1 FR-004 el documento parcial (fragmento intermedio) también encuentra al cliente', async () => {
    const target = await createNatural(
      tokenA,
      'Zoila',
      'Zambrano',
      TARGET_CEDULA,
    );
    const other = await createNatural(
      tokenA,
      'Ana',
      'Andrade',
      cedula(987654),
    );

    const body = await searchOk(tokenA, '2345');

    expect(ids(body)).toContain(target.id);
    expect(ids(body)).not.toContain(other.id);
  });

  // ---------------------------------------------------------------- US4-AC2

  it('US4-AC2 "nunez" encuentra "José Andrés Núñez" y "Maria Nunez" (sin tildes ni mayúsculas) y no a otros', async () => {
    const jose = await createNatural(
      tokenA,
      'José Andrés',
      'Núñez',
      cedula(876543),
    );
    const maria = await createNatural(
      tokenA,
      'Maria',
      'Nunez',
      cedula(345678),
    );
    const other = await createNatural(
      tokenA,
      'Ana',
      'Torres',
      cedula(456789),
    );

    const body = await searchOk(tokenA, 'nunez');

    expect(ids(body).sort()).toEqual([jose.id, maria.id].sort());
    expect(ids(body)).not.toContain(other.id);
    const jose1 = body.items.find((item) => item.id === jose.id);
    expect(jose1?.displayName).toBe('José Andrés Núñez');
  });

  it.each(['NÚÑEZ', 'Nuñez', '  nunez  '])(
    'US4-AC2 la variante "%s" encuentra a ambos clientes',
    async (q) => {
      const jose = await createNatural(
        tokenA,
        'José Andrés',
        'Núñez',
        cedula(876543),
      );
      const maria = await createNatural(
        tokenA,
        'Maria',
        'Nunez',
        cedula(345678),
      );

      const body = await searchOk(tokenA, q);

      expect(ids(body).sort()).toEqual([jose.id, maria.id].sort());
    },
  );

  it('US4-AC2 el fragmento puede estar en cualquier parte del nombre completo ("andres nu" cruza nombres y apellidos)', async () => {
    const jose = await createNatural(
      tokenA,
      'José Andrés',
      'Núñez',
      cedula(876543),
    );
    await createNatural(tokenA, 'Maria', 'Nunez', cedula(345678));

    const body = await searchOk(tokenA, 'andres nu');

    expect(ids(body)).toEqual([jose.id]);
  });

  it('US4-AC2 FR-004 una empresa se encuentra por un fragmento de su razón social', async () => {
    const company = await createCompany(
      tokenA,
      'Transportes Andinos S.A.',
      '1790011674001',
    );
    await createNatural(tokenA, 'Maria', 'Nunez', cedula(345678));

    const body = await searchOk(tokenA, 'ANDINOS');

    expect(body.items).toEqual([
      expect.objectContaining({
        id: company.id,
        clientType: 'company',
        documentType: 'ruc',
        documentNumber: '1790011674001',
        displayName: 'Transportes Andinos S.A.',
        email: null,
      }),
    ]);
  });

  it('US4-AC2 la razón social con tildes se encuentra sin tildes ("lopez" → "Mecánica López Cía. Ltda.")', async () => {
    const company = await createCompany(
      tokenA,
      'Mecánica López Cía. Ltda.',
      '1790011674001',
    );

    const body = await searchOk(tokenA, 'mecanica lopez');

    expect(ids(body)).toEqual([company.id]);
  });

  // ---------------------------------------------------------------- FR-003 ordering

  it('FR-003 ordena por relevancia del documento: exacta → prefijo → contiene, por encima del orden alfabético', async () => {
    // Names are chosen so that alphabetical order would be the reverse of relevance.
    const contains = await createNatural(
      tokenA,
      'Ana',
      'Contiene',
      `XY${TARGET_CEDULA}`,
      'passport',
    );
    const prefix = await createNatural(
      tokenA,
      'Mario',
      'Prefijo',
      `${TARGET_CEDULA}AB`,
      'passport',
    );
    const exact = await createNatural(
      tokenA,
      'Zoila',
      'Exacta',
      TARGET_CEDULA,
    );
    const unrelated = await createNatural(
      tokenA,
      'Bea',
      'Otra',
      cedula(987654),
    );

    const body = await searchOk(tokenA, TARGET_CEDULA);

    expect(ids(body)).toEqual([exact.id, prefix.id, contains.id]);
    expect(ids(body)).not.toContain(unrelated.id);
    expect(body.hasMore).toBe(false);
  });

  it('FR-003 dentro del mismo nivel de relevancia ordena por nombre visible', async () => {
    const zeta = await createNatural(tokenA, 'Zeta', 'Gomez', cedula(876543));
    const alfa = await createNatural(tokenA, 'Alfa', 'Gomez', cedula(345678));
    const mike = await createNatural(tokenA, 'Mike', 'Gomez', cedula(456789));

    const body = await searchOk(tokenA, 'gomez');

    expect(ids(body)).toEqual([alfa.id, mike.id, zeta.id]);
  });

  // ---------------------------------------------------------------- FR-003 limit

  it('FR-003 25 coincidencias → 20 items y hasMore: true', async () => {
    for (let i = 0; i < 25; i++) {
      await createNatural(
        tokenA,
        `Cliente ${String(i).padStart(2, '0')}`,
        'Gomez',
        cedula(300000 + i * 7),
      );
    }

    const body = await searchOk(tokenA, 'gomez');

    expect(body.items).toHaveLength(20);
    expect(body.hasMore).toBe(true);
    expect(new Set(ids(body)).size).toBe(20);
  });

  it('FR-003 exactamente 20 coincidencias → 20 items y hasMore: false', async () => {
    for (let i = 0; i < 20; i++) {
      await createNatural(
        tokenA,
        `Cliente ${String(i).padStart(2, '0')}`,
        'Gomez',
        cedula(300000 + i * 7),
      );
    }

    const body = await searchOk(tokenA, 'gomez');

    expect(body.items).toHaveLength(20);
    expect(body.hasMore).toBe(false);
  });

  // ---------------------------------------------------------------- Too short

  it.each([
    ['', 'vacío'],
    ['a', '1 carácter'],
    ['   a   ', '1 carácter tras quitar espacios'],
  ])(
    'FR-004 término "%s" (%s) → 400 SEARCH_TERM_TOO_SHORT en problem+json',
    async (q) => {
      await createNatural(tokenA, 'Ana', 'Andrade', cedula(876543));

      const res = await search(tokenA, q);

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      expect(res.body).toMatchObject({
        status: 400,
        code: 'SEARCH_TERM_TOO_SHORT',
      });
      expect(typeof res.body.detail === 'string' || typeof res.body.title === 'string').toBe(true);
    },
  );

  it('FR-004 sin el parámetro q → 400 SEARCH_TERM_TOO_SHORT', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/clients/search')
      .set(authHeader(tokenA));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'SEARCH_TERM_TOO_SHORT' });
  });

  it('FR-004 2 caracteres es el mínimo válido → 200', async () => {
    const maria = await createNatural(
      tokenA,
      'Maria',
      'Nunez',
      cedula(345678),
    );

    const body = await searchOk(tokenA, 'nu');

    expect(ids(body)).toEqual([maria.id]);
  });

  // ---------------------------------------------------------------- LIKE metacharacters

  it('FR-004 "%" se busca literalmente: "100%" no encuentra "Taller 100 Motor" ni "Taller 1000"', async () => {
    const literal = await createCompany(
      tokenA,
      'Taller 100% Motor',
      '1790011674001',
    );
    await createCompany(tokenA, 'Taller 100 Motor', '1790000000001');
    await createCompany(tokenA, 'Taller 1000', '1760000000001');

    const body = await searchOk(tokenA, '100%');

    expect(ids(body)).toEqual([literal.id]);
  });

  it('FR-004 "_" se busca literalmente: "o_s" encuentra "Auto_Sur" y no "AutoXSur"', async () => {
    const literal = await createCompany(tokenA, 'Auto_Sur', '1790011674001');
    await createCompany(tokenA, 'AutoXSur', '1790000000001');

    const body = await searchOk(tokenA, 'o_s');

    expect(ids(body)).toEqual([literal.id]);
  });

  it('FR-004 "\\" se busca literalmente: "a\\b" encuentra "Mecanica A\\B" y no "Mecanica AB"', async () => {
    const literal = await createCompany(
      tokenA,
      'Mecanica A\\B',
      '1790011674001',
    );
    await createCompany(tokenA, 'Mecanica AB', '1790000000001');

    const body = await searchOk(tokenA, 'a\\b');

    expect(ids(body)).toEqual([literal.id]);
  });

  it.each(['%%', '__', '%_'])(
    'FR-004 un término solo de comodines "%s" no devuelve todos los clientes → items vacío',
    async (q) => {
      await createNatural(tokenA, 'Maria', 'Nunez', cedula(345678));
      await createCompany(tokenA, 'Transportes Andinos S.A.', '1790011674001');

      const body = await searchOk(tokenA, q);

      expect(body).toEqual({ items: [], hasMore: false });
    },
  );

  // ---------------------------------------------------------------- FR-023 isolation

  it('FR-023 los clientes del taller B (mismo nombre) no aparecen en la búsqueda por nombre del taller A', async () => {
    const inA = await createNatural(
      tokenA,
      'Maria',
      'Nunez',
      cedula(345678),
    );
    const inB1 = await createNatural(
      tokenB,
      'José Andrés',
      'Núñez',
      cedula(876543),
    );
    const inB2 = await createNatural(
      tokenB,
      'Pedro',
      'Nunez',
      cedula(456789),
    );

    const fromA = await searchOk(tokenA, 'nunez');
    const fromB = await searchOk(tokenB, 'nunez');

    expect(ids(fromA)).toEqual([inA.id]);
    expect(ids(fromB).sort()).toEqual([inB1.id, inB2.id].sort());
  });

  it('FR-023 el mismo documento registrado en A y en B: A solo ve el suyo al buscar por documento', async () => {
    const inA = await createNatural(tokenA, 'Ana', 'De A', TARGET_CEDULA);
    const inB = await createNatural(tokenB, 'Bruno', 'De B', TARGET_CEDULA);

    const fromA = await searchOk(tokenA, TARGET_CEDULA_HYPHEN);

    expect(ids(fromA)).toEqual([inA.id]);
    expect(ids(fromA)).not.toContain(inB.id);
    expect(JSON.stringify(fromA)).not.toContain('Bruno');
  });

  it('FR-023 un documento que solo existe en B → A obtiene 200 con items vacío, sin revelar nada', async () => {
    await createNatural(tokenB, 'Bruno', 'De B', TARGET_CEDULA);

    const res = await search(tokenA, TARGET_CEDULA);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });

  it('FR-023 hasMore no cuenta clientes de otro taller: 20 en A + 5 en B → hasMore: false para A', async () => {
    for (let i = 0; i < 20; i++) {
      await createNatural(
        tokenA,
        `Cliente ${String(i).padStart(2, '0')}`,
        'Gomez',
        cedula(300000 + i * 7),
      );
    }
    for (let i = 0; i < 5; i++) {
      await createNatural(
        tokenB,
        `Otro ${i}`,
        'Gomez',
        cedula(500000 + i * 7),
      );
    }

    const body = await searchOk(tokenA, 'gomez');

    expect(body.items).toHaveLength(20);
    expect(body.hasMore).toBe(false);
  });

  it('FR-023 la cabecera X-Tenant-Id de B se ignora en la búsqueda de A', async () => {
    await createNatural(tokenB, 'Pedro', 'Nunez', cedula(456789));

    const res = await search(tokenA, 'nunez').set('X-Tenant-Id', tenantB.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], hasMore: false });
  });
});
