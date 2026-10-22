import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ProblemException } from '../common/problem-details.filter.js';
import { translatePgError } from '../database/pg-errors.js';
import { getManager, getTenantContext } from '../database/tenant-context.js';
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

const CREATE_SAVEPOINT = 'client_create';

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
    await manager.query(`SAVEPOINT ${CREATE_SAVEPOINT}`);
    let id: string;
    try {
      const result = await manager.getRepository(Client).insert(values);
      id = (result.identifiers[0] as Pick<Client, 'id'>).id;
      await manager.query(`RELEASE SAVEPOINT ${CREATE_SAVEPOINT}`);
    } catch (error: unknown) {
      await manager.query(`ROLLBACK TO SAVEPOINT ${CREATE_SAVEPOINT}`);
      throw await this.translateCreateError(error, dto.documentNumber);
    }
    return this.getById(id);
  }

  async getById(clientId: string): Promise<ClientDetail> {
    if (!isUUID(clientId)) throw notFound();
    const client = await getManager().getRepository(Client).findOneBy({ id: clientId });
    if (!client) throw notFound();
    // Vehicles arrive with the vehicles table (PR2).
    return toDetail(client, []);
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
