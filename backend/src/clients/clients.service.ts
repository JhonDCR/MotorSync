import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ProblemException } from '../common/problem-details.filter.js';
import { translatePgError } from '../database/pg-errors.js';
import { getManager, getTenantContext } from '../database/tenant-context.js';
import { normalizeDocument } from '../common/identifiers/normalize.js';
import { Client, type ClientType, type DocumentType } from './client.entity.js';
import type { CreateClientDto } from './dto/create-client.dto.js';

/** Contract `VehicleSummary`. */
export interface VehicleSummary {
  id: string;
  plate: string;
  brand: string;
  model: string;
  year: number;
}

/** Contract `ClientDetail` (never exposes tenant_id). */
export interface ClientDetail {
  id: string;
  clientType: ClientType;
  documentType: DocumentType;
  documentNumber: string;
  displayName: string;
  phone: string;
  email: string | null;
  firstNames: string | null;
  lastNames: string | null;
  businessName: string | null;
  version: number;
  vehicles: VehicleSummary[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  updatedByName: string;
}

/** Contract `ClientSummary` (never exposes tenant_id). */
export interface ClientSummary {
  id: string;
  clientType: ClientType;
  documentType: DocumentType;
  documentNumber: string;
  displayName: string;
  phone: string;
  email: string | null;
}

/** Contract `ClientSearchResponse`. */
export interface ClientSearchResponse {
  items: ClientSummary[];
  hasMore: boolean;
}

/**
 * Raw row of the search queries (pg types: uuid and text arrive as string, a NULL email as
 * null). client_type and document_type are text columns restricted by CHECK constraints to
 * the ClientType and DocumentType values, so they are typed as such.
 */
interface ClientSummaryRow {
  id: string;
  clientType: ClientType;
  documentType: DocumentType;
  documentNumber: string;
  displayName: string;
  phone: string;
  email: string | null;
}

const CREATE_SAVEPOINT = 'client_create';

/**
 * Vehicles whose current owner is the client (US4-AC3), ordered by plate. Raw row typed as
 * VehicleSummary: pg parses uuid and text as string and smallint as number.
 */
const OWNED_VEHICLES_SQL = `
SELECT v.id, v.plate, v.brand, v.model, v.year
FROM vehicles v
WHERE v.tenant_id = app_current_tenant()
  AND v.owner_client_id = $1
ORDER BY v.plate, v.id`;

/** FR-003/FR-004: at least 2 significant characters, at most 20 items per page. */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;
export const SEARCH_PAGE_SIZE = 20;

/** A normalized document can only match `document_number` (`^[A-Z0-9]{5,20}$`) if alphanumeric. */
const SEARCHABLE_DOCUMENT = /^[A-Z0-9]+$/;

/** Escapes the LIKE metacharacters `\`, `%` and `_` (the queries declare ESCAPE '\'). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const SUMMARY_COLUMNS = `c.id, c.client_type AS "clientType", c.document_type AS "documentType",
       c.document_number AS "documentNumber", c.display_name AS "displayName",
       c.phone, c.email`;

/**
 * Reference query of data-model.md ("Búsqueda de clientes"). $1 is the escaped normalized
 * document, $2 the escaped trimmed term (lowered and unaccented here, like search_name) and
 * $3 the normalized document for the exact match.
 */
const SEARCH_BY_DOCUMENT_OR_NAME_SQL = String.raw`
SELECT ${SUMMARY_COLUMNS}
FROM clients c
WHERE c.tenant_id = app_current_tenant()
  AND (c.document_number LIKE '%' || $1 || '%' ESCAPE '\'
       OR c.search_name LIKE '%' || immutable_unaccent(lower($2)) || '%' ESCAPE '\')
ORDER BY CASE WHEN c.document_number = $3 THEN 0
              WHEN c.document_number LIKE $1 || '%' ESCAPE '\' THEN 1 ELSE 2 END,
         c.display_name, c.id
LIMIT ${SEARCH_PAGE_SIZE + 1}`;

/** Same query when the term can never be a document (data-model.md): only the name remains. */
const SEARCH_BY_NAME_SQL = String.raw`
SELECT ${SUMMARY_COLUMNS}
FROM clients c
WHERE c.tenant_id = app_current_tenant()
  AND c.search_name LIKE '%' || immutable_unaccent(lower($1)) || '%' ESCAPE '\'
ORDER BY c.display_name, c.id
LIMIT ${SEARCH_PAGE_SIZE + 1}`;

function tooShort(): ProblemException {
  return new ProblemException(400, 'SEARCH_TERM_TOO_SHORT');
}

function invalidTerm(message: string): ProblemException {
  return new ProblemException(400, 'VALIDATION_ERROR', {
    errors: [{ field: 'q', code: 'VALIDATION_ERROR', message }],
  });
}

function notFound(): ProblemException {
  return new ProblemException(404, 'NOT_FOUND');
}

function toDetail(client: Client, vehicles: VehicleSummary[]): ClientDetail {
  return {
    id: client.id,
    clientType: client.clientType,
    documentType: client.documentType,
    documentNumber: client.documentNumber,
    displayName: client.displayName,
    phone: client.phone,
    email: client.email,
    firstNames: client.firstNames,
    lastNames: client.lastNames,
    businessName: client.businessName,
    version: client.version,
    vehicles,
    createdAt: client.createdAt.toISOString(),
    updatedAt: client.updatedAt.toISOString(),
    updatedBy: client.updatedBy,
    updatedByName: client.updatedByName,
  };
}

/**
 * Clients of the tenant of the request. Every query runs on the request transaction
 * (getManager()), so RLS scopes it to the tenant of the verified token.
 */
@Injectable()
export class ClientsService {
  async create(dto: CreateClientDto): Promise<ClientDetail> {
    const { manager, user } = getTenantContext();
    const isNatural = dto.clientType === 'natural';
    const values = {
      clientType: dto.clientType,
      documentType: dto.documentType,
      documentNumber: dto.documentNumber,
      firstNames: isNatural ? (dto.firstNames ?? null) : null,
      lastNames: isNatural ? (dto.lastNames ?? null) : null,
      businessName: isNatural ? null : (dto.businessName ?? null),
      phone: dto.phone,
      email: dto.email ?? null,
      createdBy: user.userId,
      updatedBy: user.userId,
      updatedByName: user.name,
    };

    // The unique index decides duplicates (also under concurrency). The savepoint keeps the
    // request transaction usable after a unique violation, to look up existingId under RLS.
    await manager.query<unknown>(`SAVEPOINT ${CREATE_SAVEPOINT}`);
    let id: string;
    try {
      const result = await manager.getRepository(Client).insert(values);
      id = (result.identifiers[0] as Pick<Client, 'id'>).id;
      await manager.query<unknown>(`RELEASE SAVEPOINT ${CREATE_SAVEPOINT}`);
    } catch (error: unknown) {
      await manager.query<unknown>(`ROLLBACK TO SAVEPOINT ${CREATE_SAVEPOINT}`);
      throw await this.translateCreateError(error, dto.documentNumber);
    }
    return this.getById(id);
  }

