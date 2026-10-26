// T015 (specs/003-soporte-plataforma): SupportSessionValidator, la compuerta de sesión del panel
// (research R4). Entrega en rojo: el validador llega en T016.
// Ejecuta la sentencia de R4 dentro de la transacción del request del panel (sin taller fijado),
// por lo que nunca usa set_config('app.tenant_id', ...). El manager es un falso que imita TypeORM
// sobre pg:
//   - `UPDATE ... RETURNING` resuelve a [rows, affectedCount] (PostgresQueryRunner.query);
//   - cualquier otra sentencia (el SELECT de diagnóstico) resuelve a filas.
// Contrato del diagnóstico asumido por estas pruebas (calculado en SQL, con el reloj de PostgreSQL):
//   cero o una fila con `revoked_at` (Date | null), `account_status` ('active' | 'inactive') e
//   `inactive` (boolean: last_activity_at <= now() - interval '30 minutes').
// Las sentencias reales contra PostgreSQL se cubren en las e2e de T025.
import { randomUUID } from 'node:crypto';
import { HttpException, type ArgumentsHost } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { ProblemDetailsFilter } from '../common/problem-details.filter.js';
import type { SupportAgent } from './support-agent.js';
import { SupportSessionValidator } from './support-session-validator.js';

interface DiagnosticRow {
  revoked_at: Date | null;
  account_status: 'active' | 'inactive';
  inactive: boolean;
}

interface UpdatedRow {
  name: string;
  email: string;
  must_change_password: boolean;
  temp_password_expires_at: Date | null;
  temp_password_expired: boolean;
}

interface FakeManager {
  calls: { sql: string; params: unknown[] }[];
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

function fakeManager(
  updated: UpdatedRow[],
  diagnostic: DiagnosticRow[] = [],
): FakeManager {
  const manager: FakeManager = {
    calls: [],
    query: async (sql: string, params: unknown[] = []) => {
      manager.calls.push({ sql, params });
      if (/^\s*update\b/i.test(sql))
        return [updated.map((row) => ({ ...row })), updated.length];
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
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({}),
    }),
  } as unknown as ArgumentsHost;
  new ProblemDetailsFilter().catch(exception, host);
  const body = JSON.parse(sent) as { status: number; code: string };
  return { status: body.status, code: body.code };
}

