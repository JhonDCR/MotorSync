// T059: performance of the searches with the reference volume (US1-AC10, FR-005, SC-001).
// The app runs in process (AppModule + configureApp, like the e2e) against the real PostgreSQL,
// the API connecting as motorsync_app, over the volume of test/perf/seed-volume.sql
// (10 talleres x (30 000 clientes + 50 000 vehiculos)). The seed is loaded once, only if the perf
// tenants are missing; this suite never truncates (truncateBusinessTables is not used).
//
// 300 searches per type (exact plate, partial plate of 2 to 4 characters, document, VIN and
// name), sequential and round-robin over the 10 talleres with a token of each one, measured with
// performance.now() around each HTTP request: an upper bound of the server time, because it
// includes the in-process HTTP stack (research R4). Fails if the p95 of plate (exact or partial),
// document or VIN is >= 200 ms; the p95 of name is only reported (the spec sets no threshold).
// A second block runs EXPLAIN (FORMAT JSON) of the SQL the API actually sends for each search
// (captured from the pg driver during one request), as motorsync_app with the tenant pinned,
// and fails if the plan contains a Seq Scan over vehicles or clients.
//
// Run: npm run test:perf (vitest.config.perf.ts, T060).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { authHeader, issueTestToken } from '../setup/auth.js';

const P95_THRESHOLD_MS = 200;
const SEARCHES_PER_TYPE = 300;
const WARMUP_REQUESTS = 30;
const TENANT_COUNT = 10;
const CLIENTS_PER_TENANT = 30_000;
const VEHICLES_PER_TENANT = 50_000;
const SAMPLES_PER_TENANT = SEARCHES_PER_TYPE / TENANT_COUNT;
const PERF_TENANT_PREFIX = 'Taller rendimiento ';
const SEED_FILE = fileURLToPath(new URL('./seed-volume.sql', import.meta.url));
const SEED_TIMEOUT_MS = 20 * 60_000;
const MEASURE_TIMEOUT_MS = 10 * 60_000;

type SearchKind = 'plate_exact' | 'plate_partial' | 'document' | 'vin' | 'name';

/** Blocking kinds: FR-005 and SC-001 cover plate, document and VIN. Name is only reported. */
const BLOCKING_KINDS: readonly SearchKind[] = [
  'plate_exact',
  'plate_partial',
  'document',
  'vin',
];

const KIND_LABEL: Record<SearchKind, string> = {
  plate_exact: 'placa exacta',
  plate_partial: 'placa parcial (2-4)',
  document: 'documento',
  vin: 'VIN',
  name: 'nombre (informativo)',
};

interface PerfTenant {
  id: string;
  name: string;
  token: string;
}

interface TenantSamples {
  plates: string[];
  vins: string[];
  documents: string[];
  names: string[];
}

interface SearchCase {
  kind: SearchKind;
  tenant: PerfTenant;
  path: '/api/v1/vehicles/search' | '/api/v1/clients/search';
  q: string;
}

interface VehicleItemBody {
  plate: string;
  vin: string | null;
}

interface ClientItemBody {
  documentNumber: string;
  displayName: string;
}

interface SearchBody<T> {
  items: T[];
  hasMore: boolean;
}

interface Stats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