  /**
   * GET /clients/search (US4): document (exact → prefix → contains) or name/business name
   * ("contains", case and accent insensitive). The explicit tenant filter is the first barrier
   * (principle I) and lets the planner use the (tenant_id, …) trigram indexes; RLS is the second.
   */
  async search(rawTerm: string | string[] | undefined): Promise<ClientSearchResponse> {
    if (Array.isArray(rawTerm)) throw invalidTerm('Envíe un solo término de búsqueda');
    const term = (rawTerm ?? '').trim();
    if (term.length < SEARCH_MIN_LENGTH) throw tooShort();
    if (term.length > SEARCH_MAX_LENGTH) {
      throw invalidTerm(`El término admite como máximo ${SEARCH_MAX_LENGTH} caracteres`);
    }

    const document = normalizeDocument(term);
    const name = escapeLike(term);
    const rows = SEARCHABLE_DOCUMENT.test(document)
      ? await getManager().query<ClientSummaryRow[]>(SEARCH_BY_DOCUMENT_OR_NAME_SQL, [
          escapeLike(document),
          name,
          document,
        ])
      : await getManager().query<ClientSummaryRow[]>(SEARCH_BY_NAME_SQL, [name]);

    return {
      items: rows.slice(0, SEARCH_PAGE_SIZE).map((row): ClientSummary => ({
        id: row.id,
        clientType: row.clientType,
        documentType: row.documentType,
        documentNumber: row.documentNumber,
        displayName: row.displayName,
        phone: row.phone,
        email: row.email ?? null,
      })),
      hasMore: rows.length > SEARCH_PAGE_SIZE,
    };
  }

  async getById(clientId: string): Promise<ClientDetail> {
    if (!isUUID(clientId)) throw notFound();
    const client = await getManager().getRepository(Client).findOneBy({ id: clientId });
    if (!client) throw notFound();
    const vehicles = await getManager().query<VehicleSummary[]>(OWNED_VEHICLES_SQL, [client.id]);
    return toDetail(
      client,
      vehicles.map((row): VehicleSummary => ({
        id: row.id,
        plate: row.plate,
        brand: row.brand,
        model: row.model,
        year: row.year,
      })),
    );
  }

  private async translateCreateError(error: unknown, documentNumber: string): Promise<unknown> {
    const translated = translatePgError(error);
    if (translated?.code !== 'DOCUMENT_ALREADY_EXISTS') return error;
    const existing = await getManager()
      .getRepository(Client)
      .findOne({ select: { id: true }, where: { documentNumber } });
    return new ProblemException(
      translated.status,
      translated.code,
      existing ? { existingId: existing.id } : {},
    );
  }
}
