// T046 (specs/003-soporte-plataforma): unit tests for AuditService.recordAsSupport (US3-AC6, FR-020, R11).
// Verifies that support resets write to audit_log with the provided transaction manager,
// platform_support actor role, agent name (never email), support_panel channel, and null reason.
import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { tenantStorage } from '../database/tenant-context.js';
import type { AuditAction } from './audit-log.entity.js';
import type { AuditEntry, AuditRecord } from './audit.service.js';
import { AuditService } from './audit.service.js';

interface AuditServiceWithSupport extends AuditService {
  recordAsSupport(
    manager: EntityManager,
    agent: { id: string; name: string },
    ip: string | null,
    entry: AuditEntry,
  ): Promise<AuditRecord>;
}

describe('AuditService.recordAsSupport (T046, US3-AC6, FR-020, R11)', () => {
  const service = new AuditService();
  const serviceWithSupport = service as unknown as AuditServiceWithSupport;

  const agent = {
    id: 'aaaa1111-1111-4111-8111-111111111111',
    sessionId: 'bbbb2222-2222-4222-8222-222222222222',
    name: 'Agente Soporte',
    email: 'agente@motorsync.ec',
    mustChangePassword: false,
  };

  const sampleEntry: AuditEntry = {
    action: 'user.password_reset_by_support' as unknown as AuditAction,
    entityType: 'user',
    entityId: 'cccc3333-3333-4333-8333-333333333333',
    before: { mustChangePassword: false },
    after: {
      mustChangePassword: true,
      temporaryPasswordExpiresAt: '2026-10-28T18:00:00.000Z',
      sessionsClosed: 2,
      supportTicketNumber: '1001',
    },
  };

  it('[US3-AC6][FR-020][T046] escribe con el manager recibido, actor_role platform_support, actor_name (nunca correo), channel support_panel y reason null', async () => {
    const mockRecord = { id: 'audit-uuid-1', occurredAt: new Date() };
    const queryMock = vi.fn().mockResolvedValue([mockRecord]);
    const mockManager = { query: queryMock } as unknown as EntityManager;

    const result = await serviceWithSupport.recordAsSupport(
      mockManager,
      agent,
      '203.0.113.50',
      sampleEntry,
    );

    expect(result).toEqual(mockRecord);
    expect(queryMock).toHaveBeenCalledTimes(1);

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT\s+INTO\s+audit_log/i);
    expect(sql).toMatch(/actor_user_id/i);
    expect(sql).toMatch(/actor_name/i);
    expect(sql).toMatch(/actor_role/i);
    expect(sql).toMatch(/channel/i);

    // Param checks
    expect(params[0]).toBe(agent.id);
    expect(params[1]).toBe(agent.name);
    // MUST NOT be email
    expect(params[1]).not.toBe(agent.email);
    expect(JSON.stringify(params)).not.toContain(agent.email);

    expect(params[2]).toBe('platform_support');
    expect(params[3]).toBe(sampleEntry.action);
    expect(params[4]).toBe(sampleEntry.entityType);
    expect(params[5]).toBe(sampleEntry.entityId);
    expect(params[6]).toBe(JSON.stringify(sampleEntry.before));
    expect(params[7]).toBe(JSON.stringify(sampleEntry.after));
    expect(params[8]).toBeNull(); // reason MUST be null for platform_support
    expect(params[9]).toBe('203.0.113.50');
    expect(params[10]).toBe('support_panel');
  });

  it('[US3-AC6][T046] serializa before y after a null cuando son null', async () => {
    const mockRecord = { id: 'audit-uuid-2', occurredAt: new Date() };
    const queryMock = vi.fn().mockResolvedValue([mockRecord]);
    const mockManager = { query: queryMock } as unknown as EntityManager;

    const entryWithoutSnapshots: AuditEntry = {
      action: 'user.password_reset_by_support' as unknown as AuditAction,
      entityType: 'user',
      entityId: 'cccc3333-3333-4333-8333-333333333333',
      before: null,
      after: null,
    };

    await serviceWithSupport.recordAsSupport(
      mockManager,
      agent,
      null,
      entryWithoutSnapshots,
    );

    const [, params] = queryMock.mock.calls[0];
    expect(params[6]).toBeNull();
    expect(params[7]).toBeNull();
    expect(params[8]).toBeNull();
    expect(params[9]).toBeNull();
  });

  it('[US3-AC6][T046] el método record() de la 001 sigue funcionando igual y no cambia', async () => {
    const mockRecord = { id: 'audit-uuid-001', occurredAt: new Date() };
    const queryMock = vi.fn().mockResolvedValue([mockRecord]);
    const mockManager = { query: queryMock } as unknown as EntityManager;

    const tenantUser = {
      userId: 'admin-uuid-1',
      name: 'Admin Taller',
      role: 'admin' as const,
      email: 'admin@taller.ec',
    };

    const entry001: AuditEntry = {
      action: 'user.role_changed',
      entityType: 'user',
      entityId: 'user-uuid-2',
      before: { role: 'asesor' },
      after: { role: 'admin' },
      reason: 'Ascenso a administrador',
    };

    const result = await tenantStorage.run(
      {
        manager: mockManager,
        tenantId: 'tenant-uuid-1',
        user: tenantUser,
        ip: '192.168.1.1',
      },
      () => service.record(entry001),
    );

    expect(result).toEqual(mockRecord);
    expect(queryMock).toHaveBeenCalledTimes(1);

    const [, params] = queryMock.mock.calls[0];
    expect(params[0]).toBe(tenantUser.userId);
    expect(params[1]).toBe(tenantUser.name);
    expect(params[2]).toBe(tenantUser.role);
    expect(params[3]).toBe(entry001.action);
    expect(params[8]).toBe('Ascenso a administrador');
    expect(params[9]).toBe('192.168.1.1');
    expect(params[10]).toBe('web'); // channel from 001 is 'web'
  });
});
