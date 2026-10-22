import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Client, type ClientType, type DocumentType } from '../clients/client.entity.js';
import {
  escapeLike,
  SEARCH_MIN_LENGTH,
  SEARCH_PAGE_SIZE,
  type ClientSummary,
} from '../clients/clients.service.js';
import { normalizePlateForSearch, type BodyType } from '../common/identifiers/plate.js';
import { isValidVin } from '../common/identifiers/vin.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { translatePgError } from '../database/pg-errors.js';
import { getManager, getTenantContext } from '../database/tenant-context.js';
import type { CreateVehicleDto } from './dto/create-vehicle.dto.js';
import { Vehicle } from './vehicle.entity.js';

/** Contract `VehicleDetail` (never exposes tenant_id nor owner_client_id). */
export interface VehicleDetail {
  id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
  vin: string | null;
  color: string;
  bodyType: BodyType;
  initialMileage: number;
  version: number;
  owner: ClientSummary;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  updatedByName: string;
}

/**
 * Raw row of VEHICLE_DETAIL_SQL. pg parses uuid and text as string, smallint and integer as
 * number, timestamptz as Date and NULL as null. body_type, client_type and document_type are
 * text columns restricted by CHECK constraints to BodyType, ClientType and DocumentType.
 */
interface VehicleDetailRow {
  id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
  vin: string | null;
  color: string;
  bodyType: BodyType;
  initialMileage: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
  updatedByName: string;
  ownerId: string;
  ownerClientType: ClientType;
  ownerDocumentType: DocumentType;
  ownerDocumentNumber: string;
  ownerDisplayName: string;
  ownerPhone: string;
  ownerEmail: string | null;
}

/** Contract item of `VehicleSearchResponse`: VehicleSummary + vin, color, bodyType, initialMileage, owner. */
export interface VehicleSearchItem {
  id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
  vin: string | null;
  color: string;
  bodyType: BodyType;
  initialMileage: number;
  owner: ClientSummary;
}

/** Contract `VehicleSearchResponse`. */
export interface VehicleSearchResponse {
  items: VehicleSearchItem[];
  hasMore: boolean;
}

/**
 * Raw row of the search queries (same pg parsing as VehicleDetailRow). manager.query() returns
 * any at the driver boundary; the generic pins it to this shape, which mirrors the SELECT list
 * of SEARCH_COLUMNS, and toSearchItem maps it field by field to the contract.
 */
type VehicleSearchRow = Omit<
  VehicleDetailRow,
  'version' | 'createdAt' | 'updatedAt' | 'updatedBy' | 'updatedByName'
>;

/** Raw row of the existingId lookups. */
interface VehicleIdRow {
  id: string;
}

const CREATE_SAVEPOINT = 'vehicle_create';

/**
 * Vehicle with its current owner (FR-014). The explicit tenant filter is the first barrier
 * (principle I); RLS on both tables is the second. The join follows the composite FK
 * vehicles_owner_same_tenant_fk.
 */
const VEHICLE_DETAIL_SQL = `
SELECT v.id, v.plate, v.brand, v.model, v.year, v.vin, v.color,
       v.body_type AS "bodyType", v.initial_mileage AS "initialMileage", v.version,
       v.created_at AS "createdAt", v.updated_at AS "updatedAt",
       v.updated_by AS "updatedBy", v.updated_by_name AS "updatedByName",
       c.id AS "ownerId", c.client_type AS "ownerClientType",
       c.document_type AS "ownerDocumentType", c.document_number AS "ownerDocumentNumber",
       c.display_name AS "ownerDisplayName", c.phone AS "ownerPhone", c.email AS "ownerEmail"
FROM vehicles v
JOIN clients c ON c.tenant_id = v.tenant_id AND c.id = v.owner_client_id
WHERE v.tenant_id = app_current_tenant()
  AND v.id = $1`;

/** Contract `q`: maxLength 40 (before normalizing). */
export const VEHICLE_SEARCH_MAX_LENGTH = 40;

