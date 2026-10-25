import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LoginThrottleService } from '../auth/login-throttle.service.js';
import { SupportAccessTokenService } from './support-access-token.service.js';
import { SupportAuthController } from './support-auth.controller.js';
import { SupportAuthService } from './support-auth.service.js';
import { SupportSessionsService } from './support-sessions.service.js';
import { SupportTicketsController } from './support-tickets.controller.js';
import { SupportTicketsService } from './support-tickets.service.js';

/**
 * Support panel (feature 003). AuthModule provides PasswordHasher (and the same 5/15 lock
 * functions through LoginThrottleService). SupportSessionValidator stays a global provider of
 * AppModule, because SupportTransactionInterceptor is global as well.
 *
 * Every controller added here must be decorated with @SupportArea() (research R3).
 */
@Module({
  imports: [AuthModule],
  controllers: [SupportAuthController, SupportTicketsController],
  providers: [
    SupportAuthService,
    SupportSessionsService,
    SupportTicketsService,
    SupportAccessTokenService,
    LoginThrottleService,
  ],
})
export class SupportModule {}
