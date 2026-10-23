import {
  Inject,
  Injectable,
  Logger,
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
import { revokeSessionApart } from '../auth/sessions.service.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { AfterReleaseError } from './after-release.js';
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
  private readonly logger = new Logger(TenantTransactionInterceptor.name);

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
      let revokeExpiredTemporary = false;
      let afterRelease: (() => Promise<unknown>) | undefined;
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
        revokeExpiredTemporary = isTemporaryPasswordExpired(error);
        if (error instanceof AfterReleaseError) {
          afterRelease = error.afterRelease;
          throw error.response;
        }
        throw error;
      } finally {
        // Work committed apart runs only now, after the rollback and the release: asking the pool
        // for a second connection while holding the first one (with the session row locked) can
        // exhaust it and hang every request of the session (T049).
        await runner.release();
        if (revokeExpiredTemporary) await this.revokeExpiredTemporarySession(tokenUser);
        // Not caught: if it fails the client gets a 500 (e.g. a failure that could not be counted).
        if (afterRelease) await afterRelease();
      }
    });
  }

  /**
   * Research R7: revokes the session in its own transaction. A failure is logged (no user data)
   * and the 401 TEMPORARY_PASSWORD_EXPIRED is kept; the next request detects the expiry again.
   */
  private async revokeExpiredTemporarySession(user: AuthUser): Promise<void> {
    try {
      await revokeSessionApart(this.dataSource, user, 'temp_password_expired');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not revoke a session with an expired temporary password: ${reason}`);
    }
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

/** 401 TEMPORARY_PASSWORD_EXPIRED: from SessionValidator or from POST /auth/password (R7). */
function isTemporaryPasswordExpired(error: unknown): boolean {
  return error instanceof ProblemException && error.code === 'TEMPORARY_PASSWORD_EXPIRED';
}
