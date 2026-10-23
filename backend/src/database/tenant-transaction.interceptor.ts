import {
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defer, lastValueFrom, type Observable } from 'rxjs';
import { DataSource, type EntityManager } from 'typeorm';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY } from '../auth/allow-pending-password-change.decorator.js';
import type { AuthRole, AuthUser, AuthenticatedRequest } from '../auth/auth-user.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { SessionValidator } from '../auth/session-validator.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { tenantStorage } from './tenant-context.js';

/**
 * Wraps each request in one transaction with the tenant of the verified token pinned through
 * set_config('app.tenant_id', ..., true) as its first statement (principle I, research R1).
 * Then, for tokens with a session (research R6, R7, R8): validates the session, replaces role,
 * name and mustChangePassword with the database values, enforces the pending password change
 * and @Roles() with the current role. @Public() routes get no transaction at all (research R2).
 * Together with tenant-context.ts, the only place that uses the DataSource directly.
 *
 * Reflector and SessionValidator are optional so that `new TenantTransactionInterceptor(ds)`
 * keeps the 001 behaviour; a token with `sid` and no validator fails closed (SESSION_REVOKED).
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Optional() @Inject(Reflector) private readonly reflector?: Reflector,
    @Optional() @Inject(SessionValidator) private readonly sessionValidator?: SessionValidator,
  ) {}

  // Same return type as NestInterceptor.intercept, although this implementation is synchronous.
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    if (this.metadata<boolean>(IS_PUBLIC_KEY, context) === true) return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const tokenUser = request.user;
    const ip = request.ip ?? null;
    if (!tokenUser) throw new UnauthorizedException();

    return defer(async () => {
      const runner = this.dataSource.createQueryRunner();
      try {
        await runner.connect();
        await runner.startTransaction();
        await runner.query("SELECT set_config('app.tenant_id', $1, true)", [tokenUser.tenantId]);
        const user = await this.currentUser(runner.manager, tokenUser);
        request.user = user;
        this.authorize(context, user);
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

  /** The token user, refreshed from the database when the token carries a session. */
  private async currentUser(
    manager: EntityManager,
    user: AuthUser,
  ): Promise<AuthUser> {
    if (user.sessionId === undefined) return user;
    if (!this.sessionValidator) throw new ProblemException(401, 'SESSION_REVOKED');
    const state = await this.sessionValidator.validate(manager, user);
    return {
      ...user,
      role: state.role,
      name: state.name,
      mustChangePassword: state.mustChangePassword,
    };
  }

  private authorize(context: ExecutionContext, user: AuthUser): void {
    if (
      user.mustChangePassword === true &&
      this.metadata<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, context) !== true
    ) {
      throw new ProblemException(403, 'PASSWORD_CHANGE_REQUIRED');
    }
    const roles = this.metadata<AuthRole[]>(ROLES_KEY, context);
    if (roles && !roles.includes(user.role)) throw new ProblemException(403, 'FORBIDDEN');
  }

  private metadata<T>(key: string, context: ExecutionContext): T | undefined {
    return this.reflector?.getAllAndOverride<T | undefined>(key, [
      context.getHandler(),
      context.getClass(),
    ]);
  }
}
