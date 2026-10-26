import { Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { TENANT_ADMINS_LOCK_SQL } from '../auth/locks-tenant-admins.decorator.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { applyTemporaryPassword } from '../users/apply-temporary-password.js';
import type { UserStatus } from '../users/user.entity.js';
import { getSupportContext } from './support-context.js';
import type { TicketDetail, TicketSummary } from './support-tickets.service.js';
import { generateTemporaryPassword } from './temporary-password-generator.js';

/** Contract `TemporaryPasswordResponse` (US3-AC2, FR-019). */
export interface TemporaryPasswordResponse {
  temporaryPassword: string;
  temporaryPasswordExpiresAt: string;
  sessionsClosed: number;
  ticket: TicketDetail;
}

/** Raw row of `SELECT * FROM support_lock_open_ticket($1, $2)` (bigint arrives as string). */
interface LockedTicketRow {
  tenant_id: string;
  user_id: string;
  number: string;
  status: string;
}

/** Raw row of `SELECT * FROM support_get_ticket($1, $2)`. */
interface TicketDetailRow {
  ticket_id: string;
  number: string;
  created_at: Date;
  last_requested_at: Date;
  request_count: number;
  email: string;
  account_name: string;
  account_role: string;
  account_status: string;
  workshop_name: string;
  workshop_ruc: string | null;
}

/** Raw row of `SELECT status, must_change_password FROM users WHERE id = $1`. */
interface TargetUserStateRow {
  status: UserStatus;
  must_change_password: boolean;
}

/** Raw row of `SELECT support_resolve_ticket($1, $2, $3, $4) AS resolved_at`. */
interface ResolveTicketRow {
  resolved_at: Date | string;
}

/**
 * Generates a temporary password for the workshop account of an open support ticket and resolves
 * the ticket in a single transaction (US3, research R9).
 *
 * Explicit lock order (research R9, extension of R8 of feature 002):
 *   0. Own `support_sessions` row (`SupportSessionValidator` in `SupportTransactionInterceptor`).
 *   0b. Generate the temporary password and its scrypt hash BEFORE taking any other lock.
 *   1. `support_tickets` row (`FOR UPDATE` via `support_lock_open_ticket`).
 *   2. Check existence (404) and `open` status (409 `TICKET_NOT_OPEN`).
 *   2b. `support_get_ticket` BEFORE pinning a workshop (still in platform context).
 *   3. `set_config('app.tenant_id', <ticket.tenant_id>, true)`.
 *   4. `TENANT_ADMINS_LOCK_SQL` (workshop advisory lock).
 *   5. Read current `status` and `must_change_password` from `users` under RLS (409 `ACCOUNT_INACTIVE` if inactive).
 *   6. `applyTemporaryPassword`: revokes target `user_sessions` -> updates `users` (`updated_by_name = 'Soporte MotorSync (<name>)'`) -> clears `login_attempts`.
 *   7. `AuditService.recordAsSupport` in the pinned workshop's `audit_log`.
 *   8. `support_resolve_ticket` with the trimmed verification note.
 *   9. Return `TemporaryPasswordResponse` (commit in `SupportTransactionInterceptor`).
 *
 * Never publishes `tenantStorage` and never logs the generated temporary password.
 */
@Injectable()
export class SupportPasswordService {
  constructor(
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async generateTemporaryPassword(
    ticketId: string,
    verificationNote: string,
  ): Promise<TemporaryPasswordResponse> {
    assertTicketId(ticketId);
    const trimmedNote = verificationNote.trim();
    const { manager, agent, ip } = getSupportContext();

    // Step 0b: generate the temporary password and its scrypt hash before taking any lock.
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(temporaryPassword);

    // Step 1: lock the ticket row FOR UPDATE in platform context.
    const lockedRows = (await manager.query(
      'SELECT * FROM support_lock_open_ticket($1, $2)',
      [agent.sessionId, ticketId],
    )) as LockedTicketRow[];
    const lockedTicket = lockedRows[0];

    // Step 2: 404 if missing; 409 TICKET_NOT_OPEN if not open.
    if (!lockedTicket) {
      throw new ProblemException(404, 'NOT_FOUND');
    }
    if (lockedTicket.status !== 'open') {
      throw new ProblemException(409, 'TICKET_NOT_OPEN');
    }

    // Step 2b: read ticket summary data while still in platform context (no workshop pinned yet).
    const ticketRows = (await manager.query(
      'SELECT * FROM support_get_ticket($1, $2)',
      [agent.sessionId, ticketId],
    )) as TicketDetailRow[];
    const ticketRow = ticketRows[0];
    if (!ticketRow) {
      throw new ProblemException(404, 'NOT_FOUND');
    }

    // Step 3: pin the workshop from the database ticket row (never from request input).
    await manager.query("SELECT set_config('app.tenant_id', $1, true)", [
      lockedTicket.tenant_id,
    ]);

    // Step 4: acquire the workshop advisory lock (R8 of feature 002).
    await manager.query(TENANT_ADMINS_LOCK_SQL);

    // Step 5: read current status and must_change_password under RLS after acquiring the lock.
    const userRows = (await manager.query(
      'SELECT status, must_change_password FROM users WHERE id = $1',
      [lockedTicket.user_id],
    )) as TargetUserStateRow[];
    const currentUser = userRows[0];
    if (!currentUser) {
      throw new ProblemException(404, 'NOT_FOUND');
    }
    if (currentUser.status === 'inactive') {
      throw new ProblemException(409, 'ACCOUNT_INACTIVE');
    }

    // Step 6: revoke target sessions, update user password, clear login failures.
    const applied = await applyTemporaryPassword({
      manager,
      targetUserId: lockedTicket.user_id,
      passwordHash,
      updatedBy: agent.id,
      updatedByName: `Soporte MotorSync (${agent.name})`,
      previousMustChangePassword: Boolean(currentUser.must_change_password),
    });
    const expiresAtIso = applied.temporaryPasswordExpiresAt.toISOString();

    // Step 7: record in the workshop's audit_log as platform_support.
    await this.audit.recordAsSupport(manager, agent, ip, {
      action: 'user.password_reset_by_support',
      entityType: 'user',
      entityId: lockedTicket.user_id,
      before: { mustChangePassword: Boolean(currentUser.must_change_password) },
      after: {
        mustChangePassword: true,
        temporaryPasswordExpiresAt: expiresAtIso,
        sessionsClosed: applied.sessionsClosed,
        supportTicketNumber: Number(lockedTicket.number),
      },
    });

    // Step 8: resolve the ticket and record the support_ticket_events entry.
    const resolvedRows = (await manager.query(
      'SELECT support_resolve_ticket($1, $2, $3, $4) AS resolved_at',
      [agent.sessionId, ticketId, trimmedNote, ip],
    )) as ResolveTicketRow[];
    const rawResolvedAt = resolvedRows[0]?.resolved_at;
    const resolvedAtIso =
      rawResolvedAt instanceof Date
        ? rawResolvedAt.toISOString()
        : new Date(rawResolvedAt).toISOString();

    // Step 9: build the response with the ticket resolved.
    const summary: TicketSummary = {
      id: ticketRow.ticket_id,
      number: Number(ticketRow.number),
      createdAt: ticketRow.created_at.toISOString(),
      lastRequestedAt: ticketRow.last_requested_at.toISOString(),
      requestCount: Number(ticketRow.request_count),
      account: {
        email: ticketRow.email,
        name: ticketRow.account_name,
        role: ticketRow.account_role,
        status: ticketRow.account_status,
      },
      workshop: {
        name: ticketRow.workshop_name,
        ruc: ticketRow.workshop_ruc,
      },
    };

    const ticket: TicketDetail = {
      ...summary,
      status: 'resolved',
      resolution: {
        verificationNote: trimmedNote,
        resolvedByName: agent.name,
        resolvedAt: resolvedAtIso,
      },
      discard: null,
    };

    return {
      temporaryPassword,
      temporaryPasswordExpiresAt: expiresAtIso,
      sessionsClosed: applied.sessionsClosed,
      ticket,
    };
  }
}

function assertTicketId(ticketId: string): void {
  if (typeof ticketId !== 'string' || !isUUID(ticketId)) {
    throw new ProblemException(404, 'NOT_FOUND');
  }
}
