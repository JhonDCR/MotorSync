import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { DataSource, QueryFailedError, type EntityManager } from 'typeorm';
import { emailHash } from '../common/identifiers/email.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { AfterReleaseError } from '../database/after-release.js';
import { getManager, getTenantContext } from '../database/tenant-context.js';
import { AccessTokenService, ACCESS_TOKEN_TTL_SECONDS } from './access-token.service.js';
import { withAuthTransaction } from './auth-transaction.js';
import { isAuthRole, type AuthRole, type AuthUser } from './auth-user.js';
import type { ChangePasswordDto } from './dto/change-password.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import { TENANT_ADMINS_SHARED_LOCK_SQL } from './locks-tenant-admins.decorator.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionsService, type LockedSession } from './sessions.service.js';

/** Contract `SessionUser`. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: AuthRole;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
}

/** Contract `Workshop`. */
export interface Workshop {
  id: string;
  name: string;
}

/** Contract `SessionResponse` (the refresh token never goes in a body). */
export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
  workshop: Workshop;
}

/** Contract `CurrentSession` (GET /auth/me). */
export interface CurrentSession {
  user: SessionUser;
  workshop: Workshop;
}

/** What the controller needs: the body and the refresh token for the ms_refresh cookie. */
export interface IssuedSession {
  body: SessionResponse;
  refreshToken: string;
}

interface RegisteredRow {
  tenant_id: string;
  user_id: string;
}

/** Raw row of auth_find_user_for_login (pg parses uuid as string and timestamptz as Date). */
interface LoginAccountRow {
  user_id: string;
  tenant_id: string;
  name: string;
  role: string;
  status: string;
  password_hash: string;
  must_change_password: boolean;
  temp_password_expires_at: Date | null;
  /** temp_password_expires_at <= now() with the clock of PostgreSQL; null without a temporary. */
  temp_password_expired: boolean | null;
}

/** Raw row of the account of the session, for POST /auth/password. */
interface PasswordAccountRow {
  email: string;
  password_hash: string;
  must_change_password: boolean;
  temp_password_expired: boolean | null;
}

/** Raw row of GET /auth/me. */
interface CurrentAccountRow {
  id: string;
  name: string;
  email: string;
  role: string;
  must_change_password: boolean;
  temp_password_expires_at: Date | null;
  workshop_name: string;
}

interface WorkshopNameRow {
  name: string;
}

interface AccountState {
  user: AuthUser;
  email: string;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: Date | null;
}

const USERS_EMAIL_KEY = 'users_email_key';
const UNIQUE_VIOLATION = '23505';

