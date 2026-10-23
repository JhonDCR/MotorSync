// npm run db:seed:dev: example data for local development (quickstart §1). Creates the workshops
// A and B with some clients and vehicles, and prints their uuids (for npm run token:dev).
// Connects as motorsync_migrator (DATABASE_MIGRATOR_URL). With FORCE ROW LEVEL SECURITY the owner
// is subject to the policies too, so every business row is written after pinning its tenant with
// set_config('app.tenant_id', ..., true) inside a single transaction.
// Idempotent: fixed tenant uuids and ON CONFLICT DO NOTHING on the natural keys (tenant + document,
// tenant + plate), so a second run inserts nothing and says so.
// Feature 002 (T023): each workshop gets a valid RUC and one admin and one asesor account, with a
// development password printed on the console (npm run token:dev keeps working without them).
import pg from 'pg';
import { PasswordHasher } from '../src/auth/password-hasher.js';
import { requireEnv } from '../src/config/env.js';
import { loadRootEnvFile } from '../src/config/env-file.js';
import {
  isValidCedula,
  isValidPassport,
  isValidRuc,
} from '../src/common/identifiers/ec-document.js';
import {
  isValidPlate,
  type BodyType,
} from '../src/common/identifiers/plate.js';
import { isValidVin } from '../src/common/identifiers/vin.js';
import {
  isValidEmail,
  normalizeEmail,
} from '../src/common/identifiers/email.js';

const SEED_ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const SEED_ACTOR_NAME = 'Seed dev';
/** Development only: never use it outside a local database. */
const DEV_PASSWORD = 'MotorSync-dev-2026';

interface SeedUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'asesor';
}

type SeedClient =
  | {
      clientType: 'natural';
      documentType: 'cedula' | 'ruc' | 'passport';
      documentNumber: string;
      firstNames: string;
      lastNames: string;
      phone: string;
      email: string | null;
    }
  | {
      clientType: 'company';
      documentType: 'ruc';
      documentNumber: string;
      businessName: string;
      phone: string;
      email: string | null;
    };

interface SeedVehicle {
  /** documentNumber of the owner, a client of the same workshop. */
  ownerDocument: string;
  plate: string;
  vin: string | null;
  brand: string;
  model: string;
  year: number;
  color: string;
  bodyType: BodyType;
  initialMileage: number;
}

interface SeedTenant {
  key: 'A' | 'B';
  id: string;
  name: string;
  /** RUC of the workshop (private company: third digit 9, structure only, decision P1). */
  ruc: string;
  users: SeedUser[];
  clients: SeedClient[];
  vehicles: SeedVehicle[];
}

