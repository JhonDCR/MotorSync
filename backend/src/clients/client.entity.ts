import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type ClientType = 'natural' | 'company';
export type DocumentType = 'cedula' | 'ruc' | 'passport';

/** Table `clients` (data-model.md). The schema is owned by the migrations, never synchronized. */
@Entity({ name: 'clients' })
export class Client {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** DEFAULT app_current_tenant(): the tenant pinned in the request transaction. */
  @Column({ type: 'uuid', name: 'tenant_id', default: () => 'app_current_tenant()' })
  tenantId: string;

  @Column({ type: 'text', name: 'client_type' })
  clientType: ClientType;

  @Column({ type: 'text', name: 'document_type' })
  documentType: DocumentType;

  @Column({ type: 'text', name: 'document_number', collation: 'C' })
  documentNumber: string;

  @Column({ type: 'text', name: 'first_names', nullable: true })
  firstNames: string | null;

  @Column({ type: 'text', name: 'last_names', nullable: true })
  lastNames: string | null;

  @Column({ type: 'text', name: 'business_name', nullable: true })
  businessName: string | null;

  /** Generated column (STORED). */
  @Column({ type: 'text', name: 'display_name', insert: false, update: false })
  displayName: string;

  /** Generated column (STORED): immutable_unaccent(lower(display name)). */
  @Column({ type: 'text', name: 'search_name', insert: false, update: false })
  searchName: string;

  @Column({ type: 'text', name: 'phone' })
  phone: string;

  @Column({ type: 'text', name: 'email', nullable: true })
  email: string | null;

  /** Optimistic lock handled explicitly in UPDATE ... WHERE version = $n (research R5). */
  @Column({ type: 'integer', name: 'version', default: 1 })
  version: number;

  @Column({ type: 'timestamptz', name: 'created_at', default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy: string;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'now()' })
  updatedAt: Date;

  @Column({ type: 'uuid', name: 'updated_by' })
  updatedBy: string;

  @Column({ type: 'text', name: 'updated_by_name' })
  updatedByName: string;
}
