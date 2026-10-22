import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { defer, lastValueFrom, type Observable } from 'rxjs';
import { DataSource } from 'typeorm';
import type { AuthenticatedRequest } from '../auth/auth-user.js';
import { tenantStorage } from './tenant-context.js';

/**
 * Wraps each request in one transaction with the tenant of the verified token pinned through
 * set_config('app.tenant_id', ..., true) as its first statement (principle I, research R1).
 * Together with tenant-context.ts, the only place that uses the DataSource directly.
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // Same return type as NestInterceptor.intercept, although this implementation is synchronous.
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { user } = request;
    const ip = request.ip ?? null;
    if (!user) throw new UnauthorizedException();

    return defer(async () => {
      const runner = this.dataSource.createQueryRunner();
      try {
        await runner.connect();
        await runner.startTransaction();
        await runner.query("SELECT set_config('app.tenant_id', $1, true)", [user.tenantId]);
        const result = await tenantStorage.run(
          { manager: runner.manager, tenantId: user.tenantId, user, ip },
          () => lastValueFrom(next.handle(), { defaultValue: undefined }),
        );
        await runner.commitTransaction();
        return result;
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    });
  }
}
