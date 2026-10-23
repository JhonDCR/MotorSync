import { SetMetadata } from '@nestjs/common';
import type { AuthRole } from './auth-user.js';

export const ROLES_KEY = 'roles';

/**
 * Roles allowed on a handler or controller (research R8). Checked by TenantTransactionInterceptor
 * against the role read from the database, after the session check; otherwise 403 FORBIDDEN.
 */
export const Roles = (...roles: AuthRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
