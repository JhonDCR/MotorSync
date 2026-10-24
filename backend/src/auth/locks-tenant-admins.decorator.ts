import { SetMetadata } from '@nestjs/common';

export const LOCKS_TENANT_ADMINS_KEY = 'locksTenantAdmins';

/**
 * Advisory lock of the workshop that serializes every change of role, status or password of its
 * accounts (research R8). Transaction-scoped: released on commit or rollback. app.tenant_id must
 * already be pinned (set_config is the first statement of the request).
 */
export const TENANT_ADMINS_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtextextended('users-admins:' || app_current_tenant()::text, 0))";

/**
 * Shared form of the same lock, taken by the transaction of login that opens the session
 * (research R8, US4-AC21): logins do not block each other, they only wait for a mutation in
 * progress (or make it wait), so a reset or change of password always sees the new session.
 */
export const TENANT_ADMINS_SHARED_LOCK_SQL =
  "SELECT pg_advisory_xact_lock_shared(hashtextextended('users-admins:' || app_current_tenant()::text, 0))";

/**
 * Marks a handler whose request must hold the advisory lock of the workshop (research R8): the
 * /users mutations of role, status or password and POST /auth/password, which lock sessions of
 * an account other than their own session row.
 * TenantTransactionInterceptor takes it right after set_config and BEFORE SessionValidator, so
 * the lock order of the request is: advisory lock -> own session row -> target sessions -> users.
 * It is the only place that takes the lock: UsersService relies on it.
 */
export const LocksTenantAdmins = (): MethodDecorator & ClassDecorator =>
  SetMetadata(LOCKS_TENANT_ADMINS_KEY, true);
