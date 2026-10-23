import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';

/** scrypt cost parameters (research R3). */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
  maxmem: number;
}

/** Optional provider to override the parameters (tests lower N). */
export const PASSWORD_HASHER_PARAMS = Symbol('PASSWORD_HASHER_PARAMS');

export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = {
  N: 2 ** 15,
  r: 8,
  p: 1,
  keylen: 64,
  maxmem: 64 * 1024 * 1024,
};

const SALT_BYTES = 16;
const PREFIX = 'scrypt';
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DECIMAL = /^[1-9]\d{0,9}$/;
// Upper bounds accepted when reading a stored hash: anything above is treated as tampered.
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function derive(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function isPowerOfTwo(value: number): boolean {
  return value > 1 && (value & (value - 1)) === 0;
}

function decode(value: string): Buffer | null {
  return BASE64URL.test(value) ? Buffer.from(value, 'base64url') : null;
}

/** Parses `scrypt$N$r$p$<salt>$<hash>`; null if the format or a parameter is invalid. */
function parse(stored: string, keylen: number): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  if (![rawN, rawR, rawP].every((value) => DECIMAL.test(value))) return null;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!isPowerOfTwo(N) || N > MAX_N || r > MAX_R || p > MAX_P) return null;
  const salt = decode(rawSalt);
  const hash = decode(rawHash);
  if (!salt || salt.length !== SALT_BYTES || !hash || hash.length !== keylen) return null;
  // Rejects non-canonical encodings (extra trailing bits) so a stored value has one spelling.
  if (salt.toString('base64url') !== rawSalt || hash.toString('base64url') !== rawHash) return null;
  return { N, r, p, salt, hash };
}

/**
 * Password hashing with asynchronous scrypt (research R3): self-describing format
 * `scrypt$N$r$p$<salt base64url>$<hash base64url>`, 16-byte random salt, constant-time
 * comparison, and a dummy hash computed once at startup so unknown or disabled accounts
 * cost the same as real ones (FR-008).
 */
@Injectable()
export class PasswordHasher {
  private readonly params: ScryptParams;
  private readonly dummyHash: Promise<string>;

  constructor(
    @Optional() @Inject(PASSWORD_HASHER_PARAMS) params?: Partial<ScryptParams>,
  ) {
    this.params = { ...DEFAULT_SCRYPT_PARAMS, ...params };
    this.dummyHash = this.hash(randomBytes(32).toString('base64url'));
    // Avoids an unhandled rejection at startup; verifyAgainstDummy awaits the same promise.
    this.dummyHash.catch(() => undefined);
  }

  async hash(password: string): Promise<string> {
    const { N, r, p, keylen, maxmem } = this.params;
    const salt = randomBytes(SALT_BYTES);
    const key = await derive(password, salt, keylen, { N, r, p, maxmem });
    return [PREFIX, N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
  }

  /** True only if `password` matches `stored`. Never throws: an invalid hash gives false. */
  async verify(password: string, stored: string): Promise<boolean> {
    try {
      const parsed = parse(stored, this.params.keylen);
      if (!parsed) return false;
      const { N, r, p, salt, hash } = parsed;
      const key = await derive(password, salt, hash.length, {
        N,
        r,
        p,
        maxmem: this.params.maxmem,
      });
      return timingSafeEqual(key, hash);
    } catch {
      return false;
    }
  }

  /** Same work as verify() against a fixed dummy hash; always false (FR-008, US2-AC3). */
  async verifyAgainstDummy(password: string): Promise<false> {
    await this.verify(password, await this.dummyHash);
    return false;
  }
}