// Workshop A holds the plates of US1-AC3 (PBA1234, PBA1299 and GYE0123: "BA12" finds the first two).
// Workshop B holds the motorcycle AB123C and no plate containing "BA12" (US1-AC8: B finds nothing).
const TENANTS: readonly SeedTenant[] = [
  {
    key: 'A',
    id: '0a000000-0000-4000-8000-00000000000a',
    name: 'Taller A (dev)',
    ruc: '1791234567001',
    users: [
      {
        id: '0a000000-0000-4000-8000-0000000000a1',
        name: 'Admin Taller A',
        email: 'admin@taller-a.test',
        role: 'admin',
      },
      {
        id: '0a000000-0000-4000-8000-0000000000a2',
        name: 'Asesor Taller A',
        email: 'asesor@taller-a.test',
        role: 'asesor',
      },
    ],
    clients: [
      {
        clientType: 'natural',
        documentType: 'cedula',
        documentNumber: '1710034065',
        firstNames: 'Ana',
        lastNames: 'Pérez',
        phone: '0991234567',
        email: 'ana.perez@example.com',
      },
      {
        clientType: 'natural',
        documentType: 'cedula',
        documentNumber: '0912345675',
        firstNames: 'Carlos',
        lastNames: 'Ruiz',
        phone: '0987654321',
        email: null,
      },
      {
        clientType: 'company',
        documentType: 'ruc',
        documentNumber: '1790012345001',
        businessName: 'Transportes Andinos S.A.',
        phone: '022345678',
        email: 'flota@transportes-andinos.example.com',
      },
    ],
    vehicles: [
      {
        ownerDocument: '1710034065',
        plate: 'PBA1234',
        vin: '1HGCM82633A004352',
        brand: 'Toyota',
        model: 'Corolla',
        year: 2020,
        color: 'Blanco',
        bodyType: 'sedan',
        initialMileage: 45000,
      },
      {
        ownerDocument: '1790012345001',
        plate: 'PBA1299',
        vin: null,
        brand: 'Chevrolet',
        model: 'D-Max',
        year: 2018,
        color: 'Gris',
        bodyType: 'pickup',
        initialMileage: 120500,
      },
      {
        ownerDocument: '0912345675',
        plate: 'GYE0123',
        vin: 'JH4KA7561PC008269',
        brand: 'Kia',
        model: 'Sportage',
        year: 2022,
        color: 'Rojo',
        bodyType: 'suv',
        initialMileage: 18000,
      },
    ],
  },
  {
    key: 'B',
    id: '0b000000-0000-4000-8000-00000000000b',
    name: 'Taller B (dev)',
    ruc: '1792345678001',
    users: [
      {
        id: '0b000000-0000-4000-8000-0000000000b1',
        name: 'Admin Taller B',
        email: 'admin@taller-b.test',
        role: 'admin',
      },
      {
        id: '0b000000-0000-4000-8000-0000000000b2',
        name: 'Asesor Taller B',
        email: 'asesor@taller-b.test',
        role: 'asesor',
      },
    ],
    clients: [
      {
        clientType: 'natural',
        documentType: 'cedula',
        documentNumber: '0104567896',
        firstNames: 'Lucía',
        lastNames: 'Núñez',
        phone: '0976543210',
        email: 'lucia.nunez@example.com',
      },
      {
        clientType: 'natural',
        documentType: 'passport',
        documentNumber: 'AB1234567',
        firstNames: 'John',
        lastNames: 'Smith',
        phone: '+14155550123',
        email: null,
      },
    ],
    vehicles: [
      {
        ownerDocument: '0104567896',
        plate: 'AB123C',
        vin: null,
        brand: 'Honda',
        model: 'CB190R',
        year: 2021,
        color: 'Negro',
        bodyType: 'motorcycle',
        initialMileage: 9000,
      },
      {
        ownerDocument: 'AB1234567',
        plate: 'GYE4567',
        vin: 'WVWZZZ1JZXW000001',
        brand: 'Volkswagen',
        model: 'Golf',
        year: 2015,
        color: 'Azul',
        bodyType: 'sedan',
        initialMileage: 150000,
      },
    ],
  },
];

const DOCUMENT_VALIDATORS = {
  cedula: isValidCedula,
  ruc: isValidRuc,
  passport: isValidPassport,
} as const;

/** Fails before touching the database if an example would be rejected by the API. */
function assertSeedIsValid(tenants: readonly SeedTenant[]): void {
  for (const tenant of tenants) {
    if (!isValidRuc(tenant.ruc)) {
      throw new Error(`Seed: invalid RUC ${tenant.ruc} for workshop ${tenant.key}`);
    }
    for (const user of tenant.users) {
      if (!isValidEmail(user.email) || normalizeEmail(user.email) !== user.email) {
        throw new Error(`Seed: invalid email ${user.email}`);
      }
    }
    const documents = new Set(
      tenant.clients.map((client) => client.documentNumber),
    );
    for (const client of tenant.clients) {
      if (!DOCUMENT_VALIDATORS[client.documentType](client.documentNumber)) {
        throw new Error(
          `Seed: invalid ${client.documentType} ${client.documentNumber}`,
        );
      }
    }
    for (const vehicle of tenant.vehicles) {
      if (!isValidPlate(vehicle.plate, vehicle.bodyType)) {
        throw new Error(
          `Seed: invalid plate ${vehicle.plate} for ${vehicle.bodyType}`,
        );
      }
      if (vehicle.vin !== null && !isValidVin(vehicle.vin)) {
        throw new Error(`Seed: invalid VIN ${vehicle.vin}`);
      }
      if (!documents.has(vehicle.ownerDocument)) {
        throw new Error(
          `Seed: owner ${vehicle.ownerDocument} of ${vehicle.plate} is not in ${tenant.key}`,
        );
      }
    }
  }
}

interface SeedCounts {
  tenants: number;
  users: number;
  clients: number;
  vehicles: number;
}

