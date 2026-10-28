import type { DocumentType } from '../../clients/client.entity.js';
import type { BodyType } from '../../common/identifiers/plate.js';

export type TimelineEventKind =
  | 'checkin'
  | 'budget'
  | 'work_order'
  | 'ownership_transfer';

/** Contract `VehicleHeader`. */
export interface VehicleHeaderDto {
  id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
  color: string;
  bodyType: BodyType;
  vin: string | null;
  initialMileage: number;
}

/** Contract `VehicleOwner`. */
export interface VehicleOwnerDto {
  id: string;
  displayName: string;
  documentType: DocumentType;
  documentNumber: string;
  phone: string | null;
}

/** Contract `VehicleMetrics`. */
export interface VehicleMetricsDto {
  currentMileage: number;
  mileageDelta: number;
  totalCheckins: number;
  totalWorkOrders: number;
  totalDeliveredWorkOrders: number;
  totalInvested: string;
  lastVisitAt: string | null;
}

/** Contract `TimelineEvent`. */
export interface TimelineEventDto {
  id: string;
  kind: TimelineEventKind;
  occurredAt: string;
  summary: string;
  data: Record<string, unknown>;
}

/** Contract `VehicleClinicalHistory` (response of GET /api/v1/vehicles/:vehicleId/history). */
export interface VehicleClinicalHistoryDto {
  vehicle: VehicleHeaderDto;
  owner: VehicleOwnerDto;
  metrics: VehicleMetricsDto;
  timeline: TimelineEventDto[];
}
