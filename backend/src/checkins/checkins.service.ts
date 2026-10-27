import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ProblemException } from '../common/problem-details.filter.js';
import { getManager, getTenantContext } from '../database/tenant-context.js';
import type {
  CreateCheckinDto,
  DamageType,
  FuelLevel,
  ImageUploadDto,
  View,
} from './dto/create-checkin.dto.js';
import { decodeImage, InvalidImageError, type DecodedImage, type ImageMime } from './image.util.js';

/** Contract `CheckinSummary`. */
export interface CheckinSummary {
  id: string;
  number: number;
  createdAt: string;
  mileage: number;
  reason: string;
  createdByName: string;
  damageCount: number;
}

export interface CheckinDamage {
  id: string;
  view: View;
  type: DamageType;
  note: string | null;
  photoImageId: string | null;
}

/** Contract `CheckinDetail`. */
export interface CheckinDetail extends CheckinSummary {
  vehicleId: string;
  ownerClientId: string;
  ownerName: string;
  fuelLevel: FuelLevel;
  inventory: string[];
  signatureImageId: string;
  damages: CheckinDamage[];
}

interface SummaryRow {
  id: string;
  number: number;
  createdAt: Date;
  mileage: number;
  reason: string;
  createdByName: string;
  damageCount: number;
}

interface DetailRow extends SummaryRow {
  vehicleId: string;
  ownerClientId: string;
  ownerName: string;
  fuelLevel: FuelLevel;
  inventory: string[];
  signatureImageId: string;
}

const SUMMARY_COLUMNS = `ch.id, ch.number, ch.created_at AS "createdAt", ch.mileage, ch.reason,
       u.name AS "createdByName",
       (SELECT count(*)::int FROM checkin_damages d
         WHERE d.tenant_id = ch.tenant_id AND d.checkin_id = ch.id) AS "damageCount"`;

const LIST_SQL = `
SELECT ${SUMMARY_COLUMNS}
FROM checkins ch
JOIN users u ON u.tenant_id = ch.tenant_id AND u.id = ch.created_by
WHERE ch.tenant_id = app_current_tenant() AND ch.vehicle_id = $1
ORDER BY ch.created_at DESC, ch.number DESC`;

const DETAIL_SQL = `
SELECT ${SUMMARY_COLUMNS},
       ch.vehicle_id AS "vehicleId", ch.owner_client_id AS "ownerClientId",
       c.display_name AS "ownerName", ch.fuel_level AS "fuelLevel", ch.inventory,
       ch.signature_image_id AS "signatureImageId"
FROM checkins ch
JOIN users u ON u.tenant_id = ch.tenant_id AND u.id = ch.created_by
JOIN clients c ON c.tenant_id = ch.tenant_id AND c.id = ch.owner_client_id
WHERE ch.tenant_id = app_current_tenant() AND ch.id = $1`;

const DAMAGES_SQL = `
SELECT id, view, type, note, photo_image_id AS "photoImageId"
FROM checkin_damages
WHERE tenant_id = app_current_tenant() AND checkin_id = $1
ORDER BY ctid`;

function notFound(): ProblemException {
  return new ProblemException(404, 'NOT_FOUND');
}

function toSummary(row: SummaryRow): CheckinSummary {
  return {
    id: row.id,
    number: row.number,
    createdAt: row.createdAt.toISOString(),
    mileage: row.mileage,
    reason: row.reason,
    createdByName: row.createdByName,
    damageCount: row.damageCount,
  };
}

function decodeOrFail(upload: ImageUploadDto, field: string): DecodedImage {
  try {
    return decodeImage(upload);
  } catch (error) {
    if (error instanceof InvalidImageError) {
      throw new ProblemException(400, 'VALIDATION_ERROR', {
        errors: [{ field, code: 'INVALID_IMAGE', message: error.message }],
      });
    }
    throw error;
  }
}