async function seedTenant(
  db: pg.Client,
  tenant: SeedTenant,
  hasher: PasswordHasher,
  counts: SeedCounts,
): Promise<void> {
  const inserted = await db.query(
    'INSERT INTO tenants (id, name, ruc) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
    [tenant.id, tenant.name, tenant.ruc],
  );
  counts.tenants += inserted.rowCount ?? 0;
  // Databases seeded before feature 002 have the workshop without RUC.
  const withRuc = await db.query(
    'UPDATE tenants SET ruc = $2 WHERE id = $1 AND ruc IS NULL',
    [tenant.id, tenant.ruc],
  );
  counts.tenants += withRuc.rowCount ?? 0;

  // Local to the transaction: from here on RLS only lets this tenant's rows through.
  await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);

  for (const user of tenant.users) {
    // ON CONFLICT without target: neither the fixed id nor the (global) email is inserted twice.
    const result = await db.query(
      `INSERT INTO users (id, name, email, password_hash, role, created_by, updated_by,
                          updated_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
       ON CONFLICT DO NOTHING`,
      [
        user.id,
        user.name,
        user.email,
        await hasher.hash(DEV_PASSWORD),
        user.role,
        SEED_ACTOR_ID,
        SEED_ACTOR_NAME,
      ],
    );
    counts.users += result.rowCount ?? 0;
  }

  for (const client of tenant.clients) {
    const result = await db.query(
      `INSERT INTO clients (client_type, document_type, document_number, first_names, last_names,
                            business_name, phone, email, created_by, updated_by, updated_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
       ON CONFLICT (tenant_id, document_number) DO NOTHING`,
      [
        client.clientType,
        client.documentType,
        client.documentNumber,
        client.clientType === 'natural' ? client.firstNames : null,
        client.clientType === 'natural' ? client.lastNames : null,
        client.clientType === 'company' ? client.businessName : null,
        client.phone,
        client.email,
        SEED_ACTOR_ID,
        SEED_ACTOR_NAME,
      ],
    );
    counts.clients += result.rowCount ?? 0;
  }

  for (const vehicle of tenant.vehicles) {
    const result = await db.query(
      `INSERT INTO vehicles (owner_client_id, plate, vin, brand, model, year, color, body_type,
                             initial_mileage, created_by, updated_by, updated_by_name)
       SELECT c.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11
         FROM clients c
        WHERE c.tenant_id = app_current_tenant() AND c.document_number = $1
       ON CONFLICT (tenant_id, plate) DO NOTHING`,
      [
        vehicle.ownerDocument,
        vehicle.plate,
        vehicle.vin,
        vehicle.brand,
        vehicle.model,
        vehicle.year,
        vehicle.color,
        vehicle.bodyType,
        vehicle.initialMileage,
        SEED_ACTOR_ID,
        SEED_ACTOR_NAME,
      ],
    );
    counts.vehicles += result.rowCount ?? 0;
  }
}

async function main(): Promise<void> {
  loadRootEnvFile();
  assertSeedIsValid(TENANTS);
  const db = new pg.Client({
    connectionString: requireEnv('DATABASE_MIGRATOR_URL'),
  });
  await db.connect();
  const hasher = new PasswordHasher();
  const counts: SeedCounts = { tenants: 0, users: 0, clients: 0, vehicles: 0 };
  try {
    await db.query('BEGIN');
    try {
      for (const tenant of TENANTS) await seedTenant(db, tenant, hasher, counts);
      await db.query('COMMIT');
    } catch (error: unknown) {
      await db.query('ROLLBACK');
      throw error;
    }
  } finally {
    await db.end();
  }

  if (counts.tenants + counts.users + counts.clients + counts.vehicles === 0) {
    console.log('Seed data already present: nothing was inserted.');
  } else {
    console.log(
      `Seed inserted or updated ${counts.tenants} tenants, ${counts.users} users, ${counts.clients} clients and ${counts.vehicles} vehicles.`,
    );
  }
  for (const tenant of TENANTS) {
    const plates = tenant.vehicles.map((vehicle) => vehicle.plate).join(', ');
    console.log(
      `Taller ${tenant.key}: ${tenant.id}  (${tenant.name}; RUC ${tenant.ruc}; placas ${plates})`,
    );
    for (const user of tenant.users) {
      console.log(`  ${user.role.padEnd(6)} ${user.email}  (${user.name})`);
    }
  }
  console.log(
    `Contraseña de desarrollo de todas las cuentas: ${DEV_PASSWORD} (solo para la base local).`,
  );
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
