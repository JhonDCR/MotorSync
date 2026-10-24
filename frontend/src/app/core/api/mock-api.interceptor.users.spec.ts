import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  REGISTER_BODY,
  type SessionResponseFixture,
} from '../../../testing/auth-fixtures';
import type {
  CreateUserRequest,
  Problem,
  UserAccount,
  UserHistoryResponse,
  UserListResponse,
} from './api.models';
import { mockApiInterceptor } from './mock-api.interceptor';
import { USE_MOCK_API } from './use-mock-api';

const REGISTER_URL = '/api/v1/auth/register';
const USERS_URL = '/api/v1/users';

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function problemOf(error: unknown): Problem {
  if (error instanceof HttpErrorResponse && typeof error.error === 'object' && error.error !== null) {
    return error.error as Problem;
  }
  throw new Error(`Expected Problem, received: ${String(error)}`);
}

describe('mockApiInterceptor: users (T057)', () => {
  let http: HttpClient;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: USE_MOCK_API, useValue: true },
        provideHttpClient(withInterceptors([mockApiInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
  });

  async function registerAdmin(email = 'admin.taller@taller.ec'): Promise<SessionResponseFixture> {
    return firstValueFrom(
      http.post<SessionResponseFixture>(
        REGISTER_URL,
        { ...REGISTER_BODY, email },
        { withCredentials: true },
      ),
    );
  }

  describe('GET /api/v1/users', () => {
    it('[US4-AC1] admin lista las cuentas del taller (activas y desactivadas)', async () => {
      const admin = await registerAdmin();
      const res = await firstValueFrom(
        http.get<UserListResponse>(USERS_URL, { headers: bearer(admin.accessToken) }),
      );

      expect(res.items.length).toBeGreaterThanOrEqual(1);
      const current = res.items.find((u) => u.email === admin.user.email);
      expect(current).toBeDefined();
      expect(current?.role).toBe('admin');
      expect(current?.status).toBe('active');
    });

    it('[US4-AC16] un asesor recibe 403 FORBIDDEN', async () => {
      const admin = await registerAdmin();
      const created = await firstValueFrom(
        http.post<UserAccount>(
          USERS_URL,
          {
            name: 'Asesor Prueba',
            email: 'asesor.prueba@taller.ec',
            role: 'asesor',
            temporaryPassword: 'TempPassword123',
          } satisfies CreateUserRequest,
          { headers: bearer(admin.accessToken) },
        ),
      );

      // Login as the asesor
      const asesorLogin = await firstValueFrom(
        http.post<SessionResponseFixture>(
          '/api/v1/auth/login',
          { email: created.email, password: 'TempPassword123' },
          { withCredentials: true },
        ),
      );

      // Change temporary password first so the asesor has normal session
      const changed = await firstValueFrom(
        http.post<SessionResponseFixture>(
          '/api/v1/auth/password',
          { currentPassword: 'TempPassword123', newPassword: 'NewPassword123' },
          { headers: bearer(asesorLogin.accessToken) },
        ),
      );

      let error: unknown;
      try {
        await firstValueFrom(
          http.get<UserListResponse>(USERS_URL, { headers: bearer(changed.accessToken) }),
        );
      } catch (err) {
        error = err;
      }

      expect(problemOf(error).code).toBe('FORBIDDEN');
      expect(problemOf(error).status).toBe(403);
    });

    it('[FR-010] sin token responde 401 UNAUTHORIZED', async () => {
      let error: unknown;
      try {
        await firstValueFrom(http.get<UserListResponse>(USERS_URL));
      } catch (err) {
        error = err;
      }
      expect(problemOf(error).code).toBe('UNAUTHORIZED');
    });
  });

  describe('POST /api/v1/users', () => {
    it('[US4-AC2] admin crea cuenta con contraseña temporal válida 72h', async () => {
      const admin = await registerAdmin();
      const req: CreateUserRequest = {
        name: 'Carlos Asesor',
        email: 'carlos@taller.ec',
        role: 'asesor',
        temporaryPassword: 'TempPassword123',
      };

      const user = await firstValueFrom(
        http.post<UserAccount>(USERS_URL, req, { headers: bearer(admin.accessToken) }),
      );

      expect(user.id).toBeDefined();
      expect(user.name).toBe('Carlos Asesor');
      expect(user.email).toBe('carlos@taller.ec');
      expect(user.role).toBe('asesor');
      expect(user.status).toBe('active');
      expect(user.mustChangePassword).toBe(true);
      expect(user.temporaryPasswordExpiresAt).toBeDefined();

      const expiresMs = Date.parse(user.temporaryPasswordExpiresAt!);
      const diffHours = (expiresMs - Date.now()) / (3600 * 1000);
      expect(diffHours).toBeGreaterThan(71);
      expect(diffHours).toBeLessThanOrEqual(72.1);
    });

    it('[US4-AC3] 409 EMAIL_UNAVAILABLE si el correo ya existe', async () => {
      const admin = await registerAdmin();
      const req: CreateUserRequest = {
        name: 'Carlos Duplicado',
        email: admin.user.email,
        role: 'asesor',
        temporaryPassword: 'TempPassword123',
      };

      let error: unknown;
      try {
        await firstValueFrom(http.post<UserAccount>(USERS_URL, req, { headers: bearer(admin.accessToken) }));
      } catch (err) {
        error = err;
      }

      expect(problemOf(error).code).toBe('EMAIL_UNAVAILABLE');
      expect(problemOf(error).status).toBe(409);
    });

    it('[US4-AC4] 400 VALIDATION_ERROR en campos inválidos o ausentes', async () => {
      const admin = await registerAdmin();
      const req = {
        name: 'A', // too short
        email: 'invalid-email',
        role: 'invalid-role',
        temporaryPassword: '123', // too short
      };

      let error: unknown;
      try {
        await firstValueFrom(http.post<UserAccount>(USERS_URL, req, { headers: bearer(admin.accessToken) }));
      } catch (err) {
        error = err;
      }

      expect(problemOf(error).code).toBe('VALIDATION_ERROR');
      expect(problemOf(error).status).toBe(400);
    });
  });

  describe('GET /api/v1/users/:id', () => {
    it('[US4-AC1] devuelve la cuenta por ID (200)', async () => {
      const admin = await registerAdmin();
      const created = await firstValueFrom(
        http.post<UserAccount>(
          USERS_URL,
          {
            name: 'Laura Gomez',
            email: 'laura@taller.ec',
            role: 'asesor',
            temporaryPassword: 'TempPassword123',
          },
          { headers: bearer(admin.accessToken) },
        ),
      );

      const fetched = await firstValueFrom(
        http.get<UserAccount>(`${USERS_URL}/${created.id}`, { headers: bearer(admin.accessToken) }),
      );

      expect(fetched.id).toBe(created.id);
      expect(fetched.name).toBe('Laura Gomez');
    });

    it('[US4-AC17] 404 NOT_FOUND para ID inexistente', async () => {
      const admin = await registerAdmin();
      let error: unknown;
      try {
        await firstValueFrom(
          http.get<UserAccount>(`${USERS_URL}/00000000-0000-0000-0000-000000000000`, {
            headers: bearer(admin.accessToken),
          }),
        );
      } catch (err) {
        error = err;
      }
      expect(problemOf(error).code).toBe('NOT_FOUND');
    });
  });

  describe('PUT /api/v1/users/:id/role', () => {
    it('[US4-AC5] cambia el rol y registra auditoría', async () => {
      const admin = await registerAdmin();
      const created = await firstValueFrom(
        http.post<UserAccount>(
          USERS_URL,
          {
            name: 'Marcos Asesor',
            email: 'marcos@taller.ec',
            role: 'asesor',
            temporaryPassword: 'TempPassword123',
          },
          { headers: bearer(admin.accessToken) },
        ),
      );

      const updated = await firstValueFrom(
        http.put<UserAccount>(
          `${USERS_URL}/${created.id}/role`,
          { role: 'admin' },
          { headers: bearer(admin.accessToken) },
        ),
      );

      expect(updated.role).toBe('admin');

      // Check history
      const history = await firstValueFrom(
        http.get<UserHistoryResponse>(`${USERS_URL}/${created.id}/history`, {
          headers: bearer(admin.accessToken),
        }),
      );

      expect(history.items.length).toBe(1);
      expect(history.items[0].action).toBe('user.role_changed');
      expect(history.items[0].before).toEqual({ role: 'asesor' });
      expect(history.items[0].after).toEqual({ role: 'admin' });
    });

    it('[US4-AC9] 409 LAST_ADMIN si el taller quedaría sin administrador activo', async () => {
      const admin = await registerAdmin();
      let error: unknown;
      try {
        await firstValueFrom(
          http.put<UserAccount>(
            `${USERS_URL}/${admin.user.id}/role`,
            { role: 'asesor' },
            { headers: bearer(admin.accessToken) },
          ),
        );
      } catch (err) {
        error = err;
      }

      expect(problemOf(error).code).toBe('LAST_ADMIN');
      expect(problemOf(error).status).toBe(409);
    });
  });

  describe('POST /api/v1/users/:id/deactivate and reactivate', () => {
    it('[US4-AC6][US4-AC7] desactiva una cuenta y luego la reactiva con auditorías', async () => {
      const admin = await registerAdmin();
      const created = await firstValueFrom(
        http.post<UserAccount>(
          USERS_URL,
          {
            name: 'Pedro Asesor',
            email: 'pedro@taller.ec',
            role: 'asesor',
            temporaryPassword: 'TempPassword123',
          },
          { headers: bearer(admin.accessToken) },
        ),
      );

      // Deactivate
      const deactivated = await firstValueFrom(
        http.post<UserAccount>(`${USERS_URL}/${created.id}/deactivate`, {}, { headers: bearer(admin.accessToken) }),
      );
      expect(deactivated.status).toBe('inactive');

      // Reactivate
      const reactivated = await firstValueFrom(
        http.post<UserAccount>(`${USERS_URL}/${created.id}/reactivate`, {}, { headers: bearer(admin.accessToken) }),
      );
      expect(reactivated.status).toBe('active');

      // Check history (ordered newest first)
      const history = await firstValueFrom(
        http.get<UserHistoryResponse>(`${USERS_URL}/${created.id}/history`, {
          headers: bearer(admin.accessToken),
        }),
      );

      expect(history.items.length).toBe(2);
      expect(history.items[0].action).toBe('user.reactivated');
      expect(history.items[1].action).toBe('user.deactivated');
    });

    it('[US4-AC10] 409 LAST_ADMIN al intentar desactivar el único administrador activo', async () => {
      const admin = await registerAdmin();
      let error: unknown;
      try {
        await firstValueFrom(
          http.post<UserAccount>(`${USERS_URL}/${admin.user.id}/deactivate`, {}, { headers: bearer(admin.accessToken) }),
        );
      } catch (err) {
        error = err;
      }

      expect(problemOf(error).code).toBe('LAST_ADMIN');
    });
  });

  describe('POST /api/v1/users/:id/password-reset', () => {
    it('[US4-AC21] restablece contraseña con temporal y registra auditoría', async () => {
      const admin = await registerAdmin();
      const created = await firstValueFrom(
        http.post<UserAccount>(
          USERS_URL,
          {
            name: 'Elena Asesor',
            email: 'elena@taller.ec',
            role: 'asesor',
            temporaryPassword: 'TempPassword123',
          },
          { headers: bearer(admin.accessToken) },
        ),
      );

      const reset = await firstValueFrom(
        http.post<UserAccount>(
          `${USERS_URL}/${created.id}/password-reset`,
          { temporaryPassword: 'NewTempPassword789' },
          { headers: bearer(admin.accessToken) },
        ),
      );

      expect(reset.mustChangePassword).toBe(true);

      const history = await firstValueFrom(
        http.get<UserHistoryResponse>(`${USERS_URL}/${created.id}/history`, {
          headers: bearer(admin.accessToken),
        }),
      );

      expect(history.items.length).toBe(1);
      expect(history.items[0].action).toBe('user.password_reset');
    });

    it('[US4-AC23] 409 SELF_RESET_NOT_ALLOWED al restablecer la propia cuenta', async () => {
      const admin = await registerAdmin();
      let error: unknown;
      try {
        await firstValueFrom(
          http.post<UserAccount>(
            `${USERS_URL}/${admin.user.id}/password-reset`,
            { temporaryPassword: 'AnotherPassword123' },
            { headers: bearer(admin.accessToken) },
          ),
        );
      } catch (err) {
        error = err;
      }

      expect(problemOf(error).code).toBe('SELF_RESET_NOT_ALLOWED');
      expect(problemOf(error).status).toBe(409);
    });
  });
});

