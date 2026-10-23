// T014 (specs/002-autenticacion): SessionValidator, the per-request session check (research R6).
// It runs inside the request transaction, after set_config('app.tenant_id'), so every statement
// is under RLS. The manager is a fake that mimics TypeORM over pg:
//   - `UPDATE ... RETURNING` resolves to [rows, affectedCount] (PostgresQueryRunner.query);
//   - any other statement (the diagnostic SELECT) resolves to rows.
// Diagnostic contract assumed by these tests (computed in SQL, so the clock is PostgreSQL's):
//   zero or one row with `revoked_at` (Date | null), `user_status` ('active' | 'inactive') and
//   `inactive` (boolean: last_activity_at <= now() - interval '30 minutes').
// The real statements against PostgreSQL are covered by the e2e suites (T021, T035).
import { randomUUID } from 'node:crypto';
import { HttpException, type ArgumentsHost } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ProblemDetailsFilter } from '../common/problem-details.filter.js';
import type { AuthUser } from './auth-user.js';
import { SessionValidator } from './session-validator.js';

interface DiagnosticRow {
  revoked_at: Date | null;
  user_status: 'active' | 'inactive';
  inactive: boolean;
}

interface UpdatedRow {
  role: string;
  name: string;
  must_change_password: boolean;
  temp_password_expires_at: Date | null;
}

