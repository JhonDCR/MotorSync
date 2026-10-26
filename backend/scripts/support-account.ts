// npm run support:account -- <comando> [flags]: operations procedure for support accounts
// (specs/003-soporte-plataforma, research R5, FR-007, FR-011, FR-024, US2-AC1, US2-AC10).
//
// Commands, each in its own transaction:
//   create --name "<nombre>" --email <correo>
//   deactivate --email <correo> --confirm
//   reactivate --email <correo> --confirm
//   reset-password --email <correo> --confirm
//   list
//   access-log --email <correo> [--since <fecha ISO 8601>]
//
// It connects as motorsync_migrator (DATABASE_MIGRATOR_URL): the platform operations credential,
// which the API never uses. Every argument is validated before a client is taken from the pool.
// The temporary password is printed exactly once on stdout (research R9); it is never written to
// stderr, to a log or to the database (only its scrypt hash is stored). Accounts are never
// deleted: there is no `delete` command (FR-007).
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { PasswordHasher } from '../src/auth/password-hasher.js';
import {
  emailHash,
  isValidEmail,
  normalizeEmail,
} from '../src/common/identifiers/email.js';
import { loadRootEnvFile } from '../src/config/env-file.js';
import { generateTemporaryPassword } from '../src/support/temporary-password-generator.js';

const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 120;

const USAGE = [
  'Uso: npm run support:account -- <comando> [flags]',
  '  create --name "<nombre>" --email <correo>',
  '  deactivate --email <correo> --confirm',
  '  reactivate --email <correo> --confirm',
  '  reset-password --email <correo> --confirm',
  '  list',
  '  access-log --email <correo> [--since <fecha ISO 8601>]',
].join('\n');

const SUPPORT_COMMANDS = [
  'create',
  'deactivate',
  'reactivate',
  'reset-password',
  'list',
  'access-log',
] as const;

type SupportCommand = (typeof SUPPORT_COMMANDS)[number];

export interface SupportAccountDeps {
  /** Already connected pool; the script never closes it. */
  pool?: Pool;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to writing the line on `process.stdout`. */
  stdout?: (line: string) => void;
  /** Defaults to writing the line on `process.stderr`. */
  stderr?: (line: string) => void;
}

interface Flags {
  name?: string;
  email?: string;
  since?: string;
  confirm: boolean;
}

type Parsed =
  | { ok: true; command: SupportCommand; flags: Flags }
  | { ok: false; message: string };

type Operation =
  | { command: 'create'; name: string; email: string }
  | { command: 'deactivate'; email: string }
  | { command: 'reactivate'; email: string }
  | { command: 'reset-password'; email: string }
  | { command: 'list' }
  | { command: 'access-log'; email: string; since: Date | null };

type Validated =
  { ok: true; operation: Operation } | { ok: false; message: string };

type FieldResult = { ok: true; value: string } | { ok: false; message: string };

type SinceResult =
  | { ok: true; value: Date | null }
  | { ok: false; message: string };

interface AccountRef {
  id: string;
  status: string;
}

interface ListRow {
  name: string;
  email: string;
  status: string;
  created_at: Date | string;
}

interface AccessLogRow {
  occurred_at: Date | string;
  workshop_name: string;
  workshop_ruc: string | null;
  ip: string | null;
  channel: string;
}

/** ISO 8601 date or date-time; a value without an offset is read in the server's local time. */
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function isSupportCommand(value: string): value is SupportCommand {
  return (SUPPORT_COMMANDS as readonly string[]).includes(value);
}

