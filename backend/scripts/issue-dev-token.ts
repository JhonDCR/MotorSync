// npm run token:dev -- --tenant <uuid> --role asesor|admin [--name "Ana"] [--user <uuid>]
// Prints an HS256 token signed with JWT_SECRET for local development (research R3).
// The token has no `sid` (no session): the API only accepts it while the server runs with
// AUTH_ALLOW_SESSIONLESS_TOKENS=true (feature 002, research R9). For a real session use
// POST /api/v1/auth/login with the accounts printed by npm run db:seed:dev.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { isAuthRole } from '../src/auth/auth-user.js';
import { readAuthFlags, requireEnv } from '../src/config/env.js';
import { loadRootEnvFile } from '../src/config/env-file.js';

const USAGE =
  'Usage: npm run token:dev -- --tenant <uuid> --role asesor|admin [--name "Ana"] [--user <uuid>]';
const TOKEN_LIFETIME = '8h';

/** Warns on stderr (stdout keeps only the token) when the API would reject a token without sid. */
function warnIfSessionlessTokensDisabled(): void {
  let allowed = false;
  try {
    allowed = readAuthFlags().allowSessionlessTokens;
  } catch {
    allowed = false;
  }
  if (!allowed) {
    console.error(
      'Aviso: AUTH_ALLOW_SESSIONLESS_TOKENS no es "true": la API rechazará este token (no tiene sesión). ' +
        'Actívala en el .env local o inicia sesión con POST /api/v1/auth/login.',
    );
  }
}

function main(): void {
  loadRootEnvFile();
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      role: { type: 'string' },
      name: { type: 'string', default: 'Dev' },
      user: { type: 'string' },
    },
  });

  const tenantId = values.tenant;
  const userId = values.user ?? randomUUID();
  const name = values.name.trim();
  if (!tenantId || !isUUID(tenantId)) throw new Error(`--tenant must be a uuid. ${USAGE}`);
  if (!isAuthRole(values.role)) throw new Error(`--role must be asesor or admin. ${USAGE}`);
  if (!isUUID(userId)) throw new Error(`--user must be a uuid. ${USAGE}`);
  if (name.length === 0) throw new Error(`--name must not be empty. ${USAGE}`);

  const jwt = new JwtService({ secret: requireEnv('JWT_SECRET') });
  const token = jwt.sign(
    { sub: userId, tenant_id: tenantId, role: values.role, name },
    { algorithm: 'HS256', expiresIn: TOKEN_LIFETIME },
  );
  warnIfSessionlessTokensDisabled();
  console.log(token);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
