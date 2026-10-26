import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProblemException } from '../common/problem-details.filter.js';
import { withAuthTransaction } from './auth-transaction.js';

/** Fixed floor of POST /auth/forgot-password, measured from the start of the request (R7). */
export const HELP_RESPONSE_FLOOR_MS = 400;

/** DI token of the clock, so tests can replace it without touching real time (R7). */
export const FORGOT_PASSWORD_CLOCK = 'FORGOT_PASSWORD_CLOCK';

/** Clock of the floor: `now` in milliseconds and an awaitable delay. */
export interface ForgotPasswordClock {
  now(): number;
  wait(ms: number): Promise<void>;
}

/**
 * Real clock: monotonic `performance.now` and `setTimeout`. Node timers can fire
 * up to ~1 ms early against `performance.now` (cached, ms-rounded loop clock), so
 * `wait` re-arms until the monotonic target is actually reached.
 */
export const SYSTEM_FORGOT_PASSWORD_CLOCK: ForgotPasswordClock = {
  now: () => performance.now(),
  wait: (ms) => {
    const target = performance.now() + ms;
    return new Promise<void>((resolve) => {
      const tick = (): void => {
        const left = target - performance.now();
        if (left <= 0) {
          resolve();
          return;
        }
        setTimeout(tick, Math.max(1, Math.ceil(left)));
      };
      tick();
    });
  },
};

interface OutcomeRow {
  outcome?: unknown;
}

/**
 * Single path of "¿Olvidaste tu contraseña?" (research R7, FR-003). One call to
 * `support_request_help(email, origin_hash)` inside `withAuthTransaction`, with no tenant: the
 * SECURITY DEFINER function decides throttle and ticket in the same statement, so an existing and
 * a missing email take the same path and cannot be told apart.
 *
 * The response is held until `HELP_RESPONSE_FLOOR_MS` has elapsed since `startedAt` on every path
 * (202, 429, unexpected outcome and database error): if the database is faster, the floor removes
 * the timing difference; if it is slower, the request resolves as soon as it finishes. The floor is
 * also kept on 500 so errors do not open a side channel.
 *
 * `origin_hash` is the SHA-256 hex of `req.ip` (research R8): the throttle table never stores the
 * IP in clear, and this service never logs the email.
 */
@Injectable()
export class ForgotPasswordService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Optional()
    @Inject(FORGOT_PASSWORD_CLOCK)
    private readonly clock: ForgotPasswordClock = SYSTEM_FORGOT_PASSWORD_CLOCK,
  ) {}

  /** Applies the help request for `email`; resolves on 202, throws ProblemException on 429. */
  async request(
    email: string,
    ip: string | null,
    startedAt: number,
  ): Promise<void> {
    const originHash = createHash('sha256')
      .update(ip ?? '')
      .digest('hex');

    let failed = false;
    let failure: unknown;
    let outcome: unknown;
    try {
      outcome = await withAuthTransaction(this.dataSource, ip, async (tx) => {
        const rows = (await tx.manager.query(
          'SELECT support_request_help($1, $2) AS outcome',
          [email, originHash],
        )) as OutcomeRow[];
        return rows[0]?.outcome;
      });
    } catch (error) {
      failed = true;
      failure = error;
    }

    const remaining = HELP_RESPONSE_FLOOR_MS - (this.clock.now() - startedAt);
    if (remaining > 0) await this.clock.wait(remaining);

    if (failed) throw failure;
    if (outcome === 'rate_limited')
      throw new ProblemException(429, 'HELP_RATE_LIMITED');
    if (outcome === 'accepted') return;
    throw new Error(
      `support_request_help returned an unexpected outcome: ${String(outcome)}`,
    );
  }
}