const SEARCH_COLUMNS = `v.id, v.plate, v.brand, v.model, v.year, v.vin, v.color,
       v.body_type AS "bodyType", v.initial_mileage AS "initialMileage",
       c.id AS "ownerId", c.client_type AS "ownerClientType",
       c.document_type AS "ownerDocumentType", c.document_number AS "ownerDocumentNumber",
       c.display_name AS "ownerDisplayName", c.phone AS "ownerPhone", c.email AS "ownerEmail"`;

/**
 * Reference query of data-model.md ("Búsqueda de vehículos"). $1 is the normalized term
 * ([A-Z0-9]{2,}) escaped for LIKE (defense in depth: no metacharacter survives the
 * normalization) and $2 the raw normalized term for the exact match. Explicit tenant filter on
 * both tables (principle I) plus RLS. LIMIT page size + 1 to compute hasMore.
 */
function vehicleSearchSql(withVin: boolean): string {
  const exact = withVin ? 'v.plate = $2 OR v.vin = $2' : 'v.plate = $2';
  const vinMatch = withVin ? ' OR v.vin = $2' : '';
  return String.raw`
SELECT ${SEARCH_COLUMNS}
FROM vehicles v
JOIN clients c ON c.tenant_id = v.tenant_id AND c.id = v.owner_client_id
WHERE v.tenant_id = app_current_tenant()
  AND c.tenant_id = app_current_tenant()
  AND (v.plate LIKE '%' || $1 || '%' ESCAPE ''${vinMatch})
ORDER BY CASE WHEN ${exact} THEN 0
              WHEN v.plate LIKE $1 || '%' ESCAPE '' THEN 1 ELSE 2 END,
         v.plate
LIMIT ${SEARCH_PAGE_SIZE + 1}`;
}

/** The VIN only matches by equality, and only when the term has the shape of a VIN (US1-AC7). */
const SEARCH_BY_PLATE_SQL = vehicleSearchSql(false);
const SEARCH_BY_PLATE_OR_VIN_SQL = vehicleSearchSql(true);

const ID_BY_PLATE_SQL =
  'SELECT id FROM vehicles WHERE tenant_id = app_current_tenant() AND plate = $1';
const ID_BY_VIN_SQL = 'SELECT id FROM vehicles WHERE tenant_id = app_current_tenant() AND vin = $1';

function notFound(): ProblemException {
  return new ProblemException(404, 'NOT_FOUND');
}

function clientNotFound(): ProblemException {
  return new ProblemException(404, 'CLIENT_NOT_FOUND');
}

function tooShort(): ProblemException {
  return new ProblemException(400, 'SEARCH_TERM_TOO_SHORT');
}

function invalidTerm(message: string): ProblemException {
  return new ProblemException(400, 'VALIDATION_ERROR', {
    errors: [{ field: 'q', code: 'VALIDATION_ERROR', message }],
  });
}

function toOwner(row: VehicleSearchRow): ClientSummary {
  return {
    id: row.ownerId,
    clientType: row.ownerClientType,
    documentType: row.ownerDocumentType,
    documentNumber: row.ownerDocumentNumber,
    displayName: row.ownerDisplayName,
    phone: row.ownerPhone,
    email: row.ownerEmail ?? null,
  };
}

function toSearchItem(row: VehicleSearchRow): VehicleSearchItem {
  return {
    id: row.id,
    plate: row.plate,
    brand: row.brand,
    model: row.model,
    year: row.year,
    vin: row.vin ?? null,
    color: row.color,
    bodyType: row.bodyType,
    initialMileage: row.initialMileage,
    owner: toOwner(row),
  };
}

