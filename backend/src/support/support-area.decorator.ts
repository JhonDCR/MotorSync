import { SetMetadata } from '@nestjs/common';

export const SUPPORT_AREA_KEY = 'supportArea';

/**
 * Marks a handler or controller as part of the support panel (research R3): JwtAuthGuard verifies
 * its tokens with SUPPORT_JWT_SECRET and publishes request.supportAgent instead of request.user.
 */
export const SupportArea = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SUPPORT_AREA_KEY, true);
