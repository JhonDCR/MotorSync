// T046 (specs/003-soporte-plataforma): unit tests for the shared temporary password core (US3-AC1, US3-AC13, R9).
// Tests that applyTemporaryPassword executes session revocation, user update, and failure cleanup in exact order,
// returns closed sessions, previous must_change_password and expiry, and never modifies user role or status.
import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { applyTemporaryPassword } from './apply-temporary-password.js';

describe('applyTemporaryPassword (T046, US3-AC1, US3-AC13, R9)', () => {
  const targetUserId = '11111111-1111-4111-8111-111111111111';
  const passwordHash = 'scrypt$32768$8$1$fakesalt$fakehash';
  const updatedBy = '22222222-2222-4222-8222-222222222222';
  const updatedByName = 'Soporte MotorSync (Agente)';
  const mockExpiresAt = new Date('2026-10-28T18:00:00.000Z');

  function createMockManager(sessionsCount = 2) {
    const queryOrder: string[] = [];
    const queryMock = vi.fn().mockImplementation((sql: string) => {
      if (/UPDATE\s+user_sessions/i.test(sql)) {
        queryOrder.push('revoke_sessions');
        const rows = Array.from({ length: sessionsCount }, (_, i) => ({
          id: `session-${i + 1}`,
        }));
        return Promise.resolve([rows, sessionsCount]);
      }
      if (/UPDATE\s+users/i.test(sql)) {
        queryOrder.push('update_users');
        return Promise.resolve([
          [
            {
              id: targetUserId,
              name: 'Usuario Prueba',
              email: 'usuario@taller.ec',
              role: 'asesor',
              status: 'active',
              mustChangePassword: true,
              temporaryPasswordExpiresAt: mockExpiresAt,
              temp_password_expires_at: mockExpiresAt,
              updatedAt: new Date(),
              updatedByName,
            },
          ],
          1,
        ]);
      }
      if (/SELECT\s+auth_clear_login_failures/i.test(sql)) {
        queryOrder.push('clear_failures');
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const manager = {
      query: queryMock,
    } as unknown as EntityManager;

    return { manager, queryMock, queryOrder };
  }

  it('[US3-AC1][T046] ejecuta en orden exacto: 1. revocar sesiones, 2. UPDATE users, 3. auth_clear_login_failures', async () => {
    const { manager, queryMock, queryOrder } = createMockManager(2);

    await applyTemporaryPassword({
      manager,
      targetUserId,
      passwordHash,
      updatedBy,
      updatedByName,
      previousMustChangePassword: false,
    });

    expect(queryOrder).toEqual([
      'revoke_sessions',
      'update_users',
      'clear_failures',
    ]);
    expect(queryMock).toHaveBeenCalledTimes(3);

    // 1. Revocación de sesiones con password_reset y RETURNING id
    const [sql1, params1] = queryMock.mock.calls[0];
    expect(sql1).toMatch(/UPDATE\s+user_sessions/i);
    expect(sql1).toMatch(/SET\s+revoked_at\s*=\s*now\(\)/i);
    expect(sql1).toMatch(/revoke_reason\s*=\s*\$2/i);
    expect(sql1).toMatch(/WHERE\s+user_id\s*=\s*\$1\s+AND\s+revoked_at\s+IS\s+NULL/i);
    expect(sql1).toMatch(/RETURNING\s+id/i);
    expect(params1).toEqual([targetUserId, 'password_reset']);

    // 2. UPDATE users fijando hash, must_change_password, vencimiento a 72h, updated_by y updated_by_name
    const [sql2, params2] = queryMock.mock.calls[1];
    expect(sql2).toMatch(/UPDATE\s+users/i);
    expect(sql2).toMatch(/password_hash\s*=\s*\$2/i);
    expect(sql2).toMatch(/must_change_password\s*=\s*true/i);
    expect(sql2).toMatch(/temp_password_expires_at\s*=\s*now\(\)\s*\+\s*interval\s+'72\s*hours'/i);
    expect(sql2).toMatch(/updated_at\s*=\s*now\(\)/i);
    expect(sql2).toMatch(/updated_by\s*=\s*\$3/i);
    expect(sql2).toMatch(/updated_by_name\s*=\s*\$4/i);
    expect(sql2).toMatch(/WHERE\s+id\s*=\s*\$1/i);
    expect(params2).toEqual([targetUserId, passwordHash, updatedBy, updatedByName]);

    // 3. auth_clear_login_failures
    const [sql3, params3] = queryMock.mock.calls[2];
    expect(sql3).toMatch(/SELECT\s+auth_clear_login_failures\(\$1\)/i);
    expect(params3).toEqual([targetUserId]);
  });

  it('[US3-AC1][T046] devuelve sessionsClosed, previousMustChangePassword y temporaryPasswordExpiresAt', async () => {
    const { manager } = createMockManager(3);

    const result = await applyTemporaryPassword({
      manager,
      targetUserId,
      passwordHash,
      updatedBy,
      updatedByName,
      previousMustChangePassword: true,
    });

    expect(result).toMatchObject({
      sessionsClosed: 3,
      previousMustChangePassword: true,
    });
    expect(result.temporaryPasswordExpiresAt).toBeDefined();
    expect(new Date(result.temporaryPasswordExpiresAt).toISOString()).toBe(
      mockExpiresAt.toISOString(),
    );
  });

  it('[US3-AC1][T046] devuelve sessionsClosed = 0 cuando el usuario no tenía sesiones abiertas', async () => {
    const { manager } = createMockManager(0);

    const result = await applyTemporaryPassword({
      manager,
      targetUserId,
      passwordHash,
      updatedBy,
      updatedByName,
      previousMustChangePassword: false,
    });

    expect(result.sessionsClosed).toBe(0);
    expect(result.previousMustChangePassword).toBe(false);
  });

  it('[US3-AC13][T046] nunca modifica role ni status de la cuenta objetivo', async () => {
    const { manager, queryMock } = createMockManager(1);

    await applyTemporaryPassword({
      manager,
      targetUserId,
      passwordHash,
      updatedBy,
      updatedByName,
      previousMustChangePassword: false,
    });

    // Inspect the UPDATE users statement
    const [updateSql] = queryMock.mock.calls[1];
    expect(updateSql).not.toMatch(/\brole\s*=/i);
    expect(updateSql).not.toMatch(/\bstatus\s*=/i);
  });
});
