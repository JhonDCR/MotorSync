import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ACCESS_TOKEN_TTL_SECONDS } from '../auth/access-token.service.js';
import { withAuthTransaction } from '../auth/auth-transaction.js';
import type { ChangePasswordDto } from '../auth/dto/change-password.dto.js';
import { LoginThrottleService } from '../auth/login-throttle.service.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { emailHash } from '../common/identifiers/email.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { AfterReleaseError } from '../database/after-release.js';
import { SupportAccessTokenService } from './support-access-token.service.js';
import { getSupportContext } from './support-context.js';
import type { SupportLoginDto } from './dto/support-login.dto.js';
import { SupportSessionsService } from './support-sessions.service.js';

/** Contract `SupportAgent`. */
export interface SupportAgentInfo {
  id: string;
  name: string;
  email: string;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
}

/** Contract `SupportSessionResponse` (the refresh token never goes in a body). */
export interface SupportSessionResponse {
  accessToken: string;
  expiresIn: number;
  agent: SupportAgentInfo;
}

/** What the controller needs: the body and the refresh token for the ms_support_refresh cookie. */
export interface IssuedSupportSession {
  body: SupportSessionResponse;
  refreshToken: string;
}

/** Raw row of the account lookup of POST /support/auth/login. */
interface LoginAccountRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  status: string;
  must_change_password: boolean;
  temp_password_expires_at: Date | null;
  /** temp_password_expires_at <= now() with the clock of PostgreSQL; null without a temporary. */
  temp_password_expired: boolean | null;
}

/** Raw row of the FOR SHARE re-check before opening the session. */
interface RecheckAccountRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  status: string;
  must_change_password: boolean;
  temp_password_expires_at: Date | null;
}

/** Raw row of the account of the session, for POST /support/auth/password. */
interface PasswordAccountRow {
  email: string;
  password_hash: string;
  must_change_password: boolean;
  temp_password_expired: boolean | null;
}

/** Raw row of GET /support/auth/me. */
interface CurrentAccountRow {
  email: string;
  must_change_password: boolean;
  temp_password_expires_at: Date | null;
}

/** Current values of the support account that the access token and the body carry. */
interface AccountState {
  id: string;
  name: string;
  email: string;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
}

function currentPasswordIncorrect(): ProblemException {
  return new ProblemException(400, 'CURRENT_PASSWORD_INCORRECT', {
    errors: [
      {
        field: 'currentPassword',
        code: 'CURRENT_PASSWORD_INCORRECT',
        message: 'La contraseña actual no es correcta',
      },
    ],
  });
}

function samePassword(): ProblemException {
  return new ProblemException(400, 'VALIDATION_ERROR', {
    errors: [
      {
        field: 'newPassword',
        code: 'SAME_PASSWORD',
        message: 'La nueva contraseña debe ser distinta de la actual',
      },
    ],
  });
}

/**
 * Access of the support panel (US2): login, refresh, logout, current session and change of the own
 * password. It follows the 002 order (research R4) but only looks at support_accounts, never at
 * `users` (research R3): workshop credentials cannot open a support session and vice versa.
 * Public routes use withAuthTransaction without pinning a workshop; me and password run in the
 * transaction of SupportTransactionInterceptor.
 */
