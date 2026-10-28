import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { formatCents, parseMoney } from '../budgets/money.util.js';
import type { DocumentType } from '../clients/client.entity.js';
import type { BodyType } from '../common/identifiers/plate.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { getManager } from '../database/tenant-context.js';
import type {
  TimelineEventDto,
  VehicleClinicalHistoryDto,
  VehicleHeaderDto,
  VehicleMetricsDto,
  VehicleOwnerDto,
} from './dto/vehicle-history.dto.js';

interface VehicleHeaderRow {
  id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
  vin: string | null;
  color: string;
  bodyType: BodyType;
  initialMileage: number;
  ownerId: string;
  ownerDisplayName: string;
  ownerDocumentType: DocumentType;
  ownerDocumentNumber: string;
  ownerPhone: string | null;
}

interface CheckinRow {
  id: string;
  number: number;
  mileage: number;
  fuelLevel: string;
  reason: string;
  inventory: string[];
  createdAt: Date;
  authorName: string;
  damagesCount: number;
  photosCount: number;
}

interface BudgetRow {
  id: string;
  number: number;
  checkinId: string;
  status: string;
  subtotal: string;
  tax: string;
  total: string;
  createdAt: Date;
  linesCount: number;
}

interface WorkOrderRow {
  id: string;
  number: number;
  status: string;
  budgetId: string;
  checkinId: string;
  createdAt: Date;
  assigneeId: string;
  assigneeName: string;
  budgetTotal: string | null;
  itemsCount: number;
  notesCount: number;
  deliveredAt: Date | null;
}

interface OwnerSnapshotRaw {
  ownerClientId?: string;
  ownerDisplayName?: string;
  ownerDocumentNumber?: string;
}

interface TransferRow {
  id: string;
  occurredAt: Date;
  before: OwnerSnapshotRaw | null;
  after: OwnerSnapshotRaw | null;
  actorName: string;
  reason: string | null;
}

const VEHICLE_OWNER_SQL = `
SELECT v.id, v.plate, v.brand, v.model, v.year, v.vin, v.color,
       v.body_type AS "bodyType", v.initial_mileage AS "initialMileage",
       c.id AS "ownerId", c.display_name AS "ownerDisplayName",
       c.document_type AS "ownerDocumentType", c.document_number AS "ownerDocumentNumber",
       c.phone AS "ownerPhone"
FROM vehicles v
JOIN clients c ON c.tenant_id = v.tenant_id AND c.id = v.owner_client_id
WHERE v.tenant_id = app_current_tenant()
  AND v.id = $1`;

const CHECKINS_SQL = `
SELECT ch.id, ch.number, ch.mileage, ch.fuel_level AS "fuelLevel", ch.reason,
       ch.inventory, ch.created_at AS "createdAt",
       u.name AS "authorName",
       (SELECT count(*)::int FROM checkin_damages d
         WHERE d.tenant_id = ch.tenant_id AND d.checkin_id = ch.id) AS "damagesCount",
       (SELECT count(*)::int FROM checkin_images i
         WHERE i.tenant_id = ch.tenant_id AND i.checkin_id = ch.id AND i.kind = 'damage') AS "photosCount"
FROM checkins ch
JOIN users u ON u.tenant_id = ch.tenant_id AND u.id = ch.created_by
WHERE ch.tenant_id = app_current_tenant() AND ch.vehicle_id = $1
ORDER BY ch.created_at DESC, ch.number DESC`;

const BUDGETS_SQL = `
SELECT b.id, b.number, b.checkin_id AS "checkinId", b.status,
       b.subtotal::text AS subtotal, b.tax::text AS tax, b.total::text AS total,
       b.created_at AS "createdAt",
       (SELECT count(*)::int FROM budget_lines bl
         WHERE bl.tenant_id = b.tenant_id AND bl.budget_id = b.id) AS "linesCount"
FROM budgets b
WHERE b.tenant_id = app_current_tenant() AND b.vehicle_id = $1
ORDER BY b.created_at DESC, b.number DESC`;

