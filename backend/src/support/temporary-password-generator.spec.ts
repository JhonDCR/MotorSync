// T009 (specs/003-soporte-plataforma): generador de contraseñas temporales por soporte
// (FR-019, research R9 y decisión 7 del humano). Entrega en rojo: el módulo de producción
// llega en T010. La temporal tiene 16 símbolos en 4 bloques de 4 con guiones (19 caracteres).
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../common/validation/is-password.js';
import {
  generateTemporaryPassword,
  TEMPORARY_PASSWORD_ALPHABET,
  TEMPORARY_PASSWORD_PATTERN,
  type RandomInt,
} from './temporary-password-generator.js';

const FORBIDDEN_SYMBOLS = ['0', 'O', '1', 'I', 'L'];
const LOWER_CASE = /[a-z]/;
const ALPHABET_SYMBOL = /^[A-HJ-NP-Z2-9]$/;
const ALPHABET_BLOCK = /^[A-HJ-NP-Z2-9]{4}$/;

function symbolsOf(temporary: string): string[] {
  const symbols: string[] = [];
  // for...of (not spread): the format is ASCII-only, so each character is one symbol.
  for (const symbol of temporary) {
    if (symbol !== '-') symbols.push(symbol);
  }
  return symbols;
}

function recordingRandomInt(value: number): {
  randomInt: RandomInt;
  calls: Array<[number, number]>;
} {
  const calls: Array<[number, number]> = [];
  const randomInt: RandomInt = (min: number, max: number) => {
    calls.push([min, max]);
    return value;
  };
  return { randomInt, calls };
}

describe('generateTemporaryPassword (T009, FR-019, research R9)', () => {
  let temporaries: string[];

  beforeAll(() => {
    temporaries = Array.from({ length: 1000 }, () =>
      generateTemporaryPassword(),
    );
  });

  it('[FR-019][R9][T009] usa el alfabeto de 31 símbolos de research R9', () => {
    expect(TEMPORARY_PASSWORD_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789');
    expect(TEMPORARY_PASSWORD_ALPHABET).toHaveLength(31);
    expect(new Set(TEMPORARY_PASSWORD_ALPHABET).size).toBe(31);
    for (const symbol of TEMPORARY_PASSWORD_ALPHABET) {
      expect(symbol).toMatch(ALPHABET_SYMBOL);
      expect(symbol).not.toMatch(LOWER_CASE);
      expect(FORBIDDEN_SYMBOLS).not.toContain(symbol);
    }
  });

  it('[FR-019][R9][T009] las 1000 temporales cumplen el formato, miden 19 y no usan símbolos confundibles ni minúsculas', () => {
    for (const temporary of temporaries) {
      expect(temporary).toMatch(TEMPORARY_PASSWORD_PATTERN);
      expect(temporary).toHaveLength(19);
      // Carácter a carácter: solo símbolos del alfabeto, nunca 0/O/1/I/L ni minúsculas.
      for (const symbol of temporary) {
        if (symbol === '-') continue;
        expect(TEMPORARY_PASSWORD_ALPHABET).toContain(symbol);
        expect(FORBIDDEN_SYMBOLS).not.toContain(symbol);
        expect(symbol).not.toMatch(LOWER_CASE);
      }
      expect(temporary).not.toMatch(/[0O1IL]/);
      expect(temporary).not.toMatch(LOWER_CASE);
    }
  });

  it('[FR-019][R9][T009] agrupa los 16 símbolos en 4 bloques de 4 separados por guiones', () => {
    for (const temporary of temporaries) {
      const blocks = temporary.split('-');
      expect(blocks).toHaveLength(4);
      for (const block of blocks) {
        expect(block).toHaveLength(4);
        expect(block).toMatch(ALPHABET_BLOCK);
      }
      expect(symbolsOf(temporary)).toHaveLength(16);
    }
  });

  it('[FR-019][T009] las 1000 temporales son distintas', () => {
    expect(new Set(temporaries).size).toBe(1000);
  });

  it('[FR-019][T009] todas pasan la política de contraseña de la 002 (8 a 128 caracteres)', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
    for (const temporary of temporaries) {
      // The format is ASCII-only, so UTF-16 length equals the Unicode code point length
      // that the 002 policy measures (FR-005 de la 002).
      const length = temporary.length;
      expect(length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      expect(length).toBeLessThanOrEqual(PASSWORD_MAX_LENGTH);
    }
  });

  it('[FR-019][R9][T009] con randomInt inyectado lo invoca exactamente 16 veces, siempre con (0, 31)', () => {
    const { randomInt, calls } = recordingRandomInt(0);

    generateTemporaryPassword(randomInt);

    expect(calls).toHaveLength(16);
    expect(calls).toEqual(
      Array.from({ length: 16 }, (): [number, number] => [
        0,
        TEMPORARY_PASSWORD_ALPHABET.length,
      ]),
    );
  });

  it('[FR-019][R9][T009] mapea el alfabeto: randomInt = 0 da AAAA-AAAA-AAAA-AAAA', () => {
    expect(generateTemporaryPassword(() => 0)).toBe('AAAA-AAAA-AAAA-AAAA');
  });

  it('[FR-019][R9][T009] mapea el alfabeto: randomInt = 30 da 9999-9999-9999-9999', () => {
    expect(generateTemporaryPassword(() => 30)).toBe('9999-9999-9999-9999');
  });

  it('[FR-019][R9][T009] respeta el orden de los bloques con una secuencia conocida', () => {
    const indexes = Array.from({ length: 16 }, (_, index) => index);
    let call = 0;

    const temporary = generateTemporaryPassword(() => indexes[call++]);

    expect(temporary).toBe('ABCD-EFGH-JKMN-PQRS');
    expect(symbolsOf(temporary)).toEqual(
      indexes.map((index) => TEMPORARY_PASSWORD_ALPHABET[index]),
    );
  });

  it('[FR-019][R9][T009] el mapeo es uniforme: con ~31 000 muestras cada símbolo aparece entre 700 y 1300 veces', () => {
    // Fake determinista que recorre 0..30 en ciclo. Solo demuestra que el generador indexa el
    // alfabeto de forma uniforme (sin `%` ni sesgo de módulo), NO la calidad criptográfica:
    // esa la aporta `node:crypto.randomInt` en la implementación de T010.
    let next = 0;
    const cyclingRandomInt: RandomInt = () => {
      const value = next % TEMPORARY_PASSWORD_ALPHABET.length;
      next += 1;
      return value;
    };

    // 1 940 temporales × 16 símbolos = 31 040 muestras (las 31 000 de T009, redondeadas a
    // temporales completos).
    const counts = new Map<string, number>();
    let samples = 0;
    for (let temporary = 0; temporary < 1940; temporary += 1) {
      for (const symbol of symbolsOf(
        generateTemporaryPassword(cyclingRandomInt),
      )) {
        counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
        samples += 1;
      }
    }

    expect(samples).toBe(31_040);
    expect(counts.size).toBe(31);
    for (const symbol of TEMPORARY_PASSWORD_ALPHABET) {
      const count = counts.get(symbol) ?? 0;
      expect(count).toBeGreaterThanOrEqual(700);
      expect(count).toBeLessThanOrEqual(1300);
    }
  });
});