function isEmailTaken(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driver = error.driverError as { code?: unknown; constraint?: unknown };
  return driver.code === UNIQUE_VIOLATION && driver.constraint === USERS_EMAIL_KEY;
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
 * Registration, login, session refresh and logout (US1, US2, US3), current session and change of
 * the own password (US5). The workshop always comes from the database, through the SECURITY
 * DEFINER auth_* functions or the authenticated context, never from the request (principle I,
 * research R1, R2).
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(LoginThrottleService) private readonly throttle: LoginThrottleService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AccessTokenService) private readonly accessTokens: AccessTokenService,
  ) {}

  /**
   * POST /auth/register (US1): workshop, first admin, session and refresh token in ONE
   * transaction (FR-004, US1-AC7). tenants_ruc_key is translated by the filter to
   * RUC_ALREADY_REGISTERED; users_email_key becomes the generic REGISTRATION_FAILED (US1-AC5).
   */
  async register(dto: RegisterDto, ip: string | null): Promise<IssuedSession> {
    // Hashed before opening the transaction, so scrypt never holds a connection.
    const passwordHash = await this.hasher.hash(dto.password);
    return withAuthTransaction(this.dataSource, ip, async (tx) => {
      let registered: RegisteredRow;
      try {
        const rows = (await tx.manager.query(
          'SELECT tenant_id, user_id FROM auth_register_workshop($1, $2, $3, $4, $5)',
          [dto.workshopName, dto.ruc, dto.name, dto.email, passwordHash],
        )) as RegisteredRow[];
        registered = rows[0];
      } catch (error) {
        if (isEmailTaken(error)) throw new ProblemException(409, 'REGISTRATION_FAILED');
        throw error;
      }
      const account: AccountState = {
        user: {
          userId: registered.user_id,
          tenantId: registered.tenant_id,
          role: 'admin',
          name: dto.name,
        },
        email: dto.email,
        mustChangePassword: false,
        temporaryPasswordExpiresAt: null,
      };
      return tx.asTenant(account.user, () => this.openSession(account, dto.workshopName));
    });
  }

  /**
   * POST /auth/login (US2), in the order of research R4: lock check, account lookup, ALWAYS one
   * scrypt verification (dummy hash for an unknown email; the real one for an inactive account),
   * failure or success recording, and only then the tenant of the account and the session.
   * Unknown email, wrong password and inactive account give the same 401 (FR-008). A correct but
   * expired temporary password gives 401 TEMPORARY_PASSWORD_EXPIRED without counting a failure
   * nor opening a session (research R7, US5-AC9).
   */
  async login(dto: LoginDto, ip: string | null): Promise<IssuedSession> {
    const hash = emailHash(dto.email);
    const lookup = await withAuthTransaction(this.dataSource, ip, async (tx) => {
      const lockedUntil = await this.throttle.lockedUntil(tx.manager, hash);
      if (lockedUntil !== null) return null;
      return { account: await this.findAccount(tx.manager, dto.email) };
    });
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

    // Only reached with the correct password, so the code reveals nothing to a guesser (R12).
    if (account.must_change_password && account.temp_password_expired === true) {
      throw new ProblemException(401, 'TEMPORARY_PASSWORD_EXPIRED');
    }

    const state = toAccountState(account, dto.email);
    const issued = await withAuthTransaction(this.dataSource, ip, (tx) =>
      tx.asTenant(state.user, async () => {
        // Research R8 (US4-AC21): scrypt ran outside any transaction, so a reset, change of
        // password or deactivation may have committed meanwhile. The shared workshop lock goes
        // first (before login_attempts), then the account is re-checked under RLS.
        await tx.manager.query(TENANT_ADMINS_SHARED_LOCK_SQL);
        if (!(await accountUnchanged(tx.manager, account))) return null;
        // false: another attempt locked the email in the meantime (US2-AC9).
        if (!(await this.throttle.recordSuccess(tx.manager, hash))) {
          throw new ProblemException(429, 'ACCOUNT_LOCKED');
        }
        return this.openSession(state, await workshopName());
      }),
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
   * POST /auth/refresh (US3, research R5). The identity comes only from the refresh token: the
   * database resolves its tenant (auth_find_refresh_token) and the rest runs under RLS. Failures
   * that change data (reuse → revocation of the whole session) are committed before throwing.
   */
  async refresh(refreshToken: string | undefined, ip: string | null): Promise<IssuedSession> {
    if (refreshToken === undefined) throw new ProblemException(401, 'SESSION_EXPIRED');
    const outcome = await withAuthTransaction(
      this.dataSource,
      ip,
      async (tx): Promise<IssuedSession | ProblemException> => {
        const found = await this.sessions.findRefreshToken(tx.manager, refreshToken);
        if (!found) return new ProblemException(401, 'SESSION_EXPIRED');
        await tx.pinTenant(found.tenantId);

        const session = await this.sessions.lockSession(tx.manager, found.sessionId);
        if (!session || session.revoked || session.userStatus !== 'active') {
          return new ProblemException(401, 'SESSION_REVOKED');
        }
        if (session.inactive) return new ProblemException(401, 'SESSION_EXPIRED');

        const state = await this.sessions.tokenState(tx.manager, found.tokenId);
        if (state === 'recently_rotated') return new ProblemException(409, 'REFRESH_CONFLICT');
        if (state === 'reused') {
          await this.sessions.revoke(tx.manager, found.sessionId, 'refresh_reuse');
          return new ProblemException(401, 'SESSION_REVOKED');
        }

        const account = lockedAccountState(session, found.tenantId);
        if (!account) return new ProblemException(401, 'SESSION_REVOKED');
        const nextToken = await this.sessions.rotate(tx.manager, found.tokenId, found.sessionId);
        const workshop = await workshopName(tx.manager);
        return {
          refreshToken: nextToken,
          body: this.sessionResponse(account, found.sessionId, workshop),
        };
      },
    );
    if (outcome instanceof ProblemException) throw outcome;
    return outcome;
  }

  /**
   * POST /auth/logout (US3-AC3, AC6): revokes the session of the refresh token, if any. Idempotent:
   * an unknown cookie or an already closed session changes nothing.
   */
  async logout(refreshToken: string | undefined, ip: string | null): Promise<void> {
    if (refreshToken === undefined) return;
    await withAuthTransaction(this.dataSource, ip, async (tx) => {
      const found = await this.sessions.findRefreshToken(tx.manager, refreshToken);
      if (!found) return;
      await tx.pinTenant(found.tenantId);
      await this.sessions.revoke(tx.manager, found.sessionId, 'logout');
    });
  }

  /** GET /auth/me: user and workshop of the session, current values read under RLS. */
  async me(): Promise<CurrentSession> {
    const { manager, user } = getTenantContext();
    const rows = (await manager.query(
      `SELECT u.id, u.name, u.email, u.role, u.must_change_password, u.temp_password_expires_at,
              t.name AS workshop_name
         FROM users u
         JOIN tenants t ON t.id = u.tenant_id
        WHERE u.id = $1`,
      [user.userId],
    )) as CurrentAccountRow[];
    const row = rows[0];
    if (!row || !isAuthRole(row.role)) throw new UnauthorizedException();
    return {
      user: {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        mustChangePassword: row.must_change_password,
        temporaryPasswordExpiresAt: row.temp_password_expires_at?.toISOString() ?? null,
      },
      workshop: { id: user.tenantId, name: row.workshop_name },
    };
  }

  /**
   * POST /auth/password (US5): lock check, current password (a wrong one counts as a login
   * failure, committed apart once the request released its connection), SAME_PASSWORD, new hash,
   * end of the temporary password, revocation of the OTHER sessions (FR-027) and a new access
   * token of the same session. An expired
   * temporary password gives 401 TEMPORARY_PASSWORD_EXPIRED; TenantTransactionInterceptor revokes
   * the session after the rollback (research R7).
   */
  async changePassword(dto: ChangePasswordDto): Promise<SessionResponse> {
    const { manager, user, ip } = getTenantContext();
    const sessionId = user.sessionId;
    if (sessionId === undefined) throw new UnauthorizedException();
    const rows = (await manager.query(
      `SELECT email, password_hash, must_change_password,
              temp_password_expires_at <= now() AS temp_password_expired
         FROM users WHERE id = $1 AND status = 'active'`,
      [user.userId],
    )) as PasswordAccountRow[];
    const account = rows[0];
    if (!account) throw new ProblemException(401, 'SESSION_REVOKED');
    if (account.must_change_password && account.temp_password_expired === true) {
      throw new ProblemException(401, 'TEMPORARY_PASSWORD_EXPIRED');
    }

    const hash = emailHash(account.email);
    if ((await this.throttle.lockedUntil(manager, hash)) !== null) {
      throw new ProblemException(429, 'ACCOUNT_LOCKED');
    }
    if (!(await this.hasher.verify(dto.currentPassword, account.password_hash))) {
      // Committed on its own so the failure counts although the request rolls back (US5-AC4),
      // and only once the interceptor released the connection of the request (T049).
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
      `UPDATE users
          SET password_hash = $2, must_change_password = false, temp_password_expires_at = NULL,
              updated_at = now(), updated_by = $1, updated_by_name = $3
        WHERE id = $1 AND password_hash = $4`,
      [user.userId, newHash, user.name, account.password_hash],
    )) as [unknown, number];
    if (changed !== 1) throw currentPasswordIncorrect();
    await this.sessions.revokeOthers(manager, user.userId, sessionId, 'password_changed');

    const state: AccountState = {
      user,
      email: account.email,
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
    };
    return this.sessionResponse(state, sessionId, await workshopName());
  }

  private async findAccount(
    manager: EntityManager,
    email: string,
  ): Promise<LoginAccountRow | undefined> {
    const rows = (await manager.query(
      `SELECT user_id, tenant_id, name, role, status, password_hash, must_change_password,
              temp_password_expires_at, temp_password_expires_at <= now() AS temp_password_expired
         FROM auth_find_user_for_login($1)`,
      [email],
    )) as LoginAccountRow[];
    return rows[0];
  }

  /** Session + refresh token under the pinned tenant, and the SessionResponse. */
  private async openSession(account: AccountState, workshop: string): Promise<IssuedSession> {
    const { sessionId, refreshToken } = await this.sessions.create();
    return { refreshToken, body: this.sessionResponse(account, sessionId, workshop) };
  }

  /** SessionResponse with a new access token of `sessionId`. */
  private sessionResponse(
    account: AccountState,
    sessionId: string,
    workshop: string,
  ): SessionResponse {
    const { user } = account;
    const accessToken = this.accessTokens.issue({
      userId: user.userId,
      tenantId: user.tenantId,
      role: user.role,
      name: user.name,
      sessionId,
      mustChangePassword: account.mustChangePassword,
    });
    return {
      accessToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: user.userId,
        name: user.name,
        email: account.email,
        role: user.role,
        mustChangePassword: account.mustChangePassword,
        temporaryPasswordExpiresAt: account.temporaryPasswordExpiresAt?.toISOString() ?? null,
      },
      workshop: { id: user.tenantId, name: workshop },
    };
  }
}

