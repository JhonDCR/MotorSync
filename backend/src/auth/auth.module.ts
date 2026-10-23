import { Module } from '@nestjs/common';
import { AccessTokenService } from './access-token.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { PasswordHasher } from './password-hasher.js';
import { SessionsService } from './sessions.service.js';

/** Registration and login (feature 002, PR1). JwtService comes from the global JwtModule. */
@Module({
  controllers: [AuthController],
  providers: [AuthService, AccessTokenService, LoginThrottleService, PasswordHasher, SessionsService],
})
export class AuthModule {}