function toDetail(row: VehicleDetailRow): VehicleDetail {
  return {
    id: row.id,
    plate: row.plate,
    brand: row.brand,
    model: row.model,
    year: row.year,
    vin: row.vin ?? null,
    color: row.color,
    bodyType: row.bodyType,
    initialMileage: row.initialMileage,
    version: row.version,
    owner: toOwner(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
    updatedByName: row.updatedByName,
  };
}

/**
 * Vehicles of the tenant of the request. Every query runs on the request transaction
 * (getManager()), so RLS scopes it to the tenant of the verified token.
 */
@Injectable()
export class VehiclesService {
  async create(dto: CreateVehicleDto): Promise<VehicleDetail> {
    const { manager, user } = getTenantContext();

    // US3-AC11: the owner must be visible under RLS; a client of another tenant is
    // indistinguishable from a missing one, and nothing is inserted.
    const ownerExists = await manager.getRepository(Client).existsBy({ id: dto.ownerClientId });
    if (!ownerExists) throw clientNotFound();

    const values = {
      ownerClientId: dto.ownerClientId,
      plate: dto.plate,
      vin: dto.vin ?? null,
      brand: dto.brand,
      model: dto.model,
      year: dto.year,
      color: dto.color,
      bodyType: dto.bodyType,
      initialMileage: dto.initialMileage,
      createdBy: user.userId,
      updatedBy: user.userId,
      updatedByName: user.name,
    };

    // The unique indexes decide duplicates (also under concurrency). The savepoint keeps the
    // request transaction usable after a unique violation, to look up existingId under RLS.
    await manager.query<unknown>(`SAVEPOINT ${CREATE_SAVEPOINT}`);
    let id: string;
    try {
      const result = await manager.getRepository(Vehicle).insert(values);
      id = (result.identifiers[0] as Pick<Vehicle, 'id'>).id;
      await manager.query<unknown>(`RELEASE SAVEPOINT ${CREATE_SAVEPOINT}`);
    } catch (error: unknown) {
      await manager.query<unknown>(`ROLLBACK TO SAVEPOINT ${CREATE_SAVEPOINT}`);
      throw await this.translateCreateError(error, values.plate, values.vin);
    }
    return this.getById(id);
  }

  /**
   * GET /vehicles/search (US1): plate "contains" over the normalized term, VIN by equality;
   * exact → prefix → contains, then plate. 400 SEARCH_TERM_TOO_SHORT under 2 characters
   * after normalizing (uppercase, only [A-Z0-9], FR-002).
   */
  async searchVehicles(rawTerm: string | string[] | undefined): Promise<VehicleSearchResponse> {
    if (Array.isArray(rawTerm)) throw invalidTerm('Envíe un solo término de búsqueda');
    const raw = rawTerm ?? '';
    if (raw.length > VEHICLE_SEARCH_MAX_LENGTH) {
      throw invalidTerm(`El término admite como máximo ${VEHICLE_SEARCH_MAX_LENGTH} caracteres`);
    }
    const term = normalizePlateForSearch(raw);
    if (term.length < SEARCH_MIN_LENGTH) throw tooShort();

    const sql = isValidVin(term) ? SEARCH_BY_PLATE_OR_VIN_SQL : SEARCH_BY_PLATE_SQL;
    const rows = await getManager().query<VehicleSearchRow[]>(sql, [escapeLike(term), term]);
    return {
      items: rows.slice(0, SEARCH_PAGE_SIZE).map(toSearchItem),
      hasMore: rows.length > SEARCH_PAGE_SIZE,
    };
  }

  /** GET /vehicles/{id}: 404 NOT_FOUND for missing, foreign or malformed ids (US1-AC9). */
  async getById(vehicleId: string): Promise<VehicleDetail> {
    if (!isUUID(vehicleId)) throw notFound();
    const rows = await getManager().query<VehicleDetailRow[]>(VEHICLE_DETAIL_SQL, [vehicleId]);
    const row = rows[0];
    if (!row) throw notFound();
    return toDetail(row);
  }

  private async translateCreateError(
    error: unknown,
    plate: string,
    vin: string | null,
  ): Promise<unknown> {
    const translated = translatePgError(error);
    if (!translated) return error;
    let existingId: string | undefined;
    if (translated.code === 'PLATE_ALREADY_EXISTS') {
      existingId = await this.findExistingId(ID_BY_PLATE_SQL, plate);
    } else if (translated.code === 'VIN_ALREADY_EXISTS' && vin !== null) {
      existingId = await this.findExistingId(ID_BY_VIN_SQL, vin);
    }
    return new ProblemException(translated.status, translated.code, {
      ...(translated.errors ? { errors: translated.errors } : {}),
      ...(existingId ? { existingId } : {}),
    });
  }

  private async findExistingId(sql: string, value: string): Promise<string | undefined> {
    const rows = await getManager().query<VehicleIdRow[]>(sql, [value]);
    return rows[0]?.id;
  }
}
