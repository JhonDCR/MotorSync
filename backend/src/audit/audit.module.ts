import { Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** Import it in the modules that audit changes (principle IV). */
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
