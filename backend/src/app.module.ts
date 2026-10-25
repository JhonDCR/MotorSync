import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { SessionValidator } from './auth/session-validator.js';
import { ClientsModule } from './clients/clients.module.js';
import { requireEnv } from './config/env.js';
import { appDataSourceOptions } from './database/data-source.js';
import { TenantTransactionInterceptor } from './database/tenant-transaction.interceptor.js';
import { SupportSessionValidator } from './support/support-session-validator.js';
import { SupportTransactionInterceptor } from './support/support-transaction.interceptor.js';
import { UsersModule } from './users/users.module.js';
import { VehiclesModule } from './vehicles/vehicles.module.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: () => appDataSourceOptions() }),
    JwtModule.registerAsync({
      // Global: the guard and AuthModule (AccessTokenService) share the same configuration.
      global: true,
      useFactory: () => ({
        secret: requireEnv('JWT_SECRET'),
        signOptions: { algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
    AuthModule,
    ClientsModule,
    VehiclesModule,
    UsersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Always available to the global interceptor: a token with sid is never accepted without it.
    SessionValidator,
    // Same for the panel: a support token is never accepted without its session validator.
    SupportSessionValidator,
    // Guards run before interceptors: the transaction always sees a verified user.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Each interceptor self-excludes from the other zone (@SupportArea() vs @Public()), so the
    // order only decides who calls next.handle() first.
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
    { provide: APP_INTERCEPTOR, useClass: SupportTransactionInterceptor },
  ],
})
export class AppModule {}