/** Splits `argv` (`[command, ...flags]`) into a command and its flags, without touching the DB. */
function parseInvocation(argv: string[]): Parsed {
  const command = argv[0];
  if (command === undefined) {
    return { ok: false, message: `Falta el comando.\n${USAGE}` };
  }
  if (!isSupportCommand(command)) {
    return { ok: false, message: `Comando desconocido: ${command}.\n${USAGE}` };
  }

  const flags: Flags = { confirm: false };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--confirm') {
      flags.confirm = true;
      continue;
    }
    if (token === '--name' || token === '--email' || token === '--since') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ok: false, message: `Falta el valor de ${token}.` };
      }
      if (token === '--name') flags.name = value;
      else if (token === '--email') flags.email = value;
      else flags.since = value;
      index += 1;
      continue;
    }
    return { ok: false, message: `Flag desconocido: ${token}.` };
  }

  return { ok: true, command, flags };
}

function readName(flags: Flags): FieldResult {
  const raw = flags.name;
  if (raw === undefined) return { ok: false, message: 'Falta --name.' };
  const value = raw.trim();
  if (value.length < NAME_MIN_LENGTH || value.length > NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `--name debe tener entre ${NAME_MIN_LENGTH} y ${NAME_MAX_LENGTH} caracteres.`,
    };
  }
  return { ok: true, value };
}

function readEmail(flags: Flags): FieldResult {
  const raw = flags.email;
  if (raw === undefined) return { ok: false, message: 'Falta --email.' };
  const value = normalizeEmail(raw);
  if (!isValidEmail(value)) {
    return { ok: false, message: '--email no es un correo válido.' };
  }
  return { ok: true, value };
}

function readSince(flags: Flags): SinceResult {
  const raw = flags.since;
  if (raw === undefined) return { ok: true, value: null };
  const value = new Date(raw);
  if (!ISO_8601_RE.test(raw) || Number.isNaN(value.getTime())) {
    return { ok: false, message: '--since no es una fecha ISO 8601 válida.' };
  }
  return { ok: true, value };
}

/** Command-specific validation, always before the pool is used. */
function validateOperation(command: SupportCommand, flags: Flags): Validated {
  if (command === 'list') return { ok: true, operation: { command: 'list' } };

  const email = readEmail(flags);
  if (!email.ok) return email;

  if (command === 'access-log') {
    const since = readSince(flags);
    if (!since.ok) return since;
    return {
      ok: true,
      operation: { command, email: email.value, since: since.value },
    };
  }

  if (command === 'create') {
    const name = readName(flags);
    if (!name.ok) return name;
    return {
      ok: true,
      operation: { command, name: name.value, email: email.value },
    };
  }

  if (!flags.confirm) {
    return {
      ok: false,
      message:
        'Falta --confirm: la operación no se ejecuta sin confirmación explícita.',
    };
  }
  return { ok: true, operation: { command, email: email.value } };
}

/** Runs `work` in BEGIN/COMMIT on a client of `pool`, with ROLLBACK on any failure. */
async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is the useful one; a failed ROLLBACK must not hide it.
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

async function lockAccount(
  client: PoolClient,
  email: string,
): Promise<AccountRef> {
  const result = await client.query<AccountRef>(
    'SELECT id, status FROM support_accounts WHERE email = $1 FOR UPDATE',
    [email],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`No existe una cuenta de soporte con el correo ${email}.`);
  }
  return row;
}

