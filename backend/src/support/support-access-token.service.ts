import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { readSupportJwtSecret } from '../config/env.js';
import type { SupportAgent } from './support-agent.js';

/** Audience of the support panel tokens (research R3). */
export const SUPPORT_TOKEN_AUDIENCE = 'motorsync-support';

/** Lifetime of the support access token (research R3). */
export const SUPPORT_ACCESS_TOKEN_TTL = '15m';

/** Claims of the support access token: no `tenant_id` and no `role` (research R3). */
interface SupportTokenClaims {
  sub: string;
  sid: string;
  name: string;
  pwd_change: boolean;
}

/** Issues the HS256 access tokens of the support panel (SUPPORT_JWT_SECRET, 15 minutes). */
@Injectable()
export class SupportAccessTokenService {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  /** HS256, 15 minutos, aud motorsync-support, firmado con SUPPORT_JWT_SECRET. */
  async issue(agent: SupportAgent): Promise<string> {
    const secret = readSupportJwtSecret();
    if (secret === undefined) {
      throw new Error(
        'Missing environment variable SUPPORT_JWT_SECRET: cannot sign support access tokens.',
      );
    }
    const claims: SupportTokenClaims = {
      sub: agent.id,
      sid: agent.sessionId,
      name: agent.name,
      pwd_change: agent.mustChangePassword,
    };
    return this.jwt.sign(claims, {
      algorithm: 'HS256',
      expiresIn: SUPPORT_ACCESS_TOKEN_TTL,
      audience: SUPPORT_TOKEN_AUDIENCE,
      secret,
    });
  }
}
