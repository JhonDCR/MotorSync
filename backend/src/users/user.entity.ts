import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { AuthRole } from '../auth/auth-user.js';

export type UserStatus = 'active' | 'inactive';

/**
 * Table `users` (specs/002-autenticacion/data-model.md).
 * The schema is owned by migrations, never synchronized.
 * `password_hash` is hidden by default from queries (`select: false`).
 */
@Entity({ name: 'users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** DEFAULT app_current_tenant(): the tenant pinned in the request transaction. */
  @Column({ type: 'uuid', name: 'tenant_id', default: () => 'app_current_tenant()' })
  tenantId: string;

  @Column({ type: 'text', name: 'name' })
  name: string;

  @Column({ type: 'text', name: 'email', collation: 'C' })
  email: string;

  @Column({ type: 'text', name: 'password_hash', select: false })
  passwordHash: string;

  @Column({ type: 'text', name: 'role' })
  role: AuthRole;

  @Column({ type: 'text', name: 'status', default: 'active' })
  status: UserStatus;

  @Column({ type: 'boolean', name: 'must_change_password', default: false })
  mustChangePassword: boolean;

  @Column({ type: 'timestamptz', name: 'temp_password_expires_at', nullable: true })
  tempPasswordExpiresAt: Date | null;

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
