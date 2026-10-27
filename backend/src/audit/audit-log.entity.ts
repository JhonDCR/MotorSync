import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { AuthRole } from '../auth/auth-user.js';

/** Values of audit_log.action in this feature (data-model.md, "Valores enumerados"). */
export const AUDIT_ACTIONS = [
  'vehicle.owner_changed',
  'vehicle.plate_changed',
  'vehicle.vin_changed',
  'client.document_changed',
  'user.role_changed',
  'user.deactivated',
  'user.reactivated',
  'user.password_reset',
  'user.password_reset_by_support',
  'budget.approved',
  'budget.rejected',
  'work_order.status_changed',
  'work_order.cancelled',
  'work_order.assignee_changed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditActorRole = AuthRole | 'platform_support';

export type AuditEntityType = 'client' | 'vehicle' | 'user' | 'budget' | 'work_order';

/** JSON object stored in before and after (camelCase keys, data-model.md). */
export type AuditSnapshot = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Table `audit_log` (data-model.md), append-only (principle IV). The schema is owned by the
 * migrations, never synchronized; rows are only inserted through AuditService.
 */
@Entity({ name: 'audit_log' })
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** DEFAULT app_current_tenant(): the tenant pinned in the request transaction. */
  @Column({ type: 'uuid', name: 'tenant_id', default: () => 'app_current_tenant()' })
  tenantId: string;

  @Column({ type: 'uuid', name: 'actor_user_id' })
  actorUserId: string;

  @Column({ type: 'text', name: 'actor_name' })
  actorName: string;

  @Column({ type: 'text', name: 'actor_role' })
  actorRole: AuditActorRole;

  @Column({ type: 'text', name: 'action' })
  action: AuditAction;

  @Column({ type: 'text', name: 'entity_type' })
  entityType: AuditEntityType;

  @Column({ type: 'uuid', name: 'entity_id' })
  entityId: string;

  @Column({ type: 'jsonb', name: 'before', nullable: true })
  before: AuditSnapshot | null;

  @Column({ type: 'jsonb', name: 'after', nullable: true })
  after: AuditSnapshot | null;

  @Column({ type: 'text', name: 'reason', nullable: true })
  reason: string | null;

  @Column({ type: 'timestamptz', name: 'occurred_at', default: () => 'now()' })
  occurredAt: Date;

  @Column({ type: 'text', name: 'ip', nullable: true })
  ip: string | null;

  @Column({ type: 'text', name: 'channel', default: 'web' })
  channel: string;
}
