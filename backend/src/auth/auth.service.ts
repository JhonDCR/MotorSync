import { Inject, Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError, type EntityManager } from 'typeorm';
import { emailHash } from '../common/identifiers/email.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { getManager } from '../database/tenant-context.js';
import { AccessTokenService, ACCESS_TOKEN_TTL_SECONDS } from './access-token.service.js';
import { withAuthTransaction } from './auth-transaction.js';
import { isAuthRole, type AuthRole, type AuthUser } from './auth-user.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionsService } from './sessions.service.js';

/** Contract `SessionUser`. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: AuthRole;
  mustChangePassword: boolean;
  temporaryPasswordExpiresAt: string | null;
}

/** Contract `SessionResponse` (the refresh token never goes in a body). */
export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
  workshop: { id: string; name: string };
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

/**
 * Registration and login (US1, US2). The workshop always comes from the database, through the
 * SECURITY DEFINER auth_* functions, never from the request (principle I, research R1, R2).
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
   * Unknown email, wrong password and inactive account give the same 401 (FR-008).
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

    const state = toAccountState(account, dto.email);
    return withAuthTransaction(this.dataSource, ip, async (tx) => {
      // false: another attempt locked the email in the meantime (US2-AC9).
      if (!(await this.throttle.recordSuccess(tx.manager, hash))) {
        throw new ProblemException(429, 'ACCOUNT_LOCKED');
      }
      return tx.asTenant(state.user, async () => this.openSession(state, await workshopName()));
    });
  }

  private async findAccount(
    manager: EntityManager,
    email: string,
  ): Promise<LoginAccountRow | undefined> {
    const rows = (await manager.query(
      `SELECT user_id, tenant_id, name, role, status, password_hash, must_change_password,
              temp_password_expires_at
         FROM auth_find_user_for_login($1)`,
      [email],
    )) as LoginAccountRow[];
    return rows[0];
  }

  /** Session + refresh token under the pinned tenant, and the SessionResponse. */
  private async openSession(account: AccountState, workshop: string): Promise<IssuedSession> {
    const { sessionId, refreshToken } = await this.sessions.create();
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
      refreshToken,
      body: {
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
      },
    };
  }
}

/** Name of the pinned workshop, read under RLS (policy tenants_self). */
async function workshopName(): Promise<string> {
  const rows = (await getManager().query(
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
