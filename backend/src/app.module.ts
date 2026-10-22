import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { ClientsModule } from './clients/clients.module.js';
import { requireEnv } from './config/env.js';
import { appDataSourceOptions } from './database/data-source.js';
import { TenantTransactionInterceptor } from './database/tenant-transaction.interceptor.js';
import { VehiclesModule } from './vehicles/vehicles.module.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: () => appDataSourceOptions() }),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: requireEnv('JWT_SECRET'),
        signOptions: { algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
    ClientsModule,
    VehiclesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Guards run before interceptors: the transaction always sees a verified user.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantTransactionInterceptor },
  ],
})
export class AppModule {}
