import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService, type SessionResponse } from './auth.service.js';
import { setRefreshCookie } from './cookies.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { Public } from './public.decorator.js';

/**
 * Public auth routes (research R2): no Authorization and no request transaction; the services
 * open their own with withAuthTransaction. The cookie is set only after the service succeeded,
 * so an error response never carries ms_refresh.
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
    const session = await this.auth.register(dto, req.ip ?? null);
    setRefreshCookie(res, session.refreshToken);
    return session.body;
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
    const session = await this.auth.login(dto, req.ip ?? null);
    setRefreshCookie(res, session.refreshToken);
    return session.body;
  }
}
