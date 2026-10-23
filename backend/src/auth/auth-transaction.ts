import type { DataSource, EntityManager } from 'typeorm';
import { tenantStorage } from '../database/tenant-context.js';
import type { AuthUser } from './auth-user.js';

/** Transaction of a @Public() auth route, opened without a tenant (research R2). */
export interface AuthTransaction {
  /** Manager of the transaction. Before asTenant() or pinTenant() RLS shows no tenant rows. */
  manager: EntityManager;
  /**
   * Pins `app.tenant_id` with a tenant the DATABASE returned (an auth_* function), without
   * publishing a request context: for work that only uses `manager` (refresh, logout).
   */
  pinTenant(tenantId: string): Promise<void>;
  /**
   * Pins `app.tenant_id` with the tenant the DATABASE returned for a verified credential (never
   * one sent by the client) and runs `work` with tenantStorage published, so getManager() and
   * AuditService behave as in an authenticated request.
   */
  asTenant<T>(user: AuthUser, work: () => Promise<T>): Promise<T>;
}

/**
 * Runs `fn` in one transaction for the public auth routes (research R2). TenantTransactionInterceptor
 * opens none on @Public() routes; this helper does: no tenant at first, so only the SECURITY DEFINER
 * auth_* functions can resolve the identity; then asTenant() pins the tenant they returned.
 * Commits if `fn` resolves, rolls back if it throws. Together with the interceptor and
 * tenant-context.ts, the only places that use the DataSource directly.
 */
export async function withAuthTransaction<T>(
  dataSource: DataSource,
  ip: string | null,
  fn: (tx: AuthTransaction) => Promise<T>,
): Promise<T> {
  const runner = dataSource.createQueryRunner();
  try {
    await runner.connect();
    await runner.startTransaction();
    const manager = runner.manager;
    const pinTenant = async (tenantId: string): Promise<void> => {
      await manager.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    };
    const tx: AuthTransaction = {
      manager,
      pinTenant,
      async asTenant<U>(user: AuthUser, work: () => Promise<U>): Promise<U> {
        await pinTenant(user.tenantId);
        return tenantStorage.run({ manager, tenantId: user.tenantId, user, ip }, work);
      },
    };
    const result = await fn(tx);
    await runner.commitTransaction();
    return result;
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}
