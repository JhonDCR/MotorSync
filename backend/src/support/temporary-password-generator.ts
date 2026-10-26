import { randomInt as cryptoRandomInt } from 'node:crypto';

/**
 * 31 symbols of research R9 (decision 7): uppercase letters and digits without `0`, `O`, `1`,
 * `I` or `L`, so a temporary password can be dictated without confusable characters. Lowercase
 * is excluded on purpose: the temporary is typed exactly as shown.
 */
export const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 16 symbols in 4 blocks of 4 joined by hyphens: `ABCD-EFGH-JKMN-PQRS` (19 characters). */
export const TEMPORARY_PASSWORD_PATTERN =
  /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/;

/** Source of a uniform integer in `[min, max)`; injectable so tests can make it deterministic. */
export type RandomInt = (min: number, max: number) => number;

const BLOCKS = 4;
const SYMBOLS_PER_BLOCK = 4;

/**
 * Generates a temporary password of 16 symbols (research R9, FR-019) with `node:crypto.randomInt`,
 * which is uniform and cryptographically secure: no `%` and no `Math.random`.
 *
 * The value is used exactly as returned, hyphens and uppercase included, because the 002 login
 * compares the password as typed. Only its scrypt hash is stored, never the temporary itself.
 * Used by the operations script (T026) and by the support temporary password (T053).
 */
export function generateTemporaryPassword(
  randomInt: RandomInt = cryptoRandomInt,
): string {
  const blocks: string[] = [];
  for (let block = 0; block < BLOCKS; block += 1) {
    let symbols = '';
    for (let symbol = 0; symbol < SYMBOLS_PER_BLOCK; symbol += 1) {
      symbols +=
        TEMPORARY_PASSWORD_ALPHABET[
          randomInt(0, TEMPORARY_PASSWORD_ALPHABET.length)
        ];
    }
    blocks.push(symbols);
  }
  return blocks.join('-');
}
