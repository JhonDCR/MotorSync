import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { LoginThrottleService } from '../auth/login-throttle.service.js';
import { SupportAccessLogController } from './support-access-log.controller.js';
import { SupportAccessLogService } from './support-access-log.service.js';
import { SupportAccessTokenService } from './support-access-token.service.js';
import { SupportAuthController } from './support-auth.controller.js';
import { SupportAuthService } from './support-auth.service.js';
import { SupportPasswordService } from './support-password.service.js';
import { SupportSessionsService } from './support-sessions.service.js';
import { SupportTicketsController } from './support-tickets.controller.js';
import { SupportTicketsService } from './support-tickets.service.js';
import { SupportWorkshopsController } from './support-workshops.controller.js';
import { SupportWorkshopsService } from './support-workshops.service.js';

/**
 * Support panel (feature 003). AuthModule provides PasswordHasher (and the same 5/15 lock
 * functions through LoginThrottleService). AuditModule provides AuditService for
 * SupportPasswordService (research R9, R11). SupportSessionValidator stays a global provider of
 * AppModule, because SupportTransactionInterceptor is global as well.
 *
 * Every controller added here must be decorated with @SupportArea() (research R3).
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [
    SupportAuthController,
    SupportTicketsController,
    SupportWorkshopsController,
    SupportAccessLogController,
  ],
  providers: [
    SupportAuthService,
    SupportSessionsService,
    SupportTicketsService,
    SupportWorkshopsService,
    SupportAccessLogService,
    SupportPasswordService,
    SupportAccessTokenService,
    LoginThrottleService,
  ],
})
export class SupportModule {}
