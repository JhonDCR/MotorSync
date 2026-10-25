import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defer, lastValueFrom, type Observable } from 'rxjs';
import { DataSource } from 'typeorm';
import { ALLOW_PENDING_PASSWORD_CHANGE_KEY } from '../auth/allow-pending-password-change.decorator.js';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ProblemException } from '../common/problem-details.filter.js';
import type { SupportAgent, SupportRequest } from './support-agent.js';
import { SUPPORT_AREA_KEY } from './support-area.decorator.js';
import { supportStorage } from './support-context.js';
import { SupportSessionValidator } from './support-session-validator.js';

/**
 * Wraps each request of the support panel in one transaction with no workshop pinned (research
 * R3, R4, R9): it never executes set_config('app.tenant_id', ...). Only acts on @SupportArea()
 * routes that are not @Public(); for anything else it calls next.handle() without a QueryRunner.
 * It validates the support session before the handler, replaces name and mustChangePassword with
 * the database values, enforces the pending password change and publishes supportStorage.
 *
 * A temporary password that expired is revoked in a transaction of its own, after releasing the
 * connection (same pattern as TenantTransactionInterceptor in the 002, research R7).
 */
@Injectable()
export class SupportTransactionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SupportTransactionInterceptor.name);

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SupportSessionValidator)
    private readonly sessionValidator: SupportSessionValidator,
  ) {}

  // Same return type as NestInterceptor.intercept, although this implementation is synchronous.
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    if (this.metadata<boolean>(SUPPORT_AREA_KEY, context) !== true) {
      return next.handle();
    }
    if (this.metadata<boolean>(IS_PUBLIC_KEY, context) === true) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<SupportRequest>();
    const tokenAgent = request.supportAgent;
    if (!tokenAgent) throw new UnauthorizedException();
    const ip = request.ip ?? null;

    return defer(async () => {
      const runner = this.dataSource.createQueryRunner();
      let revokeExpiredTemporary = false;
      let agent = tokenAgent;
      try {
        await runner.connect();
        await runner.startTransaction();
        const state = await this.sessionValidator.validate(
          runner.manager,
          tokenAgent,
        );
        agent = {
          id: tokenAgent.id,
          sessionId: tokenAgent.sessionId,
          name: state.name,
          mustChangePassword: state.mustChangePassword,
        };
        request.supportAgent = agent;
        this.authorize(context, agent);
        const result = await supportStorage.run(
          { manager: runner.manager, agent, ip },
          () => lastValueFrom(next.handle(), { defaultValue: undefined }),
        );
        await runner.commitTransaction();
        return result;
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        revokeExpiredTemporary = isTemporaryPasswordExpired(error);
        throw error;
      } finally {
        // The revocation runs only after the release: asking the pool for a second connection
        // while holding the first one can exhaust it (T049 of the 002).
        await runner.release();
        if (revokeExpiredTemporary) {
          await this.revokeExpiredTemporarySession(agent);
        }
      }
    });
  }

  private authorize(context: ExecutionContext, agent: SupportAgent): void {
    if (
      agent.mustChangePassword === true &&
      this.metadata<boolean>(ALLOW_PENDING_PASSWORD_CHANGE_KEY, context) !==
        true
    ) {
      throw new ProblemException(403, 'PASSWORD_CHANGE_REQUIRED');
    }
  }

  /**
   * Research R4, FR-009: revokes the support session in its own transaction, without a workshop.
   * A failure is logged (no user data) and the 401 TEMPORARY_PASSWORD_EXPIRED is kept; the next
   * request detects the expiry again.
   */
  private async revokeExpiredTemporarySession(
    agent: SupportAgent,
  ): Promise<void> {
    try {
      const runner = this.dataSource.createQueryRunner();
      try {
        await runner.connect();
        await runner.startTransaction();
        await runner.query(
          `UPDATE support_sessions SET revoked_at = now(), revoke_reason = 'temp_password_expired'
            WHERE id = $1 AND support_account_id = $2 AND revoked_at IS NULL`,
          [agent.sessionId, agent.id],
        );
        await runner.commitTransaction();
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        throw error;
      } finally {
        await runner.release();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Could not revoke a support session with an expired temporary password: ${reason}`,
      );
    }
  }

  private metadata<T>(key: string, context: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T | undefined>(key, [
      context.getHandler(),
      context.getClass(),
    ]);
  }
}

/** 401 TEMPORARY_PASSWORD_EXPIRED: from SupportSessionValidator or from the password handler. */
function isTemporaryPasswordExpired(error: unknown): boolean {
  return (
    error instanceof ProblemException &&
    error.code === 'TEMPORARY_PASSWORD_EXPIRED'
  );
}
