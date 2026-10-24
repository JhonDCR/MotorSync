import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ProblemException } from '../common/problem-details.filter.js';
import { AllowPendingPasswordChange } from './allow-pending-password-change.decorator.js';
import {
  AuthService,
  type CurrentSession,
  type IssuedSession,
  type SessionResponse,
} from './auth.service.js';
import {
  assertRequestedWith,
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from './cookies.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { LocksTenantAdmins } from './locks-tenant-admins.decorator.js';
import { RegisterDto } from './dto/register.dto.js';
import { Public } from './public.decorator.js';

/**
 * Auth routes. register, login, refresh and logout are @Public() (research R2): no Authorization
 * and no request transaction; the services open their own with withAuthTransaction. refresh and
 * logout identify the session ONLY by the ms_refresh cookie (an Authorization header is ignored)
 * and require `X-Requested-With: motorsync` (research R11). The cookie is set only after the
 * service succeeded, so an error response never carries a new ms_refresh. me and password run in
 * the request transaction and are allowed with a pending temporary password (research R7).
 */
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** POST /api/v1/auth/register (US1): 201 SessionResponse + ms_refresh. */
  @Public()
  @Post('register')
  @HttpCode(201)
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    return withCookie(res, await this.auth.register(dto, req.ip ?? null));
  }

  /** POST /api/v1/auth/login (US2): 200 SessionResponse + ms_refresh. */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    return withCookie(res, await this.auth.login(dto, req.ip ?? null));
  }

  /**
   * POST /api/v1/auth/refresh (US3): 200 SessionResponse + a new ms_refresh (rotation). Every 401
   * clears the cookie; a 409 REFRESH_CONFLICT keeps the one the browser already replaced.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    assertRequestedWith(req.headers);
    try {
      return withCookie(res, await this.auth.refresh(refreshTokenOf(req), req.ip ?? null));
    } catch (error) {
      if (error instanceof ProblemException && error.getStatus() === 401) clearRefreshCookie(res);
      throw error;
    }
  }

  /** POST /api/v1/auth/logout (US3-AC3, AC6): always 204 and the cookie cleared. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    assertRequestedWith(req.headers);
    await this.auth.logout(refreshTokenOf(req), req.ip ?? null);
    clearRefreshCookie(res);
  }

  /** GET /api/v1/auth/me: current user and workshop. */
  @AllowPendingPasswordChange()
  @Get('me')
  me(): Promise<CurrentSession> {
    return this.auth.me();
  }

  /**
   * POST /api/v1/auth/password (US5): 200 SessionResponse with a new access token.
   * Holds the workshop advisory lock (research R8) like the account mutations of /users: it locks
   * its own session, the users row and the OTHER sessions of the account, and an admin revoking
   * those sessions (password-reset, deactivate) would otherwise lock them in another order (40P01).
   */
  @AllowPendingPasswordChange()
  @LocksTenantAdmins()
  @Post('password')
  @HttpCode(200)
  changePassword(@Body() dto: ChangePasswordDto): Promise<SessionResponse> {
    return this.auth.changePassword(dto);
  }
}

function refreshTokenOf(req: Request): string | undefined {
  return readRefreshCookie(req.headers.cookie);
}

function withCookie(res: Response, session: IssuedSession): SessionResponse {
  setRefreshCookie(res, session.refreshToken);
  return session.body;
}
