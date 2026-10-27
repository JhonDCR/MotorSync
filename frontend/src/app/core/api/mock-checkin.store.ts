import { inject, Injectable } from '@angular/core';
import {
  type CheckinDamage,
  type CheckinDetail,
  type CheckinSummary,
  DAMAGE_TYPES,
  type DamageType,
  FUEL_LEVELS,
  type FuelLevel,
  type ImageUpload,
  type View,
  VIEWS,
} from '../../features/checkins/checkin.service';
import type { FieldError } from './api.models';
import { MockApiStore, mockProblem, newId, type MockActor, type MockResult } from './mock-api.store';

// Check-ins of the mock API (contract 004): same validations, 409 with lastMileage and immutable records.

const MAX_IMAGE_BYTES = 1024 * 1024;
const CHECKIN_FIELDS = new Set(['mileage', 'fuelLevel', 'reason', 'inventory', 'damages', 'signature']);

interface StoredImage {
  mime: ImageUpload['mime'];
  bytes: Uint8Array<ArrayBuffer>;
}

interface StoredCheckin {
  detail: CheckinDetail;
  images: Map<string, StoredImage>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeImage(raw: unknown): StoredImage | null {
  if (!isRecord(raw) || (raw['mime'] !== 'image/jpeg' && raw['mime'] !== 'image/png')) {
    return null;
  }
  const base64 = raw['base64'];
  if (typeof base64 !== 'string' || base64 === '') {
    return null;
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  if (binary.length > MAX_IMAGE_BYTES) {
    return null;
  }
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Magic bytes: PNG 89 50 4E 47, JPEG FF D8 FF.
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if ((raw['mime'] === 'image/png' && !png) || (raw['mime'] === 'image/jpeg' && !jpeg)) {
    return null;
  }
  return { mime: raw['mime'], bytes };
}

@Injectable({ providedIn: 'root' })
export class MockCheckinStore {
  private readonly vehicles = inject(MockApiStore);
  private readonly checkins = new Map<string, StoredCheckin>();

  create(vehicleId: string, raw: unknown, actor: MockActor): MockResult<CheckinDetail> {
    const vehicleResult = this.vehicles.getVehicle(vehicleId);
    if (!vehicleResult.ok) {
      return vehicleResult;
    }
    const vehicle = vehicleResult.body;
    const errors: FieldError[] = [];
    const invalid = (field: string, code = 'REQUIRED'): void => {
      errors.push({ field, code, message: field });
    };
    if (!isRecord(raw)) {
      return { ok: false, problem: mockProblem(400, 'VALIDATION_ERROR', { errors: [] }) };
    }
    for (const key of Object.keys(raw)) {
      if (!CHECKIN_FIELDS.has(key)) invalid(key, 'UNKNOWN_FIELD');
    }
    const mileage = raw['mileage'];
    if (typeof mileage !== 'number' || !Number.isInteger(mileage) || mileage < 0) invalid('mileage', 'INVALID_MILEAGE');
    const fuelLevel = FUEL_LEVELS.find((f): f is FuelLevel => f === raw['fuelLevel']);
    if (fuelLevel === undefined) invalid('fuelLevel');
    const reason = typeof raw['reason'] === 'string' ? raw['reason'].trim() : '';
    if (reason === '' || reason.length > 1000) invalid('reason');
    const inventoryRaw = raw['inventory'] ?? [];
    const inventory: string[] = [];
    if (!Array.isArray(inventoryRaw) || inventoryRaw.length > 30) {
      invalid('inventory');
    } else {
      for (const item of inventoryRaw) {
        if (typeof item !== 'string' || item.trim() === '' || item.length > 100) invalid('inventory');
        else inventory.push(item.trim());
      }
    }
    const signature = decodeImage(raw['signature']);
    if (signature === null) invalid('signature');

    const images = new Map<string, StoredImage>();
    const damages: CheckinDamage[] = [];
    const damagesRaw = raw['damages'] ?? [];
    if (!Array.isArray(damagesRaw) || damagesRaw.length > 20) {
      invalid('damages');
    } else {
      damagesRaw.forEach((d: unknown, i: number) => {
        const view = isRecord(d) ? VIEWS.find((v): v is View => v === d['view']) : undefined;
        const type = isRecord(d) ? DAMAGE_TYPES.find((t): t is DamageType => t === d['type']) : undefined;
        const note = isRecord(d) ? d['note'] : undefined;
        if (view === undefined) invalid(`damages[${i}].view`);
        if (type === undefined) invalid(`damages[${i}].type`);
        if (note !== undefined && (typeof note !== 'string' || note.length > 500)) invalid(`damages[${i}].note`);
        let photoImageId: string | null = null;
        if (isRecord(d) && d['photo'] !== undefined) {
          const photo = decodeImage(d['photo']);
          if (photo === null) {
            invalid(`damages[${i}].photo`);
          } else {
            photoImageId = newId();
            images.set(photoImageId, photo);
          }
        }
        if (view !== undefined && type !== undefined) {
          const text = typeof note === 'string' && note.trim() !== '' ? note.trim() : null;
          damages.push({ id: newId(), view, type, note: text, photoImageId });
        }
      });
    }
    if (errors.length > 0 || signature === null || fuelLevel === undefined || typeof mileage !== 'number') {
      return { ok: false, problem: mockProblem(400, 'VALIDATION_ERROR', { errors }) };
    }

    const previous = this.forVehicle(vehicle.id);
    const last = previous[0];
    if (last !== undefined && mileage < last.mileage) {
      return { ok: false, problem: mockProblem(409, 'MILEAGE_BELOW_LAST', { lastMileage: last.mileage }) };
    }

    const signatureImageId = newId();
    images.set(signatureImageId, signature);
    const detail: CheckinDetail = {
      id: newId(),
      number: this.checkins.size + 1,
      createdAt: new Date().toISOString(),
      mileage,
      reason,
      createdByName: actor.name,
      damageCount: damages.length,
      vehicleId: vehicle.id,
      ownerClientId: vehicle.owner.id,
      ownerName: vehicle.owner.displayName,
      fuelLevel,
      inventory,
      signatureImageId,
      damages,
    };
    this.checkins.set(detail.id, { detail, images });
    return { ok: true, status: 201, body: detail };
  }

  list(vehicleId: string): MockResult<CheckinSummary[]> {
    const vehicleResult = this.vehicles.getVehicle(vehicleId);
    if (!vehicleResult.ok) {
      return vehicleResult;
    }
    const body = this.forVehicle(vehicleResult.body.id).map(
      ({ id, number, createdAt, mileage, reason, createdByName, damageCount }) => ({
        id,
        number,
        createdAt,
        mileage,
        reason,
        createdByName,
        damageCount,
      }),
    );
    return { ok: true, status: 200, body };
  }

  get(checkinId: string): MockResult<CheckinDetail> {
    const stored = this.checkins.get(checkinId);
    return stored ? { ok: true, status: 200, body: stored.detail } : { ok: false, problem: mockProblem(404, 'NOT_FOUND') };
  }

  image(checkinId: string, imageId: string): MockResult<Blob> {
    const image = this.checkins.get(checkinId)?.images.get(imageId);
    return image
      ? { ok: true, status: 200, body: new Blob([image.bytes], { type: image.mime }) }
      : { ok: false, problem: mockProblem(404, 'NOT_FOUND') };
  }

  /** Newest first. */
  private forVehicle(vehicleId: string): CheckinDetail[] {
    return [...this.checkins.values()]
      .map((c) => c.detail)
      .filter((c) => c.vehicleId === vehicleId)
      .sort((a, b) => b.number - a.number);
  }
}
