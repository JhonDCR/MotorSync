// T024 (002, PR1): rutas /auth/register y /auth/login del mockApiInterceptor (research R13), con las mismas reglas
// de specs/002-autenticacion/contracts/openapi.yaml. Archivo nuevo: mock-api.interceptor.spec.ts de la 001 no cambia.
//
// Contrato para el implementer-frontend (T025), archivos core/api/mock-api.interceptor.ts y mock-api.store.ts:
//   POST /api/v1/auth/register (RegisterRequest) → 201 SessionResponse:
//     - accessToken: JWT legible por decodeSessionToken (core/auth/current-session.ts) con role 'admin' y el
//       name de la cuenta (como los demás tokens del mock, sin firma válida). expiresIn 900.
//     - user: { id uuid, name, email normalizado (trim + minúsculas), role 'admin', mustChangePassword false };
//       workshop: { id uuid, name = workshopName recortado }.
//     - Validación (400 VALIDATION_ERROR con errors[] por campo, sin crear nada):
//         workshopName, ruc, name, email, password ausentes o vacíos → REQUIRED en cada uno;
//         ruc: se normaliza sin espacios ni guiones (normalizeDocument) y se valida con isValidRuc → INVALID_RUC;
//         email inválido (isValidEmail tras normalizar) → INVALID_EMAIL;
//         password: de 8 a 128 caracteres Unicode, sin recortar → PASSWORD_TOO_SHORT / PASSWORD_TOO_LONG;
//         cualquier campo fuera de RegisterRequest (tenantId, role…) → UNKNOWN_FIELD con field = ese nombre.
//     - 409 RUC_ALREADY_REGISTERED si el RUC normalizado ya tiene taller (sin datos de ese taller en el Problem).
//     - 409 REGISTRATION_FAILED si el correo normalizado ya existe (sin errors[]); si coinciden RUC y correo, gana
//       RUC_ALREADY_REGISTERED. Un registro rechazado no crea ni el taller ni la cuenta (el RUC queda libre).
//   POST /api/v1/auth/login (LoginRequest) → 200 SessionResponse con los datos de la cuenta:
//     - email se compara normalizado; password tal cual (distingue mayúsculas, no recorta).
//     - 400 VALIDATION_ERROR: email o password ausentes o vacíos → REQUIRED; campos extra → UNKNOWN_FIELD.
//     - 401 INVALID_CREDENTIALS con un cuerpo IDÉNTICO para correo inexistente y contraseña incorrecta.
//     - Bloqueo por correo normalizado (exista o no): 5 fallos seguidos → los siguientes intentos, aunque la
//       contraseña sea correcta, 429 ACCOUNT_LOCKED (durante 15 min). Un login correcto reinicia el contador.
//   - Ningún Problem contiene la contraseña enviada (FR-006).
//   - Las cuentas y talleres semilla del mock, si los hay, no usan los correos *@taller.ec ni los RUC de
//     src/testing/auth-fixtures.ts (VALID_RUC, OTHER_VALID_RUC, THIRD_VALID_RUC).
import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { decodeSessionToken } from '../auth/current-session';
import type { Problem } from './api.models';
import { mockApiInterceptor } from './mock-api.interceptor';
import { USE_MOCK_API } from './use-mock-api';
import {
  OTHER_VALID_RUC,
  PASSWORD,
  REGISTER_BODY,
  THIRD_VALID_RUC,
  VALID_RUC,
  type RegisterRequestFixture,
  type SessionResponseFixture,
} from '../../../testing/auth-fixtures';

