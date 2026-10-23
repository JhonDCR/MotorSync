// T010 (specs/002-autenticacion): scrypt password hasher (research R3; FR-005, FR-006, FR-008).
// node:crypto is wrapped with spies that call the real implementation, so the tests can check
// that scrypt and timingSafeEqual are really used, without fragile timing assertions.
import * as realCrypto from 'node:crypto';
import { PasswordHasher } from './password-hasher.js';

const spies = vi.hoisted(() => ({
  scrypt: vi.fn(),
  timingSafeEqual: vi.fn(),
}));

async function mockCrypto(importOriginal: () => Promise<typeof realCrypto>) {
  const actual = await importOriginal();
  spies.scrypt.mockImplementation((...args: unknown[]) =>
    (actual.scrypt as (...a: unknown[]) => void)(...args),
  );
  spies.timingSafeEqual.mockImplementation((a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) =>
    actual.timingSafeEqual(a, b),
  );
  return {
    ...actual,
    default: { ...actual, scrypt: spies.scrypt, timingSafeEqual: spies.timingSafeEqual },
    scrypt: spies.scrypt,
    timingSafeEqual: spies.timingSafeEqual,
  };
}

vi.mock('node:crypto', mockCrypto);
vi.mock('crypto', mockCrypto);

const FAST = { N: 2 ** 10 };
const PASSWORD = 'Clave Segura 2026';

// scrypt$N$r$p$<salt base64url>$<hash base64url>: 16-byte salt (22 chars), 64-byte hash (86 chars).
const FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;

function parse(stored: string): { N: number; r: number; p: number; salt: Buffer; hash: Buffer } {
  const match = FORMAT.exec(stored);
  if (!match) throw new Error(`not in scrypt format: ${stored}`);
  return {
    N: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
    salt: Buffer.from(match[4], 'base64url'),
    hash: Buffer.from(match[5], 'base64url'),
  };
}

interface ScryptCallOptions {
  N?: number;
  r?: number;
  p?: number;
  maxmem?: number;
  cost?: number;
  blockSize?: number;
  parallelization?: number;
}

function scryptOptions(callIndex: number): { keylen: unknown; options: ScryptCallOptions } {
  const args = spies.scrypt.mock.calls[callIndex] as unknown[];
  return { keylen: args[2], options: (args[3] ?? {}) as ScryptCallOptions };
}

