import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AllowPendingPasswordChange } from '../auth/allow-pending-password-change.decorator.js';
import {
  SUPPORT_REFRESH_COOKIE,
  assertRequestedWith,
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from '../auth/cookies.js';
import { ChangePasswordDto } from '../auth/dto/change-password.dto.js';
import { Public } from '../auth/public.decorator.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { SupportArea } from './support-area.decorator.js';
import {
  SupportAuthService,
  type IssuedSupportSession,
  type SupportAgentInfo,
  type SupportSessionResponse,
} from './support-auth.service.js';
import { SupportLoginDto } from './dto/support-login.dto.js';

/**
 * Access of the support panel (US2). login, refresh and logout are @Public() (research R3): the
 * services open their own withAuthTransaction and never pin a workshop. refresh and logout
 * identify the session ONLY by the ms_support_refresh cookie (an Authorization header is ignored)
 * and require `X-Requested-With: motorsync` (research R11). The cookie is set only after the
 * service succeeded, so an error response never carries a new ms_support_refresh. me and password
 * run in the support request transaction and are allowed with a pending temporary password.
 */
@SupportArea()
@Controller('support/auth')
export class SupportAuthController {
  constructor(
    @Inject(SupportAuthService) private readonly auth: SupportAuthService,
  ) {}

  /** POST /api/v1/support/auth/login (US2-AC3): 200 SupportSessionResponse + ms_support_refresh. */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: SupportLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupportSessionResponse> {
    return withSupportCookie(res, await this.auth.login(dto, req.ip ?? null));
  }

  /**
   * POST /api/v1/support/auth/refresh (US2-AC9): 200 SupportSessionResponse + a rotated
   * ms_support_refresh. Every 401 clears the cookie; a 409 REFRESH_CONFLICT keeps the one the
   * browser already replaced.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupportSessionResponse> {
    assertRequestedWith(req.headers);
    try {
      return withSupportCookie(
        res,
        await this.auth.refresh(refreshTokenOf(req), req.ip ?? null),
      );
    } catch (error) {
      if (error instanceof ProblemException && error.getStatus() === 401) {
        clearRefreshCookie(res, SUPPORT_REFRESH_COOKIE);
      }
      throw error;
    }
  }

  /** POST /api/v1/support/auth/logout (US2-AC9): always 204 and the cookie cleared. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    assertRequestedWith(req.headers);
    await this.auth.logout(refreshTokenOf(req), req.ip ?? null);
    clearRefreshCookie(res, SUPPORT_REFRESH_COOKIE);
  }

  /** GET /api/v1/support/auth/me: agent of the current support session. */
  @AllowPendingPasswordChange()
  @Get('me')
  me(): Promise<{ agent: SupportAgentInfo }> {
    return this.auth.me();
  }

  /** POST /api/v1/support/auth/password (FR-009): 200 SupportSessionResponse with a new token. */
  @AllowPendingPasswordChange()
  @Post('password')
  @HttpCode(200)
  changePassword(
    @Body() dto: ChangePasswordDto,
  ): Promise<SupportSessionResponse> {
    return this.auth.changePassword(dto);
  }
}

function refreshTokenOf(req: Request): string | undefined {
  return readRefreshCookie(req.headers.cookie, SUPPORT_REFRESH_COOKIE);
}

function withSupportCookie(
  res: Response,
  session: IssuedSupportSession,
): SupportSessionResponse {
  setRefreshCookie(res, session.refreshToken, SUPPORT_REFRESH_COOKIE);
  return session.body;
}
