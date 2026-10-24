import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { LocksTenantAdmins } from '../auth/locks-tenant-admins.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { ChangeRoleDto } from './dto/change-role.dto.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import {
  assertValidUserId,
  UsersService,
  type UserAccount,
  type UserAuditEntry,
} from './users.service.js';

@Controller('users')
@Roles('admin')
export class UsersController {
  constructor(@Inject(UsersService) private readonly usersService: UsersService) {}

  /**
   * GET /api/v1/users (US4-AC1): lists active and inactive users.
   */
  @Get()
  @Roles('admin')
  list(): Promise<{ items: UserAccount[] }> {
    return this.usersService.list();
  }

  /**
   * POST /api/v1/users (US4-AC2): creates a user with a temporary password.
   */
  @Post()
  @HttpCode(201)
  @Roles('admin')
  create(@Body() dto: CreateUserDto): Promise<UserAccount> {
    return this.usersService.create(dto);
  }

  /**
   * GET /api/v1/users/:userId (US4): gets a single user.
   */
  @Get(':userId')
  @Roles('admin')
  getById(@Param('userId') userId: string): Promise<UserAccount> {
    assertValidUserId(userId);
    return this.usersService.getById(userId);
  }

  /**
   * PUT /api/v1/users/:userId/role (US4-AC5): changes user role.
   */
  @Put(':userId/role')
  @Roles('admin')
  @LocksTenantAdmins()
  changeRole(
    @Param('userId') userId: string,
    @Body() dto: ChangeRoleDto,
  ): Promise<UserAccount> {
    assertValidUserId(userId);
    return this.usersService.changeRole(userId, dto);
  }

  /**
   * POST /api/v1/users/:userId/deactivate (US4-AC6): deactivates user and revokes sessions.
   */
  @Post(':userId/deactivate')
  @HttpCode(200)
  @Roles('admin')
  @LocksTenantAdmins()
  deactivate(@Param('userId') userId: string): Promise<UserAccount> {
    assertValidUserId(userId);
    return this.usersService.deactivate(userId);
  }

  /**
   * POST /api/v1/users/:userId/reactivate (US4-AC7): reactivates an inactive user.
   */
  @Post(':userId/reactivate')
  @HttpCode(200)
  @Roles('admin')
  @LocksTenantAdmins()
  reactivate(@Param('userId') userId: string): Promise<UserAccount> {
    assertValidUserId(userId);
    return this.usersService.reactivate(userId);
  }

  /**
   * POST /api/v1/users/:userId/password-reset (US4-AC21): resets another user's password.
   */
  @Post(':userId/password-reset')
  @HttpCode(200)
  @Roles('admin')
  @LocksTenantAdmins()
  resetPassword(
    @Param('userId') userId: string,
    @Body() dto: ResetPasswordDto,
  ): Promise<UserAccount> {
    assertValidUserId(userId);
    return this.usersService.resetPassword(userId, dto);
  }

  /**
   * GET /api/v1/users/:userId/history (US4-AC12, AC13, AC24): gets audit history of a user.
   */
  @Get(':userId/history')
  @Roles('admin')
  getHistory(@Param('userId') userId: string): Promise<{ items: UserAuditEntry[] }> {
    assertValidUserId(userId);
    return this.usersService.getHistory(userId);
  }
}