interface CapturedQuery {
  text: string;
  values: unknown[];
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

/** Written straight to stdout: Vitest swallows console output of passing tests in some reporters. */
function report(text: string): void {
  process.stdout.write(`${text}
`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`perf: ${name} is not set`);
  return value;
}

/** Nearest-rank percentile over an ascending array. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function statsOf(durations: number[]): Stats {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

/** Deterministic PRNG (mulberry32) so a failing run can be reproduced with the same terms. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function withoutAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function collectPlanNodes(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) collectPlanNodes(child, out);
  return out;
}

function describePlan(nodes: PlanNode[]): string {
  return nodes
    .map((node) =>
      [node['Node Type'], node['Relation Name'], node['Index Name']]
        .filter(Boolean)
        .join(' '),
    )
    .join(' > ');
}

/** Runs fn inside a transaction with the tenant pinned (FORCE RLS applies to every role). */
async function inTenant<T>(
  client: pg.Client,
  tenantId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ]);
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('Search performance with the reference volume (T059, US1-AC10, SC-001)', () => {
  let app: INestApplication<App>;
  let migrator: pg.Client;
  let tenants: PerfTenant[] = [];
  const samples = new Map<string, TenantSamples>();
  const results = new Map<SearchKind, Stats>();
  let seedReport = '';

  async function perfTenantRows(): Promise<{ id: string; name: string }[]> {
    const result = await migrator.query<{ id: string; name: string }>(
      'SELECT id, name FROM tenants WHERE name LIKE $1 ORDER BY name',
      [`${PERF_TENANT_PREFIX}%`],
    );
    return result.rows;
  }

  async function countsOf(
    tenantId: string,
  ): Promise<{ clients: number; vehicles: number }> {
    return inTenant(migrator, tenantId, async () => {
      const result = await migrator.query<{
        clients: number;
        vehicles: number;
      }>(
        `SELECT (SELECT count(*) FROM clients)::int AS clients,
                (SELECT count(*) FROM vehicles)::int AS vehicles`,
      );
      return result.rows[0];
    });
  }

  /** Loads seed-volume.sql once: only if the 10 perf tenants are not there yet. */
  async function ensureSeed(): Promise<void> {
    let rows = await perfTenantRows();
    if (rows.length === 0) {
      const sql = readFileSync(SEED_FILE, 'utf8');
      const started = performance.now();
      try {
        await migrator.query(sql);
      } catch (error) {
        await migrator.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      const seconds = (performance.now() - started) / 1000;
      seedReport = `seed-volume.sql cargado en ${seconds.toFixed(1)} s (incluye ANALYZE)`;
      rows = await perfTenantRows();
    } else {
      seedReport = 'seed-volume.sql ya estaba cargado: se reutiliza';
    }

    expect(rows, 'perf tenants (Taller rendimiento NN)').toHaveLength(
      TENANT_COUNT,
    );
    for (const row of rows) {
      const counts = await countsOf(row.id);
      expect(
        counts,
        `${row.name} is incomplete: drop the perf tenants (or truncate) and run again`,
      ).toEqual({ clients: CLIENTS_PER_TENANT, vehicles: VEHICLES_PER_TENANT });
    }
    tenants = rows.map((row) => ({
      ...row,
      token: issueTestToken({
        tenantId: row.id,
        userId: randomUUID(),
        role: 'asesor',
        name: `Asesora ${row.name}`,
      }),
    }));
  }

  async function loadSamples(): Promise<void> {
    for (const tenant of tenants) {
      const tenantSamples = await inTenant(migrator, tenant.id, async () => {
        const plates = await migrator.query<{ plate: string }>(
          'SELECT plate FROM vehicles ORDER BY random() LIMIT $1',
          [SAMPLES_PER_TENANT],
        );
        const vins = await migrator.query<{ vin: string }>(
          'SELECT vin FROM vehicles WHERE vin IS NOT NULL ORDER BY random() LIMIT $1',
          [SAMPLES_PER_TENANT],
        );
        const clients = await migrator.query<{
          document_number: string;
          display_name: string;
        }>(
          'SELECT document_number, display_name FROM clients ORDER BY random() LIMIT $1',
          [SAMPLES_PER_TENANT],
        );
        return {
          plates: plates.rows.map((row) => row.plate),
          vins: vins.rows.map((row) => row.vin),
          documents: clients.rows.map((row) => row.document_number),
          names: clients.rows.map((row) => row.display_name),
        };
      });
      samples.set(tenant.id, tenantSamples);
    }
  }

  /** Request i goes to taller i % 10 (a different token each time) with sample i / 10. */
  function buildCases(kind: SearchKind): SearchCase[] {
    const random = prng(0x7059 + kind.length);
    return Array.from({ length: SEARCHES_PER_TYPE }, (_, i): SearchCase => {
      const tenant = tenants[i % tenants.length];
      const sample = samples.get(tenant.id);
      if (!sample) throw new Error(`perf: no samples for ${tenant.name}`);
      const index = Math.floor(i / tenants.length) % SAMPLES_PER_TENANT;
      switch (kind) {
        case 'plate_exact':
          return {
            kind,
            tenant,
            path: '/api/v1/vehicles/search',
            q: sample.plates[index],
          };
        case 'plate_partial': {
          const plate = sample.plates[index];
          const length = 2 + (i % 3);
          const offset = Math.floor(random() * (plate.length - length + 1));
          return {
            kind,
            tenant,
            path: '/api/v1/vehicles/search',
            q: plate.slice(offset, offset + length),
          };
        }
        case 'vin':
          return {
            kind,
            tenant,
            path: '/api/v1/vehicles/search',
            q: sample.vins[index],
          };
        case 'document':
          return {
            kind,
            tenant,
            path: '/api/v1/clients/search',
            q: sample.documents[index],
          };
        case 'name': {
          // Half full names with tildes, half one surname without tildes and in lowercase.
          const name = sample.names[index];
          const words = name.split(' ');
          const q =
            i % 2 === 0
              ? name
              : withoutAccents(words[words.length - 1]).toLowerCase();
          return { kind, tenant, path: '/api/v1/clients/search', q };
        }
      }
    });
  }

  function send(searchCase: SearchCase) {
    return request(app.getHttpServer())
      .get(searchCase.path)
      .query({ q: searchCase.q })
      .set(authHeader(searchCase.tenant.token));
  }

  /** Behavior checks, so that a fast but wrong answer never passes as a good time. */
  function expectFound(searchCase: SearchCase, res: request.Response): void {
    const context = `${searchCase.kind} q=${searchCase.q} (${searchCase.tenant.name})`;
    expect(res.status, `${context}: ${JSON.stringify(res.body)}`).toBe(200);
    switch (searchCase.kind) {
      case 'plate_exact': {
        const body = res.body as SearchBody<VehicleItemBody>;
        expect(body.items[0]?.plate, context).toBe(searchCase.q);
        // The same plate exists in the 10 talleres: only the one of the token comes back.
        expect(
          body.items.filter((item) => item.plate === searchCase.q),
          context,
        ).toHaveLength(1);
        break;
      }
      case 'plate_partial': {
        const body = res.body as SearchBody<VehicleItemBody>;
        expect(body.items.length, context).toBeGreaterThan(0);
        expect(
          body.items.every((item) => item.plate.includes(searchCase.q)),
          context,
        ).toBe(true);
        break;
      }
      case 'vin': {
        const body = res.body as SearchBody<VehicleItemBody>;
        expect(body.items[0]?.vin, context).toBe(searchCase.q);
        break;
      }
      case 'document': {
        const body = res.body as SearchBody<ClientItemBody>;
        expect(body.items[0]?.documentNumber, context).toBe(searchCase.q);
        break;
      }
      case 'name': {
        const body = res.body as SearchBody<ClientItemBody>;
        expect(body.items.length, context).toBeGreaterThan(0);
        break;
      }
    }
  }

  async function measure(kind: SearchKind): Promise<Stats> {
    const durations: number[] = [];
    for (const searchCase of buildCases(kind)) {
      const started = performance.now();
      const res = await send(searchCase);
      durations.push(performance.now() - started);
      expectFound(searchCase, res);
    }
    const stats = statsOf(durations);
    results.set(kind, stats);
    return stats;
  }

  beforeAll(async () => {
    migrator = new pg.Client({
      connectionString: requireEnv('DATABASE_MIGRATOR_URL'),
    });
    await migrator.connect();
    await ensureSeed();
    await loadSamples();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    // init + one listening server for the whole suite: supertest reuses it instead of binding
    // an ephemeral port per request, which would add noise to every measurement.
    await app.listen(0, '127.0.0.1');

    // Warm-up (not measured): JIT, connection pool and PostgreSQL caches.
    const warmup = [
      ...buildCases('plate_exact'),
      ...buildCases('document'),
    ].slice(0, WARMUP_REQUESTS);
    for (const searchCase of warmup) await send(searchCase);
  }, SEED_TIMEOUT_MS);

  afterAll(async () => {
    const rows = (Object.keys(KIND_LABEL) as SearchKind[])
      .filter((kind) => results.has(kind))
      .map((kind) => {
        const stats = results.get(kind) as Stats;
        const blocking = BLOCKING_KINDS.includes(kind);
        const verdict = !blocking
          ? 'informativo'
          : stats.p95 < P95_THRESHOLD_MS
            ? 'OK'
            : 'FALLA';
        return `| ${KIND_LABEL[kind].padEnd(22)} | ${String(stats.count).padStart(4)} | ${stats.p50.toFixed(1).padStart(7)} | ${stats.p95.toFixed(1).padStart(7)} | ${stats.p99.toFixed(1).padStart(7)} | ${stats.max.toFixed(1).padStart(7)} | ${verdict.padEnd(11)} |`;
      });
    if (seedReport) report(`[T059] ${seedReport}`);
    if (rows.length > 0) {
      report(
        [
          `[T059] Búsquedas con ${TENANT_COUNT} talleres x (${CLIENTS_PER_TENANT} clientes + ${VEHICLES_PER_TENANT} vehículos), ms por request (umbral p95 < ${P95_THRESHOLD_MS} ms)`,
          '| tipo                   |    n |     p50 |     p95 |     p99 |     max | resultado   |',
          '|------------------------|------|---------|---------|---------|---------|-------------|',
          ...rows,
        ].join('\n'),
      );
    }
    await app?.close();
    await migrator?.end();
  });

  describe('p95 of the searches (FR-005)', () => {
    it.each(BLOCKING_KINDS.map((kind) => [kind, KIND_LABEL[kind]]))(
      `[US1-AC10] [SC-001] el p95 de ${SEARCHES_PER_TYPE} búsquedas por %s (%s) es menor que ${P95_THRESHOLD_MS} ms`,
      async (kind) => {
        const stats = await measure(kind as SearchKind);
        expect(stats.count).toBe(SEARCHES_PER_TYPE);
        expect(
          stats.p95,
          `p95 ${kind}: ${stats.p95.toFixed(1)} ms (p50 ${stats.p50.toFixed(1)}, p99 ${stats.p99.toFixed(1)})`,
        ).toBeLessThan(P95_THRESHOLD_MS);
      },
      MEASURE_TIMEOUT_MS,
    );

    it(
      `[US1-AC10] búsqueda por nombre: ${SEARCHES_PER_TYPE} búsquedas medidas y reportadas (sin umbral en la spec)`,
      async () => {
        const stats = await measure('name');
        expect(stats.count).toBe(SEARCHES_PER_TYPE);
      },
      MEASURE_TIMEOUT_MS,
    );
  });

  describe('query plans (EXPLAIN, research R4)', () => {
    const EXPLAIN_KINDS: readonly SearchKind[] = [
      'plate_exact',
      'plate_partial',
      'document',
      'vin',
      'name',
    ];

    /** SQL over vehicles or clients that the API sends to PostgreSQL while serving one search. */
    async function captureSearchQueries(
      searchCase: SearchCase,
    ): Promise<CapturedQuery[]> {
      const querySpy = vi.spyOn(pg.Client.prototype, 'query');
      let calls: unknown[][];
      try {
        const res = await send(searchCase);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      } finally {
        calls = querySpy.mock.calls.map((args) => [...(args as unknown[])]);
        querySpy.mockRestore();
      }
      return calls
        .map((args): CapturedQuery | undefined => {
          const [first, second] = args;
          if (typeof first === 'string') {
            return { text: first, values: Array.isArray(second) ? second : [] };
          }
          if (first && typeof first === 'object' && 'text' in first) {
            const config = first as { text: unknown; values?: unknown };
            if (typeof config.text !== 'string') return undefined;
            const values = Array.isArray(config.values)
              ? config.values
              : second;
            return {
              text: config.text,
              values: Array.isArray(values) ? values : [],
            };
          }
          return undefined;
        })
        .filter((query): query is CapturedQuery => query !== undefined)
        .filter((query) => /\bFROM\s+(vehicles|clients)\b/i.test(query.text));
    }

    async function explainAsApp(
      tenantId: string,
      query: CapturedQuery,
    ): Promise<PlanNode[]> {
      const appClient = new pg.Client({
        connectionString: requireEnv('DATABASE_URL'),
      });
      await appClient.connect();
      try {
        return await inTenant(appClient, tenantId, async () => {
          const result = await appClient.query<{
            'QUERY PLAN': { Plan: PlanNode }[];
          }>(`EXPLAIN (FORMAT JSON) ${query.text}`, query.values);
          return collectPlanNodes(result.rows[0]['QUERY PLAN'][0].Plan);
        });
      } finally {
        await appClient.end();
      }
    }

    it.each(EXPLAIN_KINDS.map((kind) => [kind, KIND_LABEL[kind]]))(
      '[US1-AC10] [SC-001] el plan de la búsqueda por %s (%s), como motorsync_app con el taller fijado, no tiene Seq Scan sobre vehicles ni clients',
      async (kind) => {
        const searchCase = buildCases(kind as SearchKind)[3];
        const queries = await captureSearchQueries(searchCase);
        expect(
          queries.length,
          `no SQL over vehicles/clients was captured from the pg driver for ${kind}`,
        ).toBeGreaterThan(0);

        for (const query of queries) {
          const nodes = await explainAsApp(searchCase.tenant.id, query);
          report(
            `[T059] EXPLAIN ${kind} q=${searchCase.q}: ${describePlan(nodes)}`,
          );
          const seqScans = nodes.filter(
            (node) =>
              node['Node Type'] === 'Seq Scan' &&
              (node['Relation Name'] === 'vehicles' ||
                node['Relation Name'] === 'clients'),
          );
          expect(
            seqScans.map((node) => `Seq Scan on ${node['Relation Name']}`),
            `${kind}: ${describePlan(nodes)}`,
          ).toEqual([]);
        }
      },
      MEASURE_TIMEOUT_MS,
    );
  });
});
