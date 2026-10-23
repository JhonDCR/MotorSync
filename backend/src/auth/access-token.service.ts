import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AuthRole } from './auth-user.js';

/** Lifetime of the access token in seconds: 15 minutes (research R5). */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

export interface AccessTokenSubject {
  userId: string;
  tenantId: string;
  role: AuthRole;
  name: string;
  sessionId: string;
  mustChangePassword: boolean;
}

/** Claims of the access token: those of the 001 plus `sid` and `pwd_change` (contract). */
interface AccessTokenClaims {
  sub: string;
  tenant_id: string;
  role: AuthRole;
  name: string;
  sid: string;
  pwd_change: boolean;
}

/** Issues the HS256 access tokens of a real session (JWT_SECRET, 15 minutes). */
@Injectable()
export class AccessTokenService {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  issue(subject: AccessTokenSubject): string {
    const claims: AccessTokenClaims = {
      sub: subject.userId,
      tenant_id: subject.tenantId,
      role: subject.role,
      name: subject.name,
      sid: subject.sessionId,
      pwd_change: subject.mustChangePassword,
    };
    return this.jwt.sign(claims, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL_SECONDS });
  }
}