const WORK_ORDERS_SQL = `
SELECT w.id, w.number, w.status, w.budget_id AS "budgetId", w.checkin_id AS "checkinId",
       w.created_at AS "createdAt", w.assignee_id AS "assigneeId", au.name AS "assigneeName",
       b.total::text AS "budgetTotal",
       (SELECT count(*)::int FROM work_order_items i
         WHERE i.tenant_id = w.tenant_id AND i.work_order_id = w.id) AS "itemsCount",
       (SELECT count(*)::int FROM work_order_notes n
         WHERE n.tenant_id = w.tenant_id AND n.work_order_id = w.id) AS "notesCount",
       (SELECT sc.changed_at FROM work_order_status_changes sc
         WHERE sc.tenant_id = w.tenant_id AND sc.work_order_id = w.id AND sc.status = 'entregada'
         ORDER BY sc.changed_at DESC LIMIT 1) AS "deliveredAt"
FROM work_orders w
JOIN users au ON au.tenant_id = w.tenant_id AND au.id = w.assignee_id
LEFT JOIN budgets b ON b.tenant_id = w.tenant_id AND b.id = w.budget_id
WHERE w.tenant_id = app_current_tenant() AND w.vehicle_id = $1
ORDER BY w.created_at DESC, w.number DESC`;

const TRANSFERS_SQL = `
SELECT a.id, a.occurred_at AS "occurredAt", a.before, a.after,
       a.actor_name AS "actorName", a.reason
FROM audit_log a
WHERE a.tenant_id = app_current_tenant()
  AND a.entity_type = 'vehicle'
  AND a.entity_id = $1
  AND a.action = 'vehicle.owner_changed'
ORDER BY a.occurred_at DESC, a.id DESC`;

function notFound(): ProblemException {
  return new ProblemException(404, 'NOT_FOUND');
}

