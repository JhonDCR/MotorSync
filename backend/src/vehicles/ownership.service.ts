import { Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import type { AuthRole } from '../auth/auth-user.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { checkReason } from '../common/reason-policy.js';
import { getManager, getTenantContext } from '../database/tenant-context.js';
import type { OwnershipTransferDto } from './dto/ownership-transfer.dto.js';
import {
  versionConflict,
  VehiclesService,
  type UpdateResultRaw,
  type VehicleDetail,
} from './vehicles.service.js';

/** Contract `OwnerSnapshot`. */
export interface OwnerSnapshot {
  clientId: string;
  displayName: string;
  documentNumber: string;
}

/** Contract `OwnershipChange`. */
export interface OwnershipChange {
  id: string;
  occurredAt: string;
  previousOwner: OwnerSnapshot;
  newOwner: OwnerSnapshot;
  actorUserId: string;
  actorName: string;
  actorRole: AuthRole;
  reason: string | null;
}

/** Response of GET /vehicles/{id}/ownership-history. */
export interface OwnershipHistoryResponse {
  items: OwnershipChange[];
}

/** before and after of vehicle.owner_changed in audit_log (camelCase, data-model.md). */
interface OwnerChangeSnapshot {
  ownerClientId: string;
  ownerDisplayName: string;
  ownerDocumentNumber: string;
}

/** Raw row of TARGET_OWNER_SQL (pg parses uuid and text as string). */
interface OwnerRow {
  id: string;
  displayName: string;
  documentNumber: string;
}

/**
 * Raw row of HISTORY_SQL: pg parses uuid and text as string, timestamptz as Date and jsonb as
 * the stored object, which AuditService wrote as an OwnerChangeSnapshot for this action.
 * actor_role is restricted by a CHECK constraint to the AuthRole values.
 */
interface HistoryRow {
  id: string;
  occurredAt: Date;
  before: OwnerChangeSnapshot;
  after: OwnerChangeSnapshot;
  actorUserId: string;
  actorName: string;
  actorRole: AuthRole;
  reason: string | null;
}

/** Raw row of VEHICLE_EXISTS_SQL. */
interface IdRow {
  id: string;
}

const OWNER_CHANGED = 'vehicle.owner_changed';

/** The destination client must be visible in the tenant (explicit filter + RLS). */
const TARGET_OWNER_SQL = `
SELECT c.id, c.display_name AS "displayName", c.document_number AS "documentNumber"
FROM clients c
WHERE c.tenant_id = app_current_tenant()
  AND c.id = $1`;

const TRANSFER_SQL = `
UPDATE vehicles
   SET owner_client_id = $3,
       version = version + 1, updated_at = now(), updated_by = $4, updated_by_name = $5
 WHERE tenant_id = app_current_tenant()
   AND id = $1
   AND version = $2
RETURNING id`;

const VEHICLE_EXISTS_SQL =
  'SELECT id FROM vehicles WHERE tenant_id = app_current_tenant() AND id = $1';

/** Uses audit_log_entity_idx (tenant_id, entity_type, entity_id, occurred_at DESC). */
const HISTORY_SQL = `
SELECT a.id, a.occurred_at AS "occurredAt", a.before, a.after,
       a.actor_user_id AS "actorUserId", a.actor_name AS "actorName",
       a.actor_role AS "actorRole", a.reason
FROM audit_log a
WHERE a.tenant_id = app_current_tenant()
  AND a.entity_type = 'vehicle'
  AND a.entity_id = $1
  AND a.action = '${OWNER_CHANGED}'
ORDER BY a.occurred_at DESC, a.id DESC`;

function notFound(): ProblemException {
  return new ProblemException(404, 'NOT_FOUND');
}

function toOwnerSnapshot(snapshot: OwnerChangeSnapshot): OwnerSnapshot {
  return {
    clientId: snapshot.ownerClientId,
    displayName: snapshot.ownerDisplayName,
    documentNumber: snapshot.ownerDocumentNumber,
  };
}

function toChange(row: HistoryRow): OwnershipChange {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    previousOwner: toOwnerSnapshot(row.before),
    newOwner: toOwnerSnapshot(row.after),
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    actorRole: row.actorRole,
    reason: row.reason ?? null,
  };
}

/**
 * Ownership transfers (US4-AC7 to AC10, AC13 to AC16). The owner change and its audit record
 * share the request transaction (principle IV): if the record fails, nothing changes.
 */
@Injectable()
export class OwnershipService {
  constructor(
    @Inject(VehiclesService) private readonly vehicles: VehiclesService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * POST /vehicles/{id}/ownership-transfers. Order: vehicle (404 NOT_FOUND), destination
   * (404 CLIENT_NOT_FOUND), version (409), SAME_OWNER (422), reason (400), then the UPDATE and
   * vehicle.owner_changed.
   */
  async transfer(vehicleId: string, dto: OwnershipTransferDto): Promise<VehicleDetail> {
    const current = await this.vehicles.getById(vehicleId);
    const { manager, user } = getTenantContext();

    const targets = await manager.query<OwnerRow[]>(TARGET_OWNER_SQL, [dto.newOwnerClientId]);
    const target = targets[0];
    if (!target) throw new ProblemException(404, 'CLIENT_NOT_FOUND');

    if (current.version !== dto.version) throw versionConflict(current);
    if (current.owner.id === target.id) throw new ProblemException(422, 'SAME_OWNER');

    const reasonError = checkReason(user.role, ['owner'], dto.reason);
    if (reasonError) {
      throw new ProblemException(400, 'VALIDATION_ERROR', { errors: [reasonError] });
    }

    const [, updated] = await manager.query<UpdateResultRaw>(TRANSFER_SQL, [
      vehicleId,
      dto.version,
      target.id,
      user.userId,
      user.name,
    ]);
    // Lost a race after the check above: gone (404) or edited by someone else (409).
    if (updated === 0) throw versionConflict(await this.vehicles.getById(vehicleId));

    await this.audit.record({
      action: OWNER_CHANGED,
      entityType: 'vehicle',
      entityId: vehicleId,
      before: {
        ownerClientId: current.owner.id,
        ownerDisplayName: current.owner.displayName,
        ownerDocumentNumber: current.owner.documentNumber,
      },
      after: {
        ownerClientId: target.id,
        ownerDisplayName: target.displayName,
        ownerDocumentNumber: target.documentNumber,
      },
      reason: dto.reason,
    });
    return this.vehicles.getById(vehicleId);
  }

  /** GET /vehicles/{id}/ownership-history: newest first, read-only, from audit_log (US4-AC10). */
  async history(vehicleId: string): Promise<OwnershipHistoryResponse> {
    if (!isUUID(vehicleId)) throw notFound();
    const manager = getManager();
    const vehicles = await manager.query<IdRow[]>(VEHICLE_EXISTS_SQL, [vehicleId]);
    if (vehicles.length === 0) throw notFound();
    const rows = await manager.query<HistoryRow[]>(HISTORY_SQL, [vehicleId]);
    return { items: rows.map(toChange) };
  }
}
