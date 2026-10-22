import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager } from 'typeorm';
import type { AuthUser } from '../auth/auth-user.js';

/** Per-request context published by TenantTransactionInterceptor (research R1, R3). */
export interface TenantContext {
  /** Manager of the request transaction, with app.tenant_id already pinned. */
  manager: EntityManager;
  tenantId: string;
  user: AuthUser;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext {
  const context = tenantStorage.getStore();
  if (!context) {
    throw new Error('No tenant context: this code must run inside an authenticated request');
  }
  return context;
}

/** EntityManager of the current request transaction. Throws outside a request. */
export function getManager(): EntityManager {
  return getTenantContext().manager;
}
