// npm run token:dev -- --tenant <uuid> --role asesor|admin [--name "Ana"] [--user <uuid>]
// Prints an HS256 token signed with JWT_SECRET for local development (research R3).
// There is no login: real authentication is a later feature.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { isAuthRole } from '../src/auth/auth-user.js';
import { requireEnv } from '../src/config/env.js';
import { loadRootEnvFile } from '../src/config/env-file.js';

const USAGE =
  'Usage: npm run token:dev -- --tenant <uuid> --role asesor|admin [--name "Ana"] [--user <uuid>]';
const TOKEN_LIFETIME = '8h';

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
  console.log(token);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
