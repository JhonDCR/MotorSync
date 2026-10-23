import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

interface LockedUntilRow {
  locked_until: Date | null;
}

interface SuccessRow {
  ok: boolean;
}

/**
 * Lock after failed logins (FR-009, research R4), keyed by the SHA-256 of the normalized email
 * (`emailHash`). login_attempts is only reachable through the SECURITY DEFINER functions.
 */
@Injectable()
export class LoginThrottleService {
  /** Current lock of the email (exists or not), or null. */
  async lockedUntil(manager: EntityManager, emailHash: string): Promise<Date | null> {
    const rows = (await manager.query('SELECT auth_login_locked_until($1) AS locked_until', [
      emailHash,
    ])) as LockedUntilRow[];
    return rows[0]?.locked_until ?? null;
  }

  /** Counts one failure atomically; returns the lock reached with it (or before), or null. */
  async recordFailure(manager: EntityManager, emailHash: string): Promise<Date | null> {
    const rows = (await manager.query('SELECT auth_record_login_failure($1) AS locked_until', [
      emailHash,
    ])) as LockedUntilRow[];
    return rows[0]?.locked_until ?? null;
  }

  /** Clears the counter; false if a lock is in force right now (race with other failures). */
  async recordSuccess(manager: EntityManager, emailHash: string): Promise<boolean> {
    const rows = (await manager.query('SELECT auth_record_login_success($1) AS ok', [
      emailHash,
    ])) as SuccessRow[];
    return rows[0]?.ok === true;
  }
}
