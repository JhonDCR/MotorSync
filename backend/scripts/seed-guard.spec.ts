// Ajuste 3 del reviewer T031 (specs/002-autenticacion, tasks.md "# PR2"): `npm run db:seed:dev`
// crea cuentas con una contraseña de desarrollo conocida, así que aborta si NODE_ENV=production.
// La comprobación vive en un módulo propio sin efectos al importarlo (seed-dev.ts ejecuta main() al
// cargarse), para probarla en unitarias. La e2e test/seed-dev-guard.e2e-spec.ts comprueba que el
// script compilado la usa y no inserta nada.
//
// Firma esperada (backend/scripts/seed-guard.ts):
//   export function assertSeedAllowed(env: NodeJS.ProcessEnv = process.env): void
// Lanza un Error cuyo mensaje nombra NODE_ENV cuando env.NODE_ENV (sin espacios) es 'production'.
import { assertSeedAllowed } from './seed-guard.js';

describe('assertSeedAllowed (ajuste 3 del reviewer T031)', () => {
  it('[T031-3] con NODE_ENV=production lanza un error que nombra NODE_ENV', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' })).toThrow(/NODE_ENV/);
  });

  it('[T031-3] con NODE_ENV=" production " (espacios) también aborta', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: ' production ' })).toThrow(/NODE_ENV/);
  });

  it.each([undefined, '', 'development', 'test'])(
    '[T031-3] con NODE_ENV=%j no lanza',
    (nodeEnv) => {
      const env: NodeJS.ProcessEnv = nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv };
      expect(() => assertSeedAllowed(env)).not.toThrow();
    },
  );

  it('[T031-3] por defecto lee process.env', () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(() => assertSeedAllowed()).toThrow(/NODE_ENV/);
      process.env.NODE_ENV = 'development';
      expect(() => assertSeedAllowed()).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});
