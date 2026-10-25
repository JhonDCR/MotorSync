import { Module } from '@nestjs/common';

/**
 * Support panel (feature 003). Empty for now: T027 registers its controllers and services.
 * Every controller added here must be decorated with @SupportArea() (research R3).
 */
@Module({ controllers: [], providers: [] })
export class SupportModule {}
