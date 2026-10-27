/** D1: fixed-point money math in integer cents (BigInt); never floating point. */
export const DEFAULT_TAX_RATE = '0.15';

const MONEY_RE = /^(\d{1,10})(?:\.(\d{1,2}))?$/;
const RATE_RE = /^(\d)(?:\.(\d{1,4}))?$/;

export class InvalidMoneyError extends Error {}

/** "18.50" -> 1850n. Throws on more than 2 decimals or a malformed amount. */
export function parseMoney(s: string): bigint {
  const m = MONEY_RE.exec(s);
  if (!m) throw new InvalidMoneyError(`Monto inválido: ${s}`);
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

/** "0.15" -> 1500n (ten-thousandths). */
function parseRate(s: string): bigint {
  const m = RATE_RE.exec(s);
  if (!m) throw new InvalidMoneyError(`Tasa inválida: ${s}`);
  return BigInt(m[1]) * 10000n + BigInt((m[2] ?? '').padEnd(4, '0'));
}

/** Divides a non-negative amount rounding half up. */
function divHalfUp(n: bigint, d: bigint): bigint {
  return (n + d / 2n) / d;
}

export function formatCents(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** quantity x unitPrice rounded half up to cents. */
export function lineTotal(qty: string, unitPrice: string): string {
  return formatCents(divHalfUp(parseMoney(qty) * parseMoney(unitPrice), 100n));
}

export interface Totals {
  subtotal: string;
  tax: string;
  total: string;
}

export function computeTotals(
  lineTotals: readonly string[],
  taxRate = DEFAULT_TAX_RATE,
): Totals {
  const subtotal = lineTotals.reduce((acc, t) => acc + parseMoney(t), 0n);
  const tax = divHalfUp(subtotal * parseRate(taxRate), 10000n);
  return {
    subtotal: formatCents(subtotal),
    tax: formatCents(tax),
    total: formatCents(subtotal + tax),
  };
}