describe('SupportSessionValidator (T015, research R4)', () => {
  let validator: SupportSessionValidator;
  let agent: SupportAgent;

  async function check(manager: FakeManager): Promise<unknown> {
    return validator.validate(manager as unknown as EntityManager, agent);
  }

  async function failure(
    manager: FakeManager,
  ): Promise<{ status: number; code: string }> {
    const error: unknown = await check(manager).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HttpException);
    return problemOf(error);
  }

  beforeEach(() => {
    validator = new SupportSessionValidator();
    agent = {
      id: randomUUID(),
      sessionId: randomUUID(),
      name: 'Nombre del token',
      mustChangePassword: false,
    };
  });

  describe('sesión de soporte vigente', () => {
    const row: UpdatedRow = {
      name: 'Pedro Soporte',
      email: 'pedro@motorsync.ec',
      must_change_password: false,
      temp_password_expires_at: null,
      temp_password_expired: false,
    };

    it('[R4] ejecuta el UPDATE sobre support_sessions/support_accounts con [sessionId, agentId] y sin set_config', async () => {
      const manager = fakeManager([row]);

      await check(manager);

      expect(manager.calls).toHaveLength(1);
      const { sql, params } = manager.calls[0];
      expect(sql).toMatch(/^\s*UPDATE\s+support_sessions\b/i);
      expect(sql).toMatch(/SET\s+last_activity_at\s*=\s*now\(\)/i);
      expect(sql).toMatch(/\bFROM\s+support_accounts\b/i);
      expect(sql).toMatch(/revoked_at\s+IS\s+NULL/i);
      expect(sql).toMatch(/status\s*=\s*'active'/i);
      expect(sql).toMatch(
        /last_activity_at\s*>\s*now\(\)\s*-\s*interval\s*'30 minutes'/i,
      );
      expect(sql).toMatch(
        /RETURNING[\s\S]*\bname\b[\s\S]*\bemail\b[\s\S]*must_change_password[\s\S]*temp_password_expires_at/i,
      );
      expect(params).toEqual([agent.sessionId, agent.id]);
      expect(sql).not.toContain(agent.sessionId);
      expect(sql).not.toContain(agent.id);
      expect(sql).not.toMatch(/set_config/i);
      expect(sql).not.toMatch(/app\.tenant_id/i);
    });

    it('[R4] con fila devuelta retorna name, email, mustChangePassword y temporaryPasswordExpiresAt', async () => {
      const expiresAt = new Date(Date.now() + 72 * 3_600_000);
      const temporary: UpdatedRow = {
        ...row,
        must_change_password: true,
        temp_password_expires_at: expiresAt,
      };

      await expect(check(fakeManager([temporary]))).resolves.toEqual({
        name: 'Pedro Soporte',
        email: 'pedro@motorsync.ec',
        mustChangePassword: true,
        temporaryPasswordExpiresAt: expiresAt,
      });
    });
  });

  describe('sesión de soporte no vigente: consulta de diagnóstico', () => {
    it('[R4] sesión abierta pero con más de 30 min sin actividad → 401 SESSION_EXPIRED', async () => {
      const manager = fakeManager(
        [],
        [{ revoked_at: null, account_status: 'active', inactive: true }],
      );

      await expect(failure(manager)).resolves.toEqual({
        status: 401,
        code: 'SESSION_EXPIRED',
      });

      expect(manager.calls).toHaveLength(2);
      const diagnostic = manager.calls[1];
      expect(diagnostic.sql).toMatch(/^\s*SELECT\b/i);
      expect(diagnostic.sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
      expect(diagnostic.sql).toMatch(/\bsupport_sessions\b/i);
      expect(diagnostic.sql).toMatch(/\bsupport_accounts\b/i);
      expect(diagnostic.params).toEqual(
        expect.arrayContaining([agent.sessionId, agent.id]),
      );
    });

    it('[US2-AC10] sesión revocada (revoked_at no nulo) → 401 SESSION_REVOKED', async () => {
      const manager = fakeManager(
        [],
        [{ revoked_at: new Date(), account_status: 'active', inactive: false }],
      );

      await expect(failure(manager)).resolves.toEqual({
        status: 401,
        code: 'SESSION_REVOKED',
      });
    });

    it('[US2-AC10] cuenta de soporte inactive → 401 SESSION_REVOKED', async () => {
      const manager = fakeManager(
        [],
        [{ revoked_at: null, account_status: 'inactive', inactive: false }],
      );

      await expect(failure(manager)).resolves.toEqual({
        status: 401,
        code: 'SESSION_REVOKED',
      });
    });

    it('[US2-AC10] sin fila de diagnóstico (la sesión o la cuenta no existe) → 401 SESSION_REVOKED', async () => {
      await expect(failure(fakeManager([], []))).resolves.toEqual({
        status: 401,
        code: 'SESSION_REVOKED',
      });
    });
  });

  describe('contraseña temporal vencida (FR-009)', () => {
    it('[FR-009] must_change_password = true y la temporal venció → 401 TEMPORARY_PASSWORD_EXPIRED', async () => {
      const expired: UpdatedRow = {
        name: 'Pedro Soporte',
        email: 'pedro@motorsync.ec',
        must_change_password: true,
        temp_password_expires_at: new Date(Date.now() - 3_600_000),
        temp_password_expired: true,
      };

      await expect(failure(fakeManager([expired]))).resolves.toEqual({
        status: 401,
        code: 'TEMPORARY_PASSWORD_EXPIRED',
      });
    });
  });
});
