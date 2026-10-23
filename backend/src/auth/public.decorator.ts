import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a handler or controller as public (research R2): JwtAuthGuard lets it through without a
 * token and TenantTransactionInterceptor opens no transaction nor pins a tenant.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