const REGISTER_URL = '/api/v1/auth/register';
const LOGIN_URL = '/api/v1/auth/login';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setup(): HttpClient {
  TestBed.configureTestingModule({
    providers: [
      { provide: USE_MOCK_API, useValue: true },
      provideHttpClient(withInterceptors([mockApiInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  return TestBed.inject(HttpClient);
}

async function failure(request: Promise<unknown>): Promise<HttpErrorResponse> {
  try {
    await request;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpErrorResponse);
    return error as HttpErrorResponse;
  }
  throw new Error('Se esperaba un error HTTP y la petición tuvo éxito');
}

function problemOf(error: HttpErrorResponse): Problem {
  return error.error as Problem;
}

function fieldCodes(error: HttpErrorResponse): { field: string; code: string }[] {
  return (problemOf(error).errors ?? []).map(({ field, code }) => ({ field, code }));
}

describe('mockApiInterceptor: /auth/register y /auth/login (T024)', () => {
  let http: HttpClient;

  beforeEach(() => {
    http = setup();
  });

  afterEach(() => {
    // Nada llega al backend: el mock responde todas las rutas /api/v1/auth de estas pruebas.
    TestBed.inject(HttpTestingController).verify();
  });

  function register(body: unknown) {
    return firstValueFrom(http.post<SessionResponseFixture>(REGISTER_URL, body, { observe: 'response' }));
  }

  function login(body: unknown) {
    return firstValueFrom(http.post<SessionResponseFixture>(LOGIN_URL, body, { observe: 'response' }));
  }

  function withBody(extra: Partial<RegisterRequestFixture> & Record<string, unknown>): Record<string, unknown> {
    return { ...REGISTER_BODY, ...extra };
  }

  describe('register', () => {
    it('[US1-AC1] 201 con SessionResponse: admin sin cambio de contraseña, taller y token legible', async () => {
      const response = await register(REGISTER_BODY);

      expect(response.status).toBe(201);
      const session = response.body as SessionResponseFixture;
      expect(session.expiresIn).toBe(900);
      expect(session.user.id).toMatch(UUID);
      expect(session.user.name).toBe('Ana Pérez');
      expect(session.user.role).toBe('admin');
      expect(session.user.mustChangePassword).toBe(false);
      expect(session.workshop.id).toMatch(UUID);
      expect(session.workshop.name).toBe('Taller Andrade');
      expect(decodeSessionToken(session.accessToken)).toEqual({ role: 'admin', name: 'Ana Pérez' });
    });

    it('[US1-AC2] guarda el correo recortado y en minúsculas', async () => {
      const response = await register(withBody({ email: ' Ana.Perez@Taller.EC ' }));

      expect(response.body?.user.email).toBe('ana.perez@taller.ec');
    });

    it('[FR-006] la respuesta no contiene la contraseña', async () => {
      const response = await register(REGISTER_BODY);

      expect(JSON.stringify(response.body)).not.toContain(PASSWORD.trim());
    });

    it.each(['179001234500', '1790012345002', '1770012345001'])(
      '[US1-AC3] RUC inválido %s → 400 INVALID_RUC en ruc, sin crear el taller',
      async (ruc) => {
        const error = await failure(register(withBody({ ruc })));

        expect(error.status).toBe(400);
        expect(problemOf(error).code).toBe('VALIDATION_ERROR');
        expect(fieldCodes(error)).toContainEqual({ field: 'ruc', code: 'INVALID_RUC' });
        // No quedó nada: el mismo correo se puede registrar después con un RUC válido.
        expect((await register(REGISTER_BODY)).status).toBe(201);
      },
    );

    it('[US1-AC4] RUC repetido, también con espacios o guiones → 409 RUC_ALREADY_REGISTERED sin datos del taller', async () => {
      await register(REGISTER_BODY);

      for (const ruc of [VALID_RUC, '179 001 2345 001', '1790012345-001']) {
        const error = await failure(register(withBody({ ruc, email: `otro.${ruc.length}@taller.ec` })));
        expect(error.status).toBe(409);
        expect(problemOf(error).code).toBe('RUC_ALREADY_REGISTERED');
        expect(JSON.stringify(error.error)).not.toContain('Taller Andrade');
      }
    });

    it('[US1-AC5] correo repetido con mayúsculas → 409 REGISTRATION_FAILED sin errors[] sobre email', async () => {
      await register(REGISTER_BODY);

      const error = await failure(register(withBody({ ruc: OTHER_VALID_RUC, email: 'ANA.PEREZ@taller.ec' })));

      expect(error.status).toBe(409);
      expect(problemOf(error).code).toBe('REGISTRATION_FAILED');
      expect(fieldCodes(error).some(({ field }) => field === 'email')).toBe(false);
    });

    it('[US1-AC5] RUC y correo repetidos → RUC_ALREADY_REGISTERED', async () => {
      await register(REGISTER_BODY);

      const error = await failure(register(REGISTER_BODY));

      expect(problemOf(error).code).toBe('RUC_ALREADY_REGISTERED');
    });

    it('[US1-AC7] tras un REGISTRATION_FAILED no queda el taller: su RUC se registra después con otro correo', async () => {
      await register(REGISTER_BODY);
      await failure(register(withBody({ ruc: OTHER_VALID_RUC, email: 'ANA.PEREZ@taller.ec' })));

      const response = await register(withBody({ ruc: OTHER_VALID_RUC, email: 'luis@taller.ec' }));

      expect(response.status).toBe(201);
    });

    it('[US1-AC6] cada campo obligatorio ausente o vacío → REQUIRED en ese campo', async () => {
      const error = await failure(register({ workshopName: '', ruc: '  ', name: '' }));

      expect(error.status).toBe(400);
      expect(problemOf(error).code).toBe('VALIDATION_ERROR');
      const codes = fieldCodes(error);
      for (const field of ['workshopName', 'ruc', 'name', 'email', 'password']) {
        expect(codes).toContainEqual({ field, code: 'REQUIRED' });
      }
    });

    it('[US1-AC6][FR-005] contraseña de 7 caracteres → PASSWORD_TOO_SHORT; 7 emojis también (longitud Unicode)', async () => {
      for (const password of ['Abc1234', '😀'.repeat(7)]) {
        const error = await failure(register(withBody({ password })));
        expect(fieldCodes(error)).toContainEqual({ field: 'password', code: 'PASSWORD_TOO_SHORT' });
        expect(JSON.stringify(error.error)).not.toContain(password);
      }
    });

    it('[FR-005] 8 caracteres Unicode valen, y los espacios cuentan porque la contraseña no se recorta', async () => {
      const response = await register(withBody({ password: 'ñ'.repeat(8) }));
      expect(response.status).toBe(201);

      // 6 letras + 2 espacios = 8 caracteres: válida porque no se recorta.
      const spaced = await register(withBody({ ruc: OTHER_VALID_RUC, email: 'luis@taller.ec', password: ' abcdef ' }));
      expect(spaced.status).toBe(201);
    });

    it('[FR-005] contraseña de 129 caracteres → PASSWORD_TOO_LONG', async () => {
      const error = await failure(register(withBody({ password: 'a'.repeat(129) })));

      expect(fieldCodes(error)).toContainEqual({ field: 'password', code: 'PASSWORD_TOO_LONG' });
    });

    it('[US1-AC6] correo con formato inválido → INVALID_EMAIL', async () => {
      const error = await failure(register(withBody({ email: 'ana@taller' })));

      expect(fieldCodes(error)).toContainEqual({ field: 'email', code: 'INVALID_EMAIL' });
    });

    it.each(['tenantId', 'role'])('[US1-AC9] %s en el cuerpo → 400 UNKNOWN_FIELD, sin crear nada', async (field) => {
      const error = await failure(register(withBody({ [field]: field === 'role' ? 'asesor' : 'x' })));

      expect(error.status).toBe(400);
      expect(fieldCodes(error)).toContainEqual({ field, code: 'UNKNOWN_FIELD' });
      expect((await register(REGISTER_BODY)).status).toBe(201);
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      await register(REGISTER_BODY);
    });

    it('[US2-AC1] 200 con la SessionResponse de la cuenta y su taller', async () => {
      const response = await login({ email: 'ana.perez@taller.ec', password: PASSWORD });

      expect(response.status).toBe(200);
      const session = response.body as SessionResponseFixture;
      expect(session.user.email).toBe('ana.perez@taller.ec');
      expect(session.user.role).toBe('admin');
      expect(session.user.mustChangePassword).toBe(false);
      expect(session.workshop.name).toBe('Taller Andrade');
      expect(decodeSessionToken(session.accessToken)).toEqual({ role: 'admin', name: 'Ana Pérez' });
    });

    it('[US2-AC2] el correo con espacios y mayúsculas funciona igual', async () => {
      const response = await login({ email: ' ANA.Perez@taller.ec ', password: PASSWORD });

      expect(response.status).toBe(200);
    });

    it('[US2-AC2][FR-005] la contraseña distingue mayúsculas y no se recorta', async () => {
      for (const password of [PASSWORD.toUpperCase(), PASSWORD.trim(), `${PASSWORD} `]) {
        const error = await failure(login({ email: 'ana.perez@taller.ec', password }));
        expect(error.status).toBe(401);
        expect(problemOf(error).code).toBe('INVALID_CREDENTIALS');
      }
    });

    it('[US2-AC3][FR-008] correo inexistente y contraseña incorrecta → el mismo 401 INVALID_CREDENTIALS', async () => {
      const unknown = await failure(login({ email: 'nadie@taller.ec', password: PASSWORD }));
      const wrong = await failure(login({ email: 'ana.perez@taller.ec', password: 'Otra clave 1' }));

      expect(unknown.status).toBe(401);
      expect(problemOf(unknown).code).toBe('INVALID_CREDENTIALS');
      expect(wrong.error).toEqual(unknown.error);
    });

    it('[FR-006] el Problem de un login fallido no contiene la contraseña enviada', async () => {
      const error = await failure(login({ email: 'ana.perez@taller.ec', password: 'Clave-Secreta-999' }));

      expect(JSON.stringify(error.error)).not.toContain('Clave-Secreta-999');
    });

    it('[US2-AC5] 5 fallos y luego la contraseña correcta → 429 ACCOUNT_LOCKED', async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const error = await failure(login({ email: 'ana.perez@taller.ec', password: 'incorrecta' }));
        expect(problemOf(error).code).toBe('INVALID_CREDENTIALS');
      }

      const locked = await failure(login({ email: ' ANA.PEREZ@taller.ec', password: PASSWORD }));

      expect(locked.status).toBe(429);
      expect(problemOf(locked).code).toBe('ACCOUNT_LOCKED');
    });

    it('[US2-AC8] un correo inexistente también se bloquea tras 5 fallos, con la misma respuesta', async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        await failure(login({ email: 'nadie@taller.ec', password: 'incorrecta' }));
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        await failure(login({ email: 'ana.perez@taller.ec', password: 'incorrecta' }));
      }

      const unknown = await failure(login({ email: 'nadie@taller.ec', password: 'incorrecta' }));
      const existing = await failure(login({ email: 'ana.perez@taller.ec', password: 'incorrecta' }));

      expect(unknown.status).toBe(429);
      expect(problemOf(unknown).code).toBe('ACCOUNT_LOCKED');
      expect(unknown.error).toEqual(existing.error);
    });

    it('[US2-AC7] un login correcto reinicia el contador: 4 fallos, acierto, 4 fallos y acierto → 200', async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await failure(login({ email: 'ana.perez@taller.ec', password: 'incorrecta' }));
      }
      expect((await login({ email: 'ana.perez@taller.ec', password: PASSWORD })).status).toBe(200);
      for (let attempt = 0; attempt < 4; attempt++) {
        await failure(login({ email: 'ana.perez@taller.ec', password: 'incorrecta' }));
      }

      expect((await login({ email: 'ana.perez@taller.ec', password: PASSWORD })).status).toBe(200);
    });

    it('[FR-009] el bloqueo es por correo: otra cuenta sigue entrando', async () => {
      await register(withBody({ ruc: THIRD_VALID_RUC, email: 'luis@taller.ec', name: 'Luis Mora' }));
      for (let attempt = 0; attempt < 5; attempt++) {
        await failure(login({ email: 'ana.perez@taller.ec', password: 'incorrecta' }));
      }

      const response = await login({ email: 'luis@taller.ec', password: PASSWORD });

      expect(response.status).toBe(200);
      expect(response.body?.user.name).toBe('Luis Mora');
    });

    it('[contrato LoginRequest] email o password vacíos → 400 REQUIRED en cada uno', async () => {
      const error = await failure(login({ email: '  ', password: '' }));

      expect(error.status).toBe(400);
      expect(problemOf(error).code).toBe('VALIDATION_ERROR');
      expect(fieldCodes(error)).toContainEqual({ field: 'email', code: 'REQUIRED' });
      expect(fieldCodes(error)).toContainEqual({ field: 'password', code: 'REQUIRED' });
    });

    it.each(['tenantId', 'role'])('[US2-AC10] %s en el cuerpo → 400 UNKNOWN_FIELD', async (field) => {
      const error = await failure(login({ email: 'ana.perez@taller.ec', password: PASSWORD, [field]: 'asesor' }));

      expect(error.status).toBe(400);
      expect(fieldCodes(error)).toContainEqual({ field, code: 'UNKNOWN_FIELD' });
    });
  });
});