describe('PasswordHasher (T010, research R3)', () => {
  let hasher: PasswordHasher;

  beforeEach(() => {
    hasher = new PasswordHasher(FAST);
  });

  afterEach(() => {
    spies.scrypt.mockClear();
    spies.timingSafeEqual.mockClear();
  });

  it('[FR-006][R3] con los parámetros por defecto produce scrypt$32768$8$1$<sal>$<hash> con N=2^15, r=8, p=1, keylen=64 y maxmem=64 MiB', async () => {
    const defaults = new PasswordHasher();
    spies.scrypt.mockClear();

    const stored = await defaults.hash(PASSWORD);

    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    const parsed = parse(stored);
    expect(parsed.salt).toHaveLength(16);
    expect(parsed.hash).toHaveLength(64);
    expect(spies.scrypt).toHaveBeenCalledTimes(1);
    const { keylen, options } = scryptOptions(0);
    expect(keylen).toBe(64);
    expect(options.N ?? options.cost).toBe(32768);
    expect(options.r ?? options.blockSize).toBe(8);
    expect(options.p ?? options.parallelization).toBe(1);
    expect(options.maxmem).toBe(64 * 1024 * 1024);
  });

  it('[FR-006][R3] el hash es scrypt(contraseña, sal) con los parámetros del propio formato', async () => {
    const stored = await hasher.hash(PASSWORD);
    const parsed = parse(stored);

    expect(parsed).toMatchObject({ N: 1024, r: 8, p: 1 });
    const expected = realCrypto.scryptSync(PASSWORD, parsed.salt, 64, { N: 1024, r: 8, p: 1 });
    expect(parsed.hash.equals(expected)).toBe(true);
  });

  it('[FR-006] nunca contiene la contraseña en claro ni en base64', async () => {
    const stored = await hasher.hash(PASSWORD);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(Buffer.from(PASSWORD).toString('base64url'));
    expect(stored).not.toContain(Buffer.from(PASSWORD).toString('base64'));
  });

  it('[FR-006][R3] usa una sal distinta en cada llamada', async () => {
    const stored = await Promise.all([1, 2, 3].map(() => hasher.hash(PASSWORD)));
    const salts = stored.map((value) => parse(value).salt.toString('hex'));
    expect(new Set(salts).size).toBe(3);
    expect(new Set(stored).size).toBe(3);
  });

  it('[US2-AC2][FR-005] verify() da true con la contraseña correcta', async () => {
    const stored = await hasher.hash(PASSWORD);
    await expect(hasher.verify(PASSWORD, stored)).resolves.toBe(true);
  });

  it.each([
    ['incorrecta', 'Otra Clave 2026'],
    ['con mayúsculas cambiadas', 'clave segura 2026'],
    ['todo en mayúsculas', 'CLAVE SEGURA 2026'],
    ['con un espacio agregado al inicio', ` ${PASSWORD}`],
    ['con un espacio agregado al final', `${PASSWORD} `],
    ['vacía', ''],
  ])('[US2-AC2][FR-005] verify() da false con la contraseña %s', async (_label, attempt) => {
    const stored = await hasher.hash(PASSWORD);
    await expect(hasher.verify(attempt, stored)).resolves.toBe(false);
  });

  it('[FR-005] respeta los espacios de una contraseña que los tiene', async () => {
    const withSpaces = '  con espacios  ';
    const stored = await hasher.hash(withSpaces);
    await expect(hasher.verify(withSpaces, stored)).resolves.toBe(true);
    await expect(hasher.verify(withSpaces.trim(), stored)).resolves.toBe(false);
  });

  it('[R3] verify() lee N, r y p del hash guardado: otro hasher (por defecto) verifica un hash de N=2^10', async () => {
    const stored = await hasher.hash(PASSWORD);
    await expect(new PasswordHasher().verify(PASSWORD, stored)).resolves.toBe(true);
  });

  it('[R3] verify() compara con crypto.timingSafeEqual', async () => {
    const stored = await hasher.hash(PASSWORD);
    spies.timingSafeEqual.mockClear();

    await hasher.verify(PASSWORD, stored);
    await hasher.verify('Otra Clave 2026', stored);

    expect(spies.timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  it('[R3] un hash con formato inválido o alterado devuelve false sin lanzar', async () => {
    const stored = await hasher.hash(PASSWORD);
    const parts = stored.split('$');
    const flip = (value: string): string =>
      `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
    const invalid = [
      '',
      'texto-plano',
      PASSWORD,
      'bcrypt$2b$10$abcdefghijklmnopqrstuv',
      parts.slice(0, 5).join('$'),
      [...parts, 'extra'].join('$'),
      ['argon2', ...parts.slice(1)].join('$'),
      [parts[0], 'abc', ...parts.slice(2)].join('$'),
      [parts[0], '1000', ...parts.slice(2)].join('$'),
      [parts[0], '0', ...parts.slice(2)].join('$'),
      [parts[0], String(2 ** 30), ...parts.slice(2)].join('$'),
      [...parts.slice(0, 4), '', parts[5]].join('$'),
      [...parts.slice(0, 5), ''].join('$'),
      [...parts.slice(0, 5), parts[5].slice(0, 40)].join('$'),
      [...parts.slice(0, 5), `${parts[5]}AAAA`].join('$'),
      [...parts.slice(0, 5), flip(parts[5])].join('$'),
      [...parts.slice(0, 4), flip(parts[4]), parts[5]].join('$'),
      [...parts.slice(0, 5), '!!!not-base64url!!!'].join('$'),
    ];

    for (const candidate of invalid) {
      await expect(hasher.verify(PASSWORD, candidate), candidate).resolves.toBe(false);
    }
  });

  it('[FR-008][R3] verifyAgainstDummy() siempre da false y ejecuta scrypt con el mismo costo', async () => {
    await expect(hasher.verifyAgainstDummy(PASSWORD)).resolves.toBe(false);
    await expect(hasher.verifyAgainstDummy('')).resolves.toBe(false);
    await expect(hasher.verifyAgainstDummy('cualquier-otra')).resolves.toBe(false);

    spies.scrypt.mockClear();
    spies.timingSafeEqual.mockClear();
    await expect(hasher.verifyAgainstDummy(PASSWORD)).resolves.toBe(false);

    expect(spies.scrypt).toHaveBeenCalledTimes(1);
    const { keylen, options } = scryptOptions(0);
    expect(keylen).toBe(64);
    expect(options.N ?? options.cost).toBe(1024);
    expect(options.r ?? options.blockSize).toBe(8);
    expect(options.p ?? options.parallelization).toBe(1);
    expect(spies.timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it('[FR-008][R3] el hash ficticio se calcula una sola vez: cada verificación ficticia hace un único scrypt, igual que verify()', async () => {
    await hasher.verifyAgainstDummy(PASSWORD);
    const stored = await hasher.hash(PASSWORD);

    spies.scrypt.mockClear();
    await hasher.verify('Otra Clave 2026', stored);
    const perVerify = spies.scrypt.mock.calls.length;

    spies.scrypt.mockClear();
    await hasher.verifyAgainstDummy(PASSWORD);
    await hasher.verifyAgainstDummy(PASSWORD);
    await hasher.verifyAgainstDummy(PASSWORD);

    expect(perVerify).toBe(1);
    expect(spies.scrypt).toHaveBeenCalledTimes(3);
  });
});
