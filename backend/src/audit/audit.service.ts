import { Injectable } from '@nestjs/common';
import { normalizeReason } from '../common/reason-policy.js';
import { getTenantContext } from '../database/tenant-context.js';
import type { AuditAction, AuditEntityType, AuditSnapshot } from './audit-log.entity.js';

/** What the caller knows about the audited change; actor, ip and channel come from the context. */
export interface AuditEntry {
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  before: AuditSnapshot | null;
  after: AuditSnapshot | null;
  reason?: string | null;
}

/** Raw row of INSERT_SQL ... RETURNING (pg parses uuid as string and timestamptz as Date). */
export interface AuditRecord {
  id: string;
  occurredAt: Date;
}

// tenant_id is left to its DEFAULT app_current_tenant(): the tenant pinned in the transaction.
const INSERT_SQL = `
  INSERT INTO audit_log
    (actor_user_id, actor_name, actor_role, action, entity_type, entity_id,
     before, after, reason, ip, channel)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
  RETURNING id, occurred_at AS "occurredAt"`;

const CHANNEL = 'web';

/**
 * Writes audit_log records (principle IV) with the manager of the request transaction, so the
 * record commits or rolls back together with the audited change.
 */
@Injectable()
export class AuditService {
  async record(entry: AuditEntry): Promise<AuditRecord> {
    const { manager, user, ip } = getTenantContext();
    const rows: AuditRecord[] = await manager.query(INSERT_SQL, [
      user.userId,
      user.name,
      user.role,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.before === null ? null : JSON.stringify(entry.before),
      entry.after === null ? null : JSON.stringify(entry.after),
      // Stored trimmed: the CHECK measures length(reason) on the stored value.
      normalizeReason(entry.reason),
      ip,
      CHANNEL,
    ]);
    return rows[0];
  }
}
