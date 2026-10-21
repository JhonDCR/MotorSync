import { InjectionToken } from '@angular/core';

/**
 * Activa la API simulada (research.md R8). app.config.ts lo provee desde `environment.useMockApi`,
 * que solo vale `true` en la configuración `mock` de angular.json (fileReplacements a environment.mock.ts).
 * Fuera de app.config (por ejemplo, en pruebas) vale `false`.
 */
export const USE_MOCK_API = new InjectionToken<boolean>('USE_MOCK_API', {
  providedIn: 'root',
  factory: () => false,
});
