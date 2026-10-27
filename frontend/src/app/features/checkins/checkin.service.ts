import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';

// Tipos de specs/004-checkin-360/contracts/openapi.yaml.

export const FUEL_LEVELS = ['vacio', '1/4', '1/2', '3/4', 'lleno'] as const;
export type FuelLevel = (typeof FUEL_LEVELS)[number];

export const VIEWS = ['frente', 'atras', 'izquierda', 'derecha', 'arriba'] as const;
export type View = (typeof VIEWS)[number];

export const DAMAGE_TYPES = ['rayon', 'golpe', 'abolladura', 'rotura', 'faltante', 'otro'] as const;
export type DamageType = (typeof DAMAGE_TYPES)[number];

export interface ImageUpload {
  mime: 'image/jpeg' | 'image/png';
  base64: string;
}

export interface DamageInput {
  view: View;
  type: DamageType;
  note?: string;
  photo?: ImageUpload;
}

export interface CheckinCreate {
  mileage: number;
  fuelLevel: FuelLevel;
  reason: string;
  inventory?: string[];
  damages?: DamageInput[];
  signature: ImageUpload;
}

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

export interface CheckinDetail extends CheckinSummary {
  vehicleId: string;
  ownerClientId: string;
  ownerName: string;
  fuelLevel: FuelLevel;
  inventory: string[];
  signatureImageId: string;
  damages: CheckinDamage[];
}

export const VIEW_LABELS: Record<View, string> = {
  frente: 'Frente',
  atras: 'Atrás',
  izquierda: 'Izquierda',
  derecha: 'Derecha',
  arriba: 'Arriba',
};

export const DAMAGE_TYPE_LABELS: Record<DamageType, string> = {
  rayon: 'Rayón',
  golpe: 'Golpe',
  abolladura: 'Abolladura',
  rotura: 'Rotura',
  faltante: 'Faltante',
  otro: 'Otro',
};

export const FUEL_LABELS: Record<FuelLevel, string> = {
  vacio: 'Vacío',
  '1/4': '1/4',
  '1/2': '1/2',
  '3/4': '3/4',
  lleno: 'Lleno',
};

const API = '/api/v1';

/** Check-in endpoints (contract 004). Errors arrive as HttpErrorResponse with the Problem body. */
@Injectable({ providedIn: 'root' })
export class CheckinService {
  private readonly http = inject(HttpClient);

  create(vehicleId: string, body: CheckinCreate): Observable<CheckinDetail> {
    return this.http.post<CheckinDetail>(`${API}/vehicles/${encodeURIComponent(vehicleId)}/checkins`, body);
  }

  list(vehicleId: string): Observable<CheckinSummary[]> {
    return this.http.get<CheckinSummary[]>(`${API}/vehicles/${encodeURIComponent(vehicleId)}/checkins`);
  }

  getById(checkinId: string): Observable<CheckinDetail> {
    return this.http.get<CheckinDetail>(`${API}/checkins/${encodeURIComponent(checkinId)}`);
  }

  getImage(checkinId: string, imageId: string): Observable<Blob> {
    return this.http.get(`${API}/checkins/${encodeURIComponent(checkinId)}/images/${encodeURIComponent(imageId)}`, {
      responseType: 'blob',
    });
  }
}