/** The account still has the verified hash and is active (read under RLS, research R8). */
async function accountUnchanged(
  manager: EntityManager,
  account: LoginAccountRow,
): Promise<boolean> {
  const rows = (await manager.query(
    "SELECT 1 FROM users WHERE id = $1 AND password_hash = $2 AND status = 'active'",
    [account.user_id, account.password_hash],
  )) as unknown[];
  return rows.length === 1;
}

/** Name of the pinned workshop, read under RLS (policy tenants_self). */
async function workshopName(manager: EntityManager = getManager()): Promise<string> {
  const rows = (await manager.query(
    'SELECT name FROM tenants WHERE id = app_current_tenant()',
  )) as WorkshopNameRow[];
  return rows[0].name;
}

function toAccountState(row: LoginAccountRow, email: string): AccountState {
  if (!isAuthRole(row.role)) throw new ProblemException(401, 'INVALID_CREDENTIALS');
  return {
    user: { userId: row.user_id, tenantId: row.tenant_id, role: row.role, name: row.name },
    email,
    mustChangePassword: row.must_change_password,
    temporaryPasswordExpiresAt: row.temp_password_expires_at,
  };
}

/** Current account of a locked session (role and state of the database, FR-014). */
function lockedAccountState(session: LockedSession, tenantId: string): AccountState | null {
  if (!isAuthRole(session.role)) return null;
  return {
    user: { userId: session.userId, tenantId, role: session.role, name: session.name },
    email: session.email,
    mustChangePassword: session.mustChangePassword,
    temporaryPasswordExpiresAt: session.temporaryPasswordExpiresAt,
  };
}