interface FakeManager {
  calls: { sql: string; params: unknown[] }[];
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

function fakeManager(updated: UpdatedRow[], diagnostic: DiagnosticRow[] = []): FakeManager {
  const manager: FakeManager = {
    calls: [],
    query: async (sql: string, params: unknown[] = []) => {
      manager.calls.push({ sql, params });
      if (/^\s*update\b/i.test(sql)) return [updated.map((row) => ({ ...row })), updated.length];
      return diagnostic.map((row) => ({ ...row }));
    },
  };
  return manager;
}

function problemOf(exception: unknown): { status: number; code: string } {
  let sent = '';
  const response = {
    status: () => response,
    setHeader: () => response,
    send: (body: string) => {
      sent = body;
      return response;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(exception, host);
  const body = JSON.parse(sent) as { status: number; code: string };
  return { status: body.status, code: body.code };
}

describe('SessionValidator (T014, research R6)', () => {
  let validator: SessionValidator;
  let user: AuthUser;

  async function check(manager: FakeManager): Promise<unknown> {
    return validator.validate(manager as unknown as EntityManager, user);
  }

  async function failure(manager: FakeManager): Promise<{ status: number; code: string }> {
    const error: unknown = await check(manager).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HttpException);
    return problemOf(error);
  }

  beforeEach(() => {
    validator = new SessionValidator();
    user = {
      userId: randomUUID(),
      tenantId: randomUUID(),
      role: 'admin',
      name: 'Nombre del token',
      sessionId: randomUUID(),
      mustChangePassword: false,
    };
  });

  describe('sesión vigente', () => {
    const row: UpdatedRow = {
      role: 'asesor',
      name: 'Luis Ortega',
      must_change_password: false,
      temp_password_expires_at: null,
    };

    it('[R6][FR-012] ejecuta una sola sentencia: el UPDATE de last_activity_at con RETURNING', async () => {
      const manager = fakeManager([row]);

      await check(manager);

      expect(manager.calls).toHaveLength(1);
      const { sql } = manager.calls[0];
      expect(sql).toMatch(/^\s*UPDATE\s+user_sessions\b/i);
      expect(sql).toMatch(/SET\s+last_activity_at\s*=\s*now\(\)/i);
      expect(sql).toMatch(/\bFROM\s+users\b/i);
      expect(sql).toMatch(/revoked_at\s+IS\s+NULL/i);
      expect(sql).toMatch(/status\s*=\s*'active'/i);
      expect(sql).toMatch(/last_activity_at\s*>\s*now\(\)\s*-\s*interval\s*'30 minutes'/i);
      expect(sql).toMatch(/RETURNING[\s\S]*\brole\b[\s\S]*\bname\b[\s\S]*must_change_password[\s\S]*temp_password_expires_at/i);
    });

    it('[R6][Principio I] el sid y el sub van como parámetros, nunca dentro del SQL', async () => {
      const manager = fakeManager([row]);

      await check(manager);

      const { sql, params } = manager.calls[0];
      expect(params).toEqual(expect.arrayContaining([user.sessionId, user.userId]));
      expect(sql).not.toContain(user.sessionId as string);
      expect(sql).not.toContain(user.userId);
      expect(sql).not.toContain(user.tenantId);
    });

    it('[FR-014][US4-AC5] devuelve el rol, el nombre y el estado de la contraseña leídos de la base', async () => {
      await expect(check(fakeManager([row]))).resolves.toEqual({
        role: 'asesor',
        name: 'Luis Ortega',
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
      });
    });

    it('[FR-026][R7] devuelve mustChangePassword y la fecha de vencimiento de la temporal', async () => {
      const expiresAt = new Date(Date.now() + 72 * 3_600_000);
      const temporary: UpdatedRow = {
        role: 'asesor',
        name: 'Luis Ortega',
        must_change_password: true,
        temp_password_expires_at: expiresAt,
      };

      await expect(check(fakeManager([temporary]))).resolves.toEqual({
        role: 'asesor',
        name: 'Luis Ortega',
        mustChangePassword: true,
        temporaryPasswordExpiresAt: expiresAt,
      });
    });
  });

  describe('sesión no vigente: consulta de diagnóstico', () => {
    it('[FR-012][US3-AC1] sesión abierta pero con más de 30 min sin actividad → 401 SESSION_EXPIRED', async () => {
      const manager = fakeManager([], [{ revoked_at: null, user_status: 'active', inactive: true }]);

      await expect(failure(manager)).resolves.toEqual({ status: 401, code: 'SESSION_EXPIRED' });
    });

    it('[FR-013][US3-AC4] sesión revocada (cierre de sesión, cambio o restablecimiento) → 401 SESSION_REVOKED', async () => {
      const manager = fakeManager(
        [],
        [{ revoked_at: new Date(), user_status: 'active', inactive: false }],
      );

      await expect(failure(manager)).resolves.toEqual({ status: 401, code: 'SESSION_REVOKED' });
    });

    it('[FR-013] revocada y además inactiva → 401 SESSION_REVOKED (la revocación manda)', async () => {
      const manager = fakeManager(
        [],
        [{ revoked_at: new Date(Date.now() - 3_600_000), user_status: 'active', inactive: true }],
      );

      await expect(failure(manager)).resolves.toEqual({ status: 401, code: 'SESSION_REVOKED' });
    });

    it('[FR-013][US4-AC6] cuenta desactivada → 401 SESSION_REVOKED, aunque la sesión siga abierta', async () => {
      const manager = fakeManager(
        [],
        [{ revoked_at: null, user_status: 'inactive', inactive: false }],
      );

      await expect(failure(manager)).resolves.toEqual({ status: 401, code: 'SESSION_REVOKED' });
    });

    it('[FR-013] cuenta desactivada y sesión inactiva → 401 SESSION_REVOKED', async () => {
      const manager = fakeManager([], [{ revoked_at: null, user_status: 'inactive', inactive: true }]);

      await expect(failure(manager)).resolves.toEqual({ status: 401, code: 'SESSION_REVOKED' });
    });

    it('[FR-013][FR-022] sesión inexistente, de otra cuenta o de otro taller (0 filas bajo RLS) → 401 SESSION_REVOKED', async () => {
      await expect(failure(fakeManager([], []))).resolves.toEqual({
        status: 401,
        code: 'SESSION_REVOKED',
      });
    });

    it('[R6] la consulta de diagnóstico es un SELECT parametrizado por sid y sub que no modifica nada', async () => {
      const manager = fakeManager([], [{ revoked_at: null, user_status: 'active', inactive: true }]);

      await failure(manager);

      expect(manager.calls).toHaveLength(2);
      const diagnostic = manager.calls[1];
      expect(diagnostic.sql).toMatch(/^\s*SELECT\b/i);
      expect(diagnostic.sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
      expect(diagnostic.sql).toMatch(/\buser_sessions\b/i);
      expect(diagnostic.params).toEqual(expect.arrayContaining([user.sessionId, user.userId]));
      expect(diagnostic.sql).not.toContain(user.sessionId as string);
    });
  });
});
