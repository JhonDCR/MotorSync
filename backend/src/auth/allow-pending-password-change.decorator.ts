import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = 'allowPendingPasswordChange';

/**
 * Lets an account with a pending temporary password reach this handler (research R7, FR-026).
 * Only GET /auth/me and POST /auth/password carry it; elsewhere it is 403 PASSWORD_CHANGE_REQUIRED.
 */
export const AllowPendingPasswordChange = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);
