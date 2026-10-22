import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { BodyType } from '../common/identifiers/plate.js';

/** Table `vehicles` (data-model.md). The schema is owned by the migrations, never synchronized. */
@Entity({ name: 'vehicles' })
export class Vehicle {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** DEFAULT app_current_tenant(): the tenant pinned in the request transaction. */
  @Column({
    type: 'uuid',
    name: 'tenant_id',
    default: () => 'app_current_tenant()',
  })
  tenantId: string;

  /** Composite FK (tenant_id, owner_client_id) → clients (tenant_id, id). */
  @Column({ type: 'uuid', name: 'owner_client_id' })
  ownerClientId: string;

  @Column({ type: 'text', name: 'plate', collation: 'C' })
  plate: string;

  @Column({ type: 'text', name: 'vin', collation: 'C', nullable: true })
  vin: string | null;

  @Column({ type: 'text', name: 'brand' })
  brand: string;

  @Column({ type: 'text', name: 'model' })
  model: string;

  @Column({ type: 'smallint', name: 'year' })
  year: number;

  @Column({ type: 'text', name: 'color' })
  color: string;

  @Column({ type: 'text', name: 'body_type' })
  bodyType: BodyType;

  @Column({ type: 'integer', name: 'initial_mileage' })
  initialMileage: number;

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