/** Creates the account and returns the temporary password (never stored in plain text). */
async function createAccount(
  client: PoolClient,
  name: string,
  email: string,
): Promise<string> {
  // FR-024: a support account never reuses the email of a workshop account.
  const workshop = await client.query<{ exists: boolean }>(
    'SELECT support_workshop_email_exists($1) AS exists',
    [email],
  );
  if (workshop.rows[0]?.exists === true) {
    throw new Error(
      `El correo ${email} ya está en uso por una cuenta de taller (FR-024).`,
    );
  }

  const existing = await client.query(
    'SELECT 1 FROM support_accounts WHERE email = $1',
    [email],
  );
  if (existing.rows.length > 0) {
    throw new Error(`Ya existe una cuenta de soporte con el correo ${email}.`);
  }

  const temporary = generateTemporaryPassword();
  const passwordHash = await new PasswordHasher().hash(temporary);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO support_accounts
       (name, email, password_hash, status, must_change_password, temp_password_expires_at)
     VALUES ($1, $2, $3, 'active', true, now() + interval '72 hours')
     RETURNING id`,
    [name, email, passwordHash],
  );
  if (inserted.rows.length === 0) {
    throw new Error('La base de datos no creó la cuenta de soporte.');
  }
  return temporary;
}

async function deactivateAccount(
  client: PoolClient,
  email: string,
): Promise<void> {
  const account = await lockAccount(client, email);
  await client.query(
    `UPDATE support_accounts
        SET status = 'inactive', updated_at = now()
      WHERE id = $1`,
    [account.id],
  );
  await client.query(
    `UPDATE support_sessions
        SET revoked_at = now(), revoke_reason = 'deactivated'
      WHERE support_account_id = $1 AND revoked_at IS NULL`,
    [account.id],
  );
}

async function reactivateAccount(
  client: PoolClient,
  email: string,
): Promise<void> {
  const account = await lockAccount(client, email);
  await client.query(
    `UPDATE support_accounts
        SET status = 'active', updated_at = now()
      WHERE id = $1`,
    [account.id],
  );
}

/** New temporary password, revoked sessions and cleared login attempts (research R5). */
async function resetAccountPassword(
  client: PoolClient,
  email: string,
): Promise<string> {
  const account = await lockAccount(client, email);
  const temporary = generateTemporaryPassword();
  const passwordHash = await new PasswordHasher().hash(temporary);
  await client.query(
    `UPDATE support_accounts
        SET password_hash = $2,
            must_change_password = true,
            temp_password_expires_at = now() + interval '72 hours',
            updated_at = now()
      WHERE id = $1`,
    [account.id, passwordHash],
  );
  await client.query(
    `UPDATE support_sessions
        SET revoked_at = now(), revoke_reason = 'password_reset'
      WHERE support_account_id = $1 AND revoked_at IS NULL`,
    [account.id],
  );
  // login_attempts belongs to motorsync_auth; the migrator reaches it only through SET ROLE.
  await client.query('SET ROLE motorsync_auth');
  try {
    await client.query('DELETE FROM login_attempts WHERE email_hash = $1', [
      emailHash(email),
    ]);
  } finally {
    await client.query('RESET ROLE');
  }
  return temporary;
}

async function listAccounts(client: PoolClient): Promise<ListRow[]> {
  const result = await client.query<ListRow>(
    `SELECT name, email, status, created_at
       FROM support_accounts
      ORDER BY created_at, email`,
  );
  return result.rows;
}

/**
 * Access log of one support account, newest first (FR-027, research R10). The migrator owns the
 * table, so this operational read does not need a support session nor the support_* functions.
 * Only the workshop and the IP/channel are returned: never the agent's email.
 */
async function listAccessLogEntries(
  client: PoolClient,
  email: string,
  since: Date | null,
): Promise<AccessLogRow[]> {
  const account = await client.query<{ id: string }>(
    'SELECT id FROM support_accounts WHERE email = $1',
    [email],
  );
  const accountId = account.rows[0]?.id;
  if (accountId === undefined) {
    throw new Error(`No existe una cuenta de soporte con el correo ${email}.`);
  }
  const result = await client.query<AccessLogRow>(
    `SELECT l.occurred_at, t.name AS workshop_name, t.ruc AS workshop_ruc,
            l.ip, l.channel
       FROM support_access_log l
       JOIN tenants t ON t.id = l.tenant_id
      WHERE l.support_account_id = $1
        AND ($2::timestamptz IS NULL OR l.occurred_at >= $2)
      ORDER BY l.occurred_at DESC, l.id`,
    [accountId, since],
  );
  return result.rows;
}

/** `YYYY-MM-DD HH:mm` in UTC; the raw value if it is not a date. */
function formatCreatedAt(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

/** ISO 8601 in UTC; the raw value if it is not a date. */
function formatOccurredAt(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function emit(write: (line: string) => void, text: string): void {
  for (const line of text.split('\n')) write(line);
}

/** Readable text for any thrown value, including pg's AggregateError of connection failures. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.message.length > 0) return error.message;
  const details = (error as { errors?: unknown }).errors;
  if (Array.isArray(details)) {
    const messages = details
      .map((detail: unknown) =>
        detail instanceof Error ? detail.message : String(detail),
      )
      .filter((message) => message.length > 0);
    if (messages.length > 0) return `${error.name}: ${messages.join('; ')}`;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return `${error.name}: ${code}`;
  return error.name;
}

/**
 * Runs one operations command and returns its exit code. Usage and operation errors never
 * throw: they go to `stderr` and return 1. `argv` has no `node` and no script name.
 */
export async function runSupportAccount(
  argv: string[],
  deps?: SupportAccountDeps,
): Promise<number> {
  const stdout =
    deps?.stdout ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });
  const stderr =
    deps?.stderr ??
    ((line: string): void => {
      process.stderr.write(`${line}\n`);
    });
  const env = deps?.env ?? process.env;

  const parsed = parseInvocation(argv);
  if (!parsed.ok) {
    emit(stderr, parsed.message);
    return 1;
  }

  const validated = validateOperation(parsed.command, parsed.flags);
  if (!validated.ok) {
    emit(stderr, validated.message);
    return 1;
  }
  const operation = validated.operation;

  let activePool = deps?.pool;
  let ownsPool = false;
  if (activePool === undefined) {
    const url = env.DATABASE_MIGRATOR_URL;
    if (url === undefined || url.trim().length === 0) {
      emit(
        stderr,
        'Falta DATABASE_MIGRATOR_URL: el procedimiento de operaciones se conecta con la credencial del migrator.',
      );
      return 1;
    }
    activePool = new pg.Pool({ connectionString: url });
    ownsPool = true;
  }

  try {
    switch (operation.command) {
      case 'create': {
        const temporary = await withTransaction(activePool, (client) =>
          createAccount(client, operation.name, operation.email),
        );
        // Only the temporary goes to stdout, and only once (R9): operators capture it verbatim.
        stdout(temporary);
        break;
      }
      case 'deactivate': {
        await withTransaction(activePool, (client) =>
          deactivateAccount(client, operation.email),
        );
        stdout(`Cuenta de soporte desactivada: ${operation.email}`);
        break;
      }
      case 'reactivate': {
        await withTransaction(activePool, (client) =>
          reactivateAccount(client, operation.email),
        );
        stdout(`Cuenta de soporte reactivada: ${operation.email}`);
        break;
      }
      case 'reset-password': {
        const temporary = await withTransaction(activePool, (client) =>
          resetAccountPassword(client, operation.email),
        );
        // Only the new temporary goes to stdout, and only once (R9).
        stdout(temporary);
        break;
      }
      case 'list': {
        const rows = await withTransaction(activePool, (client) =>
          listAccounts(client),
        );
        for (const row of rows) {
          stdout(
            `${row.name} | ${row.email} | ${row.status} | ${formatCreatedAt(row.created_at)}`,
          );
        }
        break;
      }
      case 'access-log': {
        const rows = await withTransaction(activePool, (client) =>
          listAccessLogEntries(client, operation.email, operation.since),
        );
        for (const row of rows) {
          stdout(
            `${row.workshop_name} | ${row.workshop_ruc ?? ''} | ${formatOccurredAt(row.occurred_at)} | ${row.ip ?? 'sin IP'} | ${row.channel}`,
          );
        }
        break;
      }
    }
    return 0;
  } catch (error: unknown) {
    emit(stderr, describeError(error));
    return 1;
  } finally {
    if (ownsPool) {
      try {
        await activePool.end();
      } catch {
        // Closing a pool that already failed must not turn a handled error into an exception.
      }
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  loadRootEnvFile();
  try {
    process.exitCode = await runSupportAccount(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(describeError(error));
    process.exitCode = 1;
  }
}
