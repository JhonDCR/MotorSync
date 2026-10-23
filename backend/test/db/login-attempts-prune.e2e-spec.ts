// Ajuste 1 del reviewer T031 (specs/002-autenticacion, tasks.md "# PR2"; research R4): la poda
// oportunista de auth_record_login_failure (DELETE de filas de login_attempts con updated_at de más
// de 1 día) podía provocar un deadlock (40P01) entre dos fallos simultáneos sobre correos distintos:
// cada transacción bloquea la fila de su correo con el upsert y luego intenta borrar la del otro.
// La corrección esperada es `FOR UPDATE SKIP LOCKED` en la subconsulta de la poda, en una migración
// nueva que reemplaza la función con SET ROLE motorsync_auth (CLAUDE.md, "Lecciones").
// Conecta como motorsync_app (DATABASE_URL), igual que la API, y siembra las filas viejas como
// motorsync_migrator (login_attempts no tiene RLS; la app no tiene privilegios sobre la tabla).
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closeFixtures, emailHash, truncateBusinessTables } from '../setup/db-fixtures.js';

const DEADLOCK_DETECTED = '40P01';

interface AttemptRow {
  failed_count: number;
  locked_until: Date | null;
}

interface PgError {
  code?: string;
  message: string;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@taller.ec`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('auth_record_login_failure: poda sin deadlock (e2e de BD, ajuste 1 del reviewer T031)', () => {
  let appPool: pg.Pool;
  let migratorPool: pg.Pool;

  /** Fila vieja: bloqueo vencido hace 2 días y updated_at de hace 2 días (candidata a la poda). */
  async function seedStaleAttempt(email: string, failedCount = 5): Promise<void> {
    await migratorPool.query(
      `INSERT INTO login_attempts (email_hash, failed_count, locked_until, updated_at)
            VALUES ($1, $2, now() - interval '2 days', now() - interval '2 days')`,
      [emailHash(email), failedCount],
    );
  }

  async function attempt(email: string): Promise<AttemptRow | undefined> {
    const result = await migratorPool.query<AttemptRow>(
      'SELECT failed_count, locked_until FROM login_attempts WHERE email_hash = $1',
      [emailHash(email)],
    );
    return result.rows[0];
  }

  /** Una conexión propia de motorsync_app con una transacción abierta y un tope de 15 s. */
  async function openAppTransaction(): Promise<pg.PoolClient> {
    const client = await appPool.connect();
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '15s'`);
    return client;
  }

  function recordFailure(client: pg.ClientBase, email: string): Promise<unknown> {
    return client.query('SELECT auth_record_login_failure($1)', [emailHash(email)]);
  }

  /** Ejecuta `work` y confirma; si falla, deshace (libera sus bloqueos) y propaga el error. */
  async function commitOrRollback(client: pg.PoolClient, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  beforeAll(() => {
    appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 30 });
    migratorPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL, max: 2 });
  });

  beforeEach(async () => {
    await truncateBusinessTables();
  });

  afterAll(async () => {
    await appPool?.end();
    await migratorPool?.end();
    await truncateBusinessTables();
    await closeFixtures();
  });

  it('[T031-1][US2-AC9] dos fallos entrelazados sobre correos distintos, con la fila de uno pendiente de poda, terminan los dos sin 40P01 y se cuentan', async () => {
    // Y tiene una fila vieja (candidata a la poda); X no tiene fila.
    const x = uniqueEmail('x');
    const y = uniqueEmail('y');
    await seedStaleAttempt(y, 2);

    const second = await openAppTransaction();
    const first = await openAppTransaction();
    try {
      // T2: el fallo de Y bloquea la fila de Y (upsert) y deja la transacción abierta.
      await recordFailure(second, y);

      // T1: el fallo de X bloquea X; su poda ve la fila de Y como vieja (T2 no confirmó). Sin SKIP
      // LOCKED espera a T2; con SKIP LOCKED la salta y termina.
      const firstDone = commitOrRollback(first, () => recordFailure(first, x));
      await sleep(300);
      // T2: un segundo fallo, ahora sobre X, espera a T1. Sin SKIP LOCKED: T1 espera a T2 y T2 a T1.
      const secondDone = commitOrRollback(second, () => recordFailure(second, x));

      const results = await Promise.allSettled([firstDone, secondDone]);
      const deadlocks = results.filter(
        (result) =>
          result.status === 'rejected' && (result.reason as PgError).code === DEADLOCK_DETECTED,
      );
      expect(deadlocks, 'ninguna transacción debe abortar por deadlock (40P01)').toHaveLength(0);
      for (const result of results) {
        expect(
          result.status,
          result.status === 'rejected' ? (result.reason as PgError).message : '',
        ).toBe('fulfilled');
      }
    } finally {
      first.release();
      second.release();
    }

    // Todos los fallos cuentan: X recibió 2 (uno de cada transacción); Y, 1 sobre el bloqueo
    // vencido (el contador se reinicia, R4) o sobre una fila nueva si otra poda la borró antes.
    expect(await attempt(x)).toMatchObject({ failed_count: 2, locked_until: null });
    expect(await attempt(y)).toMatchObject({ failed_count: 1, locked_until: null });
  });

  it('[T031-1][US2-AC9] 30 fallos simultáneos desde conexiones distintas sobre 10 correos con filas viejas: ninguno falla y todos se cuentan', async () => {
    const emails = Array.from({ length: 10 }, (_, index) => uniqueEmail(`stale${index}`));
    for (const email of emails) await seedStaleAttempt(email);
    // Más filas viejas de otros correos, para que cada poda tenga trabajo que disputar.
    for (let index = 0; index < 40; index += 1) await seedStaleAttempt(uniqueEmail('other'));

    const calls = emails.flatMap((email) => [email, email, email]);
    const results = await Promise.allSettled(
      calls.map(async (email) => {
        const client = await openAppTransaction();
        try {
          await commitOrRollback(client, () => recordFailure(client, email));
        } finally {
          client.release();
        }
      }),
    );

    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => `${(result.reason as PgError).code}: ${(result.reason as PgError).message}`);
    expect(failures, 'ningún fallo debe abortar (sin 40P01)').toEqual([]);

    // Bloqueo vencido o fila podada: en ambos casos el contador arranca en 1 y suma los 3 fallos.
    for (const email of emails) {
      expect(await attempt(email), email).toMatchObject({ failed_count: 3, locked_until: null });
    }
  });

  it('[T031-1] la poda de auth_record_login_failure usa FOR UPDATE SKIP LOCKED y la función sigue siendo de motorsync_auth', async () => {
    const result = await migratorPool.query<{ prosrc: string; owner: string; secdef: boolean }>(
      `SELECT p.prosrc, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef
         FROM pg_proc p
        WHERE p.oid = 'public.auth_record_login_failure(text)'::regprocedure`,
    );
    expect(result.rows).toHaveLength(1);
    const { prosrc, owner, secdef } = result.rows[0];
    expect(prosrc.replace(/\s+/g, ' ')).toMatch(/FOR UPDATE SKIP LOCKED/i);
    // La migración que la reemplaza conserva el diseño de T001 (data-model, "Mantenimiento").
    expect(owner).toBe('motorsync_auth');
    expect(secdef).toBe(true);
  });

  it('[T031-1][R4] la poda sigue borrando filas de más de 1 día y respeta las recientes', async () => {
    const stale = uniqueEmail('stale');
    const recent = uniqueEmail('recent');
    await seedStaleAttempt(stale);
    await migratorPool.query(
      `INSERT INTO login_attempts (email_hash, failed_count, locked_until, updated_at)
            VALUES ($1, 2, NULL, now() - interval '23 hours')`,
      [emailHash(recent)],
    );

    await appPool.query('SELECT auth_record_login_failure($1)', [emailHash(uniqueEmail('caller'))]);

    expect(await attempt(stale)).toBeUndefined();
    expect(await attempt(recent)).toMatchObject({ failed_count: 2 });
  });
});
