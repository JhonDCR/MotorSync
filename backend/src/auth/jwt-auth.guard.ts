import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { ProblemException } from '../common/problem-details.filter.js';
import { readAuthFlags, readSupportJwtSecret } from '../config/env.js';
import { SUPPORT_TOKEN_AUDIENCE } from '../support/support-access-token.service.js';
import type { SupportAgent } from '../support/support-agent.js';
import { SUPPORT_AREA_KEY } from '../support/support-area.decorator.js';
import { isAuthRole, type AuthUser } from './auth-user.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
  supportAgent?: SupportAgent;
}

const BEARER = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*)$/;

/**
 * Global guard (research R2, R3, R9): only HS256 bearer tokens signed with JWT_SECRET are
 * accepted, except on @Public() routes. The tenant comes exclusively from the verified token,
 * never from headers, body or query. A token without `sid` is accepted only while
 * AUTH_ALLOW_SESSIONLESS_TOKENS=true (read on every request).
 *
 * The guard verifies by zone (research R3): a `@SupportArea()` route only accepts tokens signed
 * with SUPPORT_JWT_SECRET and `aud: motorsync-support`, published as `request.supportAgent`; any
 * other route only accepts workshop tokens, published as `request.user`. A token of the other
 * zone gets 403 FORBIDDEN, so the separation holds in both directions.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic === true) return true;

    const supportArea =
      this.reflector.getAllAndOverride<boolean | undefined>(SUPPORT_AREA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;

    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const token = extractBearer(request.headers.authorization);
    if (!token) throw new UnauthorizedException();

    if (supportArea) {
      request.supportAgent = await this.verifySupportToken(token);
      return true;
    }

    request.user = await this.verifyWorkshopToken(token);
    return true;
  }

  /** Support zone: SUPPORT_JWT_SECRET + `aud: motorsync-support`, always with `sid`. */
  private async verifySupportToken(token: string): Promise<SupportAgent> {
    const secret = readSupportJwtSecret();
    let claims: Record<string, unknown> | undefined;
    if (secret !== undefined) {
      try {
        claims = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
          secret,
          algorithms: ['HS256'],
          audience: SUPPORT_TOKEN_AUDIENCE,
        });
      } catch (error) {
        // jsonwebtoken checks the algorithm and the signature before the expiry, so this code
        // is only given to support tokens this API really issued (research R12).
        if (error instanceof TokenExpiredError)
          throw new ProblemException(401, 'TOKEN_EXPIRED');
      }
    }
    if (claims === undefined) {
      // A workshop token on a support route is forbidden, not unauthorized (US2-AC5).
      if (await this.verifiesAsWorkshopToken(token))
        throw new ForbiddenException();
      throw new UnauthorizedException();
    }
    return toSupportAgent(claims);
  }

  /** Workshop zone: JWT_SECRET, `sid` and AUTH_ALLOW_SESSIONLESS_TOKENS, as in the 001 and 002. */
  private async verifyWorkshopToken(token: string): Promise<AuthUser> {
    let claims: Record<string, unknown>;
    try {
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        algorithms: ['HS256'],
      });
    } catch (error) {
      // A support token on a workshop route is forbidden, not unauthorized (US2-AC6). An expired
      // workshop token keeps TOKEN_EXPIRED, the code of the 001 and 002 (research R12).
      if (await this.verifiesAsSupportToken(token))
        throw new ForbiddenException();
      if (error instanceof TokenExpiredError)
        throw new ProblemException(401, 'TOKEN_EXPIRED');
      throw new UnauthorizedException();
    }

    const user = toAuthUser(claims);
    if (user.sessionId === undefined && !sessionlessTokensAllowed()) {
      throw new UnauthorizedException();
    }
    return user;
  }

  /** True when the token is a valid support token (secret and audience), expired or not. */
  private async verifiesAsSupportToken(token: string): Promise<boolean> {
    const secret = readSupportJwtSecret();
    if (secret === undefined) return false;
    try {
      await this.jwt.verifyAsync(token, {
        secret,
        algorithms: ['HS256'],
        audience: SUPPORT_TOKEN_AUDIENCE,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** True when the token is a valid workshop token (JWT_SECRET configured on JwtService). */
  private async verifiesAsWorkshopToken(token: string): Promise<boolean> {
    try {
      await this.jwt.verifyAsync(token, { algorithms: ['HS256'] });
      return true;
    } catch {
      return false;
    }
  }
}

/** Fails closed: an invalid flag configuration never lets sessionless tokens through. */
function sessionlessTokensAllowed(): boolean {
  try {
    return readAuthFlags().allowSessionlessTokens;
  } catch {
    return false;
  }
}

function extractBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  return BEARER.exec(header)?.[1] ?? null;
}

function toAuthUser(claims: Record<string, unknown>): AuthUser {
  const {
    sub,
    tenant_id: tenantId,
    role,
    name,
    exp,
    sid,
    pwd_change: pwdChange,
  } = claims;
  if (
    typeof sub !== 'string' ||
    !isUUID(sub) ||
    typeof tenantId !== 'string' ||
    !isUUID(tenantId) ||
    !isAuthRole(role) ||
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    typeof exp !== 'number' ||
    (sid !== undefined && (typeof sid !== 'string' || !isUUID(sid))) ||
    (pwdChange !== undefined && typeof pwdChange !== 'boolean')
  ) {
    throw new UnauthorizedException();
  }
  const user: AuthUser = { userId: sub, tenantId, role, name: name.trim() };
  if (typeof sid === 'string') user.sessionId = sid;
  if (typeof pwdChange === 'boolean') user.mustChangePassword = pwdChange;
  return user;
}

/** Valid support claims: `sid` is mandatory, `AUTH_ALLOW_SESSIONLESS_TOKENS` never applies. */
function toSupportAgent(claims: Record<string, unknown>): SupportAgent {
  const { sub, sid, name, pwd_change: pwdChange, exp } = claims;
  if (
    typeof sub !== 'string' ||
    !isUUID(sub) ||
    typeof sid !== 'string' ||
    !isUUID(sid) ||
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    typeof pwdChange !== 'boolean' ||
    typeof exp !== 'number'
  ) {
    throw new UnauthorizedException();
  }
  return {
    id: sub,
    sessionId: sid,
    name: name.trim(),
    mustChangePassword: pwdChange,
  };
}