@Injectable()
export class SupportAuthService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(LoginThrottleService)
    private readonly throttle: LoginThrottleService,
    @Inject(SupportSessionsService)
    private readonly sessions: SupportSessionsService,
    @Inject(SupportAccessTokenService)
    private readonly accessTokens: SupportAccessTokenService,
  ) {}

  /**
   * POST /support/auth/login (US2-AC3, US2-AC4): lock check, account lookup, ALWAYS one scrypt
   * verification (dummy hash for an unknown email; the real one for an inactive account), failure
   * or success recording, and only then the FOR SHARE re-check and the session. Unknown email,
   * wrong password and inactive account give the same 401 (FR-008). A correct but expired
   * temporary password gives 401 TEMPORARY_PASSWORD_EXPIRED without counting a failure nor
   * opening a session (FR-009).
   */
  async login(
    dto: SupportLoginDto,
    ip: string | null,
  ): Promise<IssuedSupportSession> {
    const hash = emailHash(dto.email);
    const lookup = await withAuthTransaction(
      this.dataSource,
      ip,
      async (tx) => {
        const lockedUntil = await this.throttle.lockedUntil(tx.manager, hash);
        if (lockedUntil !== null) return null;
        return { account: await findAccount(tx.manager, dto.email) };
      },
    );
    if (lookup === null) throw new ProblemException(429, 'ACCOUNT_LOCKED');

    const { account } = lookup;
    const valid = account
      ? (await this.hasher.verify(dto.password, account.password_hash)) &&
        account.status === 'active'
      : await this.hasher.verifyAgainstDummy(dto.password);

    if (!valid || !account) {
      // Committed on its own: the failure must count even though the request fails.
      await withAuthTransaction(this.dataSource, ip, (tx) =>
        this.throttle.recordFailure(tx.manager, hash),
      );
      throw new ProblemException(401, 'INVALID_CREDENTIALS');
    }

    // Only reached with the correct password, so the code reveals nothing to a guesser.
    if (
      account.must_change_password &&
      account.temp_password_expired === true
    ) {
      throw new ProblemException(401, 'TEMPORARY_PASSWORD_EXPIRED');
    }

    const issued = await withAuthTransaction(
      this.dataSource,
      ip,
      async (tx) => {
        // Research R4: scrypt ran outside any transaction, so a reset, change of password or
        // deactivation may have committed meanwhile. FOR SHARE conflicts with the FOR UPDATE of
        // the operations procedure, and the hash and status are re-checked before opening.
        const rows = (await tx.manager.query(
          `SELECT id, name, email, password_hash, status, must_change_password,
                temp_password_expires_at
           FROM support_accounts
          WHERE id = $1 AND password_hash = $2 AND status = 'active'
            FOR SHARE`,
          [account.id, account.password_hash],
        )) as RecheckAccountRow[];
        const row = rows[0];
        if (!row) return null;
        // false: another attempt locked the email in the meantime.
        if (!(await this.throttle.recordSuccess(tx.manager, hash))) {
          throw new ProblemException(429, 'ACCOUNT_LOCKED');
        }
        const state = toAccountState(row);
        const { sessionId, refreshToken } = await this.sessions.create(
          tx.manager,
          row.id,
          ip,
        );
        return {
          refreshToken,
          body: await this.sessionResponse(state, sessionId),
        };
      },
    );
    if (issued === null) {
      // The verified password is no longer the current one: a failure like a wrong password.
      await withAuthTransaction(this.dataSource, ip, (tx) =>
        this.throttle.recordFailure(tx.manager, hash),
      );
      throw new ProblemException(401, 'INVALID_CREDENTIALS');
    }
    return issued;
  }

  /**
   * POST /support/auth/refresh (US2-AC9, research R4). The identity comes only from the refresh
   * token. Failures that change data (reuse → revocation of the whole session) are committed
   * before throwing: the ProblemException is returned from the transaction and thrown outside.
   */
  async refresh(
    refreshToken: string | undefined,
    ip: string | null,
  ): Promise<IssuedSupportSession> {
    if (refreshToken === undefined) {
      throw new ProblemException(401, 'SESSION_EXPIRED');
    }
    const outcome = await withAuthTransaction(
      this.dataSource,
      ip,
      async (tx): Promise<IssuedSupportSession | ProblemException> => {
        const found = await this.sessions.findRefreshToken(
          tx.manager,
          refreshToken,
        );
        if (!found) return new ProblemException(401, 'SESSION_EXPIRED');

        const session = await this.sessions.lockSession(
          tx.manager,
          found.sessionId,
        );
        if (!session || session.revoked || session.accountStatus !== 'active') {
          return new ProblemException(401, 'SESSION_REVOKED');
        }
        if (session.inactive)
          return new ProblemException(401, 'SESSION_EXPIRED');

        const state = await this.sessions.tokenState(tx.manager, found.tokenId);
        if (state === 'recently_rotated') {
          return new ProblemException(409, 'REFRESH_CONFLICT');
        }
        if (state === 'reused') {
          await this.sessions.revoke(
            tx.manager,
            found.sessionId,
            'refresh_reuse',
          );
          return new ProblemException(401, 'SESSION_REVOKED');
        }

        const account: AccountState = {
          id: session.accountId,
          name: session.name,
          email: session.email,
          mustChangePassword: session.mustChangePassword,
          temporaryPasswordExpiresAt: session.temporaryPasswordExpiresAt,
        };
        const nextToken = await this.sessions.rotate(
          tx.manager,
          found.tokenId,
          found.sessionId,
        );
        return {
          refreshToken: nextToken,
          body: await this.sessionResponse(account, found.sessionId),
        };
      },
    );
    if (outcome instanceof ProblemException) throw outcome;
    return outcome;
  }

  /**
   * POST /support/auth/logout (US2-AC9): revokes the session of the refresh token, if any.
   * Idempotent: an unknown cookie or an already closed session changes nothing.
   */
  async logout(
    refreshToken: string | undefined,
    ip: string | null,
  ): Promise<void> {
    if (refreshToken === undefined) return;
    await withAuthTransaction(this.dataSource, ip, async (tx) => {
      const found = await this.sessions.findRefreshToken(
        tx.manager,
        refreshToken,
      );
      if (!found) return;
      await this.sessions.revoke(tx.manager, found.sessionId, 'logout');
    });
  }

  /** GET /support/auth/me: current values of the account of the session. */
  async me(): Promise<{ agent: SupportAgentInfo }> {
    const { manager, agent } = getSupportContext();
    const rows = (await manager.query(
      `SELECT email, must_change_password, temp_password_expires_at
         FROM support_accounts WHERE id = $1`,
      [agent.id],
    )) as CurrentAccountRow[];
    const row = rows[0];
    if (!row) throw new ProblemException(401, 'SESSION_REVOKED');
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        email: row.email,
        mustChangePassword: agent.mustChangePassword,
        temporaryPasswordExpiresAt:
          row.temp_password_expires_at?.toISOString() ?? null,
      },
    };
  }

  /**
   * POST /support/auth/password (FR-009): lock check, current password (a wrong one counts as a
   * login failure, committed apart once the request released its connection), SAME_PASSWORD, new
   * hash, end of the temporary password, revocation of the OTHER sessions (FR-027) and a new
   * access token of the same session. An expired temporary password gives 401
   * TEMPORARY_PASSWORD_EXPIRED; SupportTransactionInterceptor revokes the session after the
   * rollback.
   */
  async changePassword(
    dto: ChangePasswordDto,
  ): Promise<SupportSessionResponse> {
    const { manager, agent, ip } = getSupportContext();
    const sessionId = agent.sessionId;
    const rows = (await manager.query(
      `SELECT email, password_hash, must_change_password,
              temp_password_expires_at <= now() AS temp_password_expired
         FROM support_accounts WHERE id = $1 AND status = 'active'`,
      [agent.id],
    )) as PasswordAccountRow[];
    const account = rows[0];
    if (!account) throw new ProblemException(401, 'SESSION_REVOKED');
    if (
      account.must_change_password &&
      account.temp_password_expired === true
    ) {
      throw new ProblemException(401, 'TEMPORARY_PASSWORD_EXPIRED');
    }

    const hash = emailHash(account.email);
    if ((await this.throttle.lockedUntil(manager, hash)) !== null) {
      throw new ProblemException(429, 'ACCOUNT_LOCKED');
    }
    if (
      !(await this.hasher.verify(dto.currentPassword, account.password_hash))
    ) {
      // Committed on its own so the failure counts although the request rolls back, and only
      // once the interceptor released the connection of the request.
      throw new AfterReleaseError(currentPasswordIncorrect(), () =>
        withAuthTransaction(this.dataSource, ip, (tx) =>
          this.throttle.recordFailure(tx.manager, hash),
        ),
      );
    }
    if (dto.newPassword === dto.currentPassword) throw samePassword();

    const newHash = await this.hasher.hash(dto.newPassword);
    // The stored hash in the WHERE: a concurrent change in between makes this one fail.
    const [, changed] = (await manager.query(
      `UPDATE support_accounts
          SET password_hash = $2, must_change_password = false,
              temp_password_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND password_hash = $3`,
      [agent.id, newHash, account.password_hash],
    )) as [unknown, number];
    if (changed !== 1) throw currentPasswordIncorrect();
    await this.sessions.revokeOthers(
      manager,
      agent.id,
      sessionId,
      'password_changed',
    );

    const state: AccountState = {
      id: agent.id,
      name: agent.name,
      email: account.email,
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
    };
    return this.sessionResponse(state, sessionId);
  }

  /** SupportSessionResponse with a new access token of `sessionId`. */
  private async sessionResponse(
    account: AccountState,
    sessionId: string,
  ): Promise<SupportSessionResponse> {
    const accessToken = await this.accessTokens.issue({
      id: account.id,
      sessionId,
      name: account.name,
      mustChangePassword: account.mustChangePassword,
    });
    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      agent: {
        id: account.id,
        name: account.name,
        email: account.email,
        mustChangePassword: account.mustChangePassword,
        temporaryPasswordExpiresAt:
          account.temporaryPasswordExpiresAt?.toISOString() ?? null,
      },
    };
  }
}

/** Account of a (normalized) email, active or not: the generic 401 is decided by the caller. */
async function findAccount(
  manager: EntityManager,
  email: string,
): Promise<LoginAccountRow | undefined> {
  const rows = (await manager.query(
    `SELECT id, name, email, password_hash, status, must_change_password,
            temp_password_expires_at, temp_password_expires_at <= now() AS temp_password_expired
       FROM support_accounts WHERE email = $1`,
    [email],
  )) as LoginAccountRow[];
  return rows[0];
}

function toAccountState(row: RecheckAccountRow): AccountState {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    mustChangePassword: row.must_change_password,
    temporaryPasswordExpiresAt: row.temp_password_expires_at,
  };
}