@Injectable()
export class VehicleHistoryService {
  /**
   * Consolidates clinical history, metrics and chronological timeline for a vehicle (007).
   * Strict RLS isolation: foreign or nonexistent vehicles return 404 (US1-AC4).
   */
  async getClinicalHistory(vehicleId: string): Promise<VehicleClinicalHistoryDto> {
    if (!isUUID(vehicleId)) throw notFound();

    const manager = getManager();
    const vehicleRows = await manager.query<VehicleHeaderRow[]>(VEHICLE_OWNER_SQL, [vehicleId]);
    const vehicleRow = vehicleRows[0];
    if (!vehicleRow) throw notFound();

    const checkinRows = await manager.query<CheckinRow[]>(CHECKINS_SQL, [vehicleId]);
    const budgetRows = await manager.query<BudgetRow[]>(BUDGETS_SQL, [vehicleId]);
    const workOrderRows = await manager.query<WorkOrderRow[]>(WORK_ORDERS_SQL, [vehicleId]);
    const transferRows = await manager.query<TransferRow[]>(TRANSFERS_SQL, [vehicleId]);

    const vehicle: VehicleHeaderDto = {
      id: vehicleRow.id,
      plate: vehicleRow.plate,
      brand: vehicleRow.brand,
      model: vehicleRow.model,
      year: vehicleRow.year,
      color: vehicleRow.color,
      bodyType: vehicleRow.bodyType,
      vin: vehicleRow.vin ?? null,
      initialMileage: vehicleRow.initialMileage,
    };

    const owner: VehicleOwnerDto = {
      id: vehicleRow.ownerId,
      displayName: vehicleRow.ownerDisplayName,
      documentType: vehicleRow.ownerDocumentType,
      documentNumber: vehicleRow.ownerDocumentNumber,
      phone: vehicleRow.ownerPhone ?? null,
    };

    const maxCheckin =
      checkinRows.length > 0 ? Math.max(...checkinRows.map((c) => c.mileage)) : 0;
    const currentMileage = Math.max(vehicle.initialMileage, maxCheckin);
    const mileageDelta = currentMileage - vehicle.initialMileage;

    const deliveredOrders = workOrderRows.filter((wo) => wo.status === 'entregada');
    const totalInvestedCents = deliveredOrders.reduce(
      (sum, wo) => sum + (wo.budgetTotal ? parseMoney(wo.budgetTotal) : 0n),
      0n,
    );
    const totalInvested = formatCents(totalInvestedCents);

    const visitDates: number[] = [
      ...checkinRows.map((c) => c.createdAt.getTime()),
      ...workOrderRows.map((wo) =>
        wo.deliveredAt ? wo.deliveredAt.getTime() : wo.createdAt.getTime(),
      ),
    ];
    const lastVisitAt =
      visitDates.length > 0 ? new Date(Math.max(...visitDates)).toISOString() : null;

    const metrics: VehicleMetricsDto = {
      currentMileage,
      mileageDelta,
      totalCheckins: checkinRows.length,
      totalWorkOrders: workOrderRows.length,
      totalDeliveredWorkOrders: deliveredOrders.length,
      totalInvested,
      lastVisitAt,
    };

    const checkinEvents: TimelineEventDto[] = checkinRows.map((c) => ({
      id: c.id,
      kind: 'checkin',
      occurredAt: c.createdAt.toISOString(),
      summary: `Check-in de recepción #${c.number} con ${c.mileage} km`,
      data: {
        mileage: c.mileage,
        fuelLevel: c.fuelLevel,
        hasInventory: Array.isArray(c.inventory) && c.inventory.length > 0,
        damagesCount: c.damagesCount,
        damageCount: c.damagesCount,
        photosCount: c.photosCount,
        photoCount: c.photosCount,
        authorName: c.authorName,
        createdByName: c.authorName,
      },
    }));

    const budgetEvents: TimelineEventDto[] = budgetRows.map((b) => ({
      id: b.id,
      kind: 'budget',
      occurredAt: b.createdAt.toISOString(),
      summary: `Presupuesto #${b.number} (${b.status}) por $${b.total}`,
      data: {
        checkinId: b.checkinId,
        number: b.number,
        status: b.status,
        subtotal: b.subtotal,
        tax: b.tax,
        total: b.total,
        linesCount: b.linesCount,
        lineCount: b.linesCount,
        itemsCount: b.linesCount,
      },
    }));

    const workOrderEvents: TimelineEventDto[] = workOrderRows.map((wo) => ({
      id: wo.id,
      kind: 'work_order',
      occurredAt: wo.createdAt.toISOString(),
      summary: `Orden de trabajo #${wo.number} (${wo.status})`,
      data: {
        budgetId: wo.budgetId,
        checkinId: wo.checkinId,
        number: wo.number,
        status: wo.status,
        itemsCount: wo.itemsCount,
        notesCount: wo.notesCount,
        deliveredAt: wo.deliveredAt ? wo.deliveredAt.toISOString() : null,
        assigneeName: wo.assigneeName,
        assignee: {
          id: wo.assigneeId,
          name: wo.assigneeName,
        },
      },
    }));

    const transferEvents: TimelineEventDto[] = transferRows.map((t) => ({
      id: t.id,
      kind: 'ownership_transfer',
      occurredAt: t.occurredAt.toISOString(),
      summary: `Transferencia de propietario a ${t.after?.ownerDisplayName ?? 'nuevo propietario'}`,
      data: {
        previousOwner: {
          clientId: t.before?.ownerClientId ?? '',
          displayName: t.before?.ownerDisplayName ?? '',
          documentNumber: t.before?.ownerDocumentNumber ?? '',
        },
        newOwner: {
          clientId: t.after?.ownerClientId ?? '',
          displayName: t.after?.ownerDisplayName ?? '',
          documentNumber: t.after?.ownerDocumentNumber ?? '',
        },
        reason: t.reason ?? null,
        transferredBy: t.actorName,
        actorName: t.actorName,
      },
    }));

    const timeline: TimelineEventDto[] = [
      ...checkinEvents,
      ...budgetEvents,
      ...workOrderEvents,
      ...transferEvents,
    ].sort((a, b) => {
      const diff = new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
      if (diff !== 0) return diff;
      return b.id.localeCompare(a.id);
    });

    return {
      vehicle,
      owner,
      metrics,
      timeline,
    };
  }
}