@Injectable()
export class CheckinsService {
  /** US1: creates the check-in in the request transaction (images, check-in, damages). */
  async create(vehicleId: string, dto: CreateCheckinDto): Promise<CheckinDetail> {
    const damages = dto.damages ?? [];
    // Decode first: an invalid image fails before touching the database (US1-AC4).
    const signature = decodeOrFail(dto.signature, 'signature');
    const photos = damages.map((d, i) =>
      d.photo ? decodeOrFail(d.photo, `damages.${i}.photo`) : null,
    );

    if (!isUUID(vehicleId)) throw notFound();
    const manager = getManager();
    const { user } = getTenantContext();

    // Locks the vehicle so that concurrent check-ins compare mileage in order (FR-004).
    const vehicles: { ownerClientId: string }[] = await manager.query(
      `SELECT owner_client_id AS "ownerClientId" FROM vehicles
        WHERE tenant_id = app_current_tenant() AND id = $1 FOR UPDATE`,
      [vehicleId],
    );
    if (vehicles.length === 0) throw notFound();

    const last: { lastMileage: number | null }[] = await manager.query(
      `SELECT max(mileage) AS "lastMileage" FROM checkins
        WHERE tenant_id = app_current_tenant() AND vehicle_id = $1`,
      [vehicleId],
    );
    const lastMileage = last[0]?.lastMileage ?? null;
    if (lastMileage !== null && dto.mileage < lastMileage) {
      throw new ProblemException(409, 'MILEAGE_BELOW_LAST', { lastMileage });
    }

    const counter: { number: number }[] = await manager.query(
      `INSERT INTO checkin_counters (tenant_id, last_number) VALUES (app_current_tenant(), 1)
       ON CONFLICT (tenant_id) DO UPDATE SET last_number = checkin_counters.last_number + 1
       RETURNING last_number AS number`,
    );
    const number = counter[0].number;
    const checkinId = randomUUID();

    const insertImage = async (image: DecodedImage, kind: 'signature' | 'damage') => {
      const rows: { id: string }[] = await manager.query(
        `INSERT INTO checkin_images (tenant_id, checkin_id, kind, mime, data)
         VALUES (app_current_tenant(), $1, $2, $3, $4) RETURNING id`,
        [checkinId, kind, image.mime, image.data],
      );
      return rows[0].id;
    };

    const signatureImageId = await insertImage(signature, 'signature');
    const photoIds: (string | null)[] = [];
    for (const photo of photos) photoIds.push(photo ? await insertImage(photo, 'damage') : null);

    await manager.query(
      `INSERT INTO checkins (id, tenant_id, number, vehicle_id, owner_client_id, created_by,
                             mileage, fuel_level, reason, inventory, signature_image_id)
       VALUES ($1, app_current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        checkinId,
        number,
        vehicleId,
        vehicles[0].ownerClientId,
        user.userId,
        dto.mileage,
        dto.fuelLevel,
        dto.reason,
        dto.inventory ?? [],
        signatureImageId,
      ],
    );
    for (const [i, damage] of damages.entries()) {
      await manager.query(
        `INSERT INTO checkin_damages (tenant_id, checkin_id, view, type, note, photo_image_id)
         VALUES (app_current_tenant(), $1, $2, $3, $4, $5)`,
        [checkinId, damage.view, damage.type, damage.note ?? null, photoIds[i]],
      );
    }
    return this.getById(checkinId);
  }

  /** US2-AC1: newest first; 404 if the vehicle is missing or from another tenant. */
  async listByVehicle(vehicleId: string): Promise<CheckinSummary[]> {
    if (!isUUID(vehicleId)) throw notFound();
    const manager = getManager();
    const exists: unknown[] = await manager.query(
      'SELECT 1 FROM vehicles WHERE tenant_id = app_current_tenant() AND id = $1',
      [vehicleId],
    );
    if (exists.length === 0) throw notFound();
    const rows: SummaryRow[] = await manager.query(LIST_SQL, [vehicleId]);
    return rows.map(toSummary);
  }

  async getById(checkinId: string): Promise<CheckinDetail> {
    if (!isUUID(checkinId)) throw notFound();
    const manager = getManager();
    const rows: DetailRow[] = await manager.query(DETAIL_SQL, [checkinId]);
    const row = rows[0];
    if (!row) throw notFound();
    const damages: CheckinDamage[] = await manager.query(DAMAGES_SQL, [checkinId]);
    return {
      ...toSummary(row),
      vehicleId: row.vehicleId,
      ownerClientId: row.ownerClientId,
      ownerName: row.ownerName,
      fuelLevel: row.fuelLevel,
      inventory: row.inventory,
      signatureImageId: row.signatureImageId,
      damages: damages.map((d) => ({
        id: d.id,
        view: d.view,
        type: d.type,
        note: d.note,
        photoImageId: d.photoImageId,
      })),
    };
  }

  async getImage(checkinId: string, imageId: string): Promise<{ mime: ImageMime; data: Buffer }> {
    if (!isUUID(checkinId) || !isUUID(imageId)) throw notFound();
    const rows: { mime: ImageMime; data: Buffer }[] = await getManager().query(
      `SELECT mime, data FROM checkin_images
        WHERE tenant_id = app_current_tenant() AND checkin_id = $1 AND id = $2`,
      [checkinId, imageId],
    );
    if (rows.length === 0) throw notFound();
    return rows[0];
  }

}
