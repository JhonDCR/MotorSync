// T003 (specs/005-presupuestos): fixed-point money math, half-up rounding, no floats.
import {
  DEFAULT_TAX_RATE,
  computeTotals,
  lineTotal,
  parseMoney,
} from './money.util.js';

describe('money.util (T003)', () => {
  it('[US1-AC1] 2 x 18.50 = 37.00', () => {
    expect(lineTotal('2', '18.50')).toBe('37.00');
  });

  it('[US1-AC1][SC-002] subtotal 62.00 -> IVA 9.30 y total 71.30 con la tasa por defecto', () => {
    expect(DEFAULT_TAX_RATE).toBe('0.15');
    expect(computeTotals(['37.00', '25.00'])).toEqual({
      subtotal: '62.00',
      tax: '9.30',
      total: '71.30',
    });
  });

  it('[SC-002] redondea mitad hacia arriba: 1.5 x 0.33 = 0.495 -> 0.50', () => {
    expect(lineTotal('1.5', '0.33')).toBe('0.50');
  });

  it('[US1-AC3] rechaza mas de 2 decimales', () => {
    expect(() => parseMoney('1.234')).toThrow();
    expect(() => lineTotal('1', '1.234')).toThrow();
    expect(parseMoney('18.50')).toBe(1850n);
  });
});