// Revisión del PR3: el mock debe comportarse como el backend (backend/src/users/*, data-model.md "audit_log").
//   - user.deactivated: after = { status: 'inactive', sessionsClosed: <sesiones vivas cerradas> }.
//   - user.password_reset: before = { mustChangePassword: <valor previo> }, after = { mustChangePassword: true,
//     temporaryPasswordExpiresAt: <ISO de la cuenta devuelta>, sessionsClosed: <sesiones vivas cerradas> }.
//   - El ValidationPipe del backend valida el body ANTES de que el controlador busque la cuenta: un body inválido
//     da 400 VALIDATION_ERROR aunque el id no exista (o sea la propia cuenta en password-reset).
//   - Rol inválido: @IsIn sin context → FieldError { field: 'role', code: 'VALIDATION_ERROR' } (app.setup.ts).
//   - GET /users: ORDER BY status, name → activas primero y, dentro de cada estado, por nombre.
describe('mockApiInterceptor: users, coherencia con el backend (revisión PR3)', () => {
  let http: HttpClient;
  const MISSING_ID = '9b2f4c1e-5d6a-4b7c-8e9f-0a1b2c3d4e5f';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: USE_MOCK_API, useValue: true },
        provideHttpClient(withInterceptors([mockApiInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
  });

  async function registerAdmin(): Promise<SessionResponseFixture> {
    return firstValueFrom(
      http.post<SessionResponseFixture>(
        REGISTER_URL,
        { ...REGISTER_BODY, email: 'admin.coherencia@taller.ec' },
        { withCredentials: true },
      ),
    );
  }

  async function createUser(admin: SessionResponseFixture, name: string, email: string): Promise<UserAccount> {
    return firstValueFrom(
      http.post<UserAccount>(
        USERS_URL,
        { name, email, role: 'asesor', temporaryPassword: 'TempPassword123' } satisfies CreateUserRequest,
        { headers: bearer(admin.accessToken) },
      ),
    );
  }

  async function login(email: string, password: string): Promise<SessionResponseFixture> {
    return firstValueFrom(
      http.post<SessionResponseFixture>('/api/v1/auth/login', { email, password }, { withCredentials: true }),
    );
  }

  async function failure(request: Promise<unknown>): Promise<Problem> {
    try {
      await request;
    } catch (err) {
      return problemOf(err);
    }
    throw new Error('Se esperaba un error');
  }

  async function historyOf(admin: SessionResponseFixture, userId: string): Promise<UserHistoryResponse> {
    return firstValueFrom(
      http.get<UserHistoryResponse>(`${USERS_URL}/${userId}/history`, { headers: bearer(admin.accessToken) }),
    );
  }

  it('[US4-AC13] user.deactivated guarda after.sessionsClosed con las sesiones cerradas', async () => {
    const admin = await registerAdmin();
    const luis = await createUser(admin, 'Luis Mora', 'luis.mora@taller.ec');
    await login(luis.email, 'TempPassword123');
    await login(luis.email, 'TempPassword123');

    await firstValueFrom(
      http.post<UserAccount>(`${USERS_URL}/${luis.id}/deactivate`, {}, { headers: bearer(admin.accessToken) }),
    );

    const history = await historyOf(admin, luis.id);
    expect(history.items).toHaveLength(1);
    expect(history.items[0].action).toBe('user.deactivated');
    expect(history.items[0].before).toEqual({ status: 'active' });
    expect(history.items[0].after).toEqual({ status: 'inactive', sessionsClosed: 2 });
  });

  it('[US4-AC24] user.password_reset guarda before/after con mustChangePassword, vencimiento y sessionsClosed', async () => {
    const admin = await registerAdmin();
    const luis = await createUser(admin, 'Luis Mora', 'luis.mora@taller.ec');
    // Luis cambia la temporal: queda con mustChangePassword false y una sesión viva; luego abre otra.
    const first = await login(luis.email, 'TempPassword123');
    await firstValueFrom(
      http.post<SessionResponseFixture>(
        '/api/v1/auth/password',
        { currentPassword: 'TempPassword123', newPassword: 'ClaveDeLuis2026' },
        { headers: bearer(first.accessToken) },
      ),
    );
    await login(luis.email, 'ClaveDeLuis2026');

    const reset = await firstValueFrom(
      http.post<UserAccount>(
        `${USERS_URL}/${luis.id}/password-reset`,
        { temporaryPassword: 'OtraTemporal789' },
        { headers: bearer(admin.accessToken) },
      ),
    );

    const history = await historyOf(admin, luis.id);
    expect(history.items).toHaveLength(1);
    const entry = history.items[0];
    expect(entry.action).toBe('user.password_reset');
    expect(entry.before).toEqual({ mustChangePassword: false });
    expect(entry.after).toEqual({
      mustChangePassword: true,
      temporaryPasswordExpiresAt: reset.temporaryPasswordExpiresAt,
      sessionsClosed: 2,
    });
    expect(JSON.stringify(entry)).not.toContain('OtraTemporal789');
    expect(JSON.stringify(entry)).not.toContain('ClaveDeLuis2026');
  });

  it('[US4-AC4] PUT /users/{id inexistente}/role con rol inválido da 400 antes que 404', async () => {
    const admin = await registerAdmin();

    const problem = await failure(
      firstValueFrom(
        http.put(`${USERS_URL}/${MISSING_ID}/role`, { role: 'tecnico' }, { headers: bearer(admin.accessToken) }),
      ),
    );

    expect(problem.status).toBe(400);
    expect(problem.code).toBe('VALIDATION_ERROR');
  });

  it('[US4-AC19] PUT /users/{id inexistente}/role con un campo desconocido da 400 UNKNOWN_FIELD antes que 404', async () => {
    const admin = await registerAdmin();

    const problem = await failure(
      firstValueFrom(
        http.put(
          `${USERS_URL}/${MISSING_ID}/role`,
          { role: 'admin', tenantId: MISSING_ID },
          { headers: bearer(admin.accessToken) },
        ),
      ),
    );

    expect(problem.status).toBe(400);
    expect(problem.errors).toContainEqual(expect.objectContaining({ field: 'tenantId', code: 'UNKNOWN_FIELD' }));
  });

  it('[US4-AC21] POST /users/{id inexistente}/password-reset con temporal corta da 400 antes que 404', async () => {
    const admin = await registerAdmin();

    const problem = await failure(
      firstValueFrom(
        http.post(
          `${USERS_URL}/${MISSING_ID}/password-reset`,
          { temporaryPassword: '123' },
          { headers: bearer(admin.accessToken) },
        ),
      ),
    );

    expect(problem.status).toBe(400);
    expect(problem.code).toBe('VALIDATION_ERROR');
  });

  it('[US4-AC23] password-reset de la propia cuenta con body inválido da 400 antes que 409', async () => {
    const admin = await registerAdmin();

    const problem = await failure(
      firstValueFrom(
        http.post(`${USERS_URL}/${admin.user.id}/password-reset`, {}, { headers: bearer(admin.accessToken) }),
      ),
    );

    expect(problem.status).toBe(400);
    expect(problem.code).toBe('VALIDATION_ERROR');
  });

  it('[US4-AC4] el rol inválido se marca en el campo role con el código del backend (VALIDATION_ERROR)', async () => {
    const admin = await registerAdmin();

    const created = await failure(
      firstValueFrom(
        http.post(
          USERS_URL,
          { name: 'Carlos', email: 'carlos.rol@taller.ec', role: 'tecnico', temporaryPassword: 'TempPassword123' },
          { headers: bearer(admin.accessToken) },
        ),
      ),
    );
    const changed = await failure(
      firstValueFrom(
        http.put(`${USERS_URL}/${admin.user.id}/role`, { role: 'tecnico' }, { headers: bearer(admin.accessToken) }),
      ),
    );

    for (const problem of [created, changed]) {
      expect(problem.status).toBe(400);
      expect(problem.errors?.filter((e) => e.field === 'role')).toEqual([
        expect.objectContaining({ field: 'role', code: 'VALIDATION_ERROR' }),
      ]);
    }
  });

  it('[US4-AC1] el listado sale ordenado por estado (activas primero) y luego por nombre', async () => {
    const admin = await registerAdmin(); // "Ana Pérez", activa
    await createUser(admin, 'Zoe Activa', 'zoe@taller.ec');
    const beto = await createUser(admin, 'Beto Inactivo', 'beto@taller.ec');
    await createUser(admin, 'Carla Activa', 'carla@taller.ec');
    const alba = await createUser(admin, 'Alba Inactiva', 'alba@taller.ec');
    for (const user of [beto, alba]) {
      await firstValueFrom(http.post(`${USERS_URL}/${user.id}/deactivate`, {}, { headers: bearer(admin.accessToken) }));
    }

    const list = await firstValueFrom(http.get<UserListResponse>(USERS_URL, { headers: bearer(admin.accessToken) }));

    expect(list.items.map((u) => `${u.status}:${u.name}`)).toEqual([
      'active:Ana Pérez',
      'active:Carla Activa',
      'active:Zoe Activa',
      'inactive:Alba Inactiva',
      'inactive:Beto Inactivo',
    ]);
  });
});
