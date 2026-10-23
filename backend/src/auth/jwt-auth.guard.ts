import {
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
import { readAuthFlags } from '../config/env.js';
import { isAuthRole, type AuthUser } from './auth-user.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}

const BEARER = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*)$/;

/**
 * Global guard (research R2, R3, R9): only HS256 bearer tokens signed with JWT_SECRET are
 * accepted, except on @Public() routes. The tenant comes exclusively from the verified token,
 * never from headers, body or query. A token without `sid` is accepted only while
 * AUTH_ALLOW_SESSIONLESS_TOKENS=true (read on every request).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const token = extractBearer(request.headers.authorization);
    if (!token) throw new UnauthorizedException();

    let claims: Record<string, unknown>;
    try {
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        algorithms: ['HS256'],
      });
    } catch (error) {
      // jsonwebtoken checks the algorithm and the signature before the expiry, so this code
      // is only given to tokens this API really issued (research R12).
      if (error instanceof TokenExpiredError) throw new ProblemException(401, 'TOKEN_EXPIRED');
      throw new UnauthorizedException();
    }

    const user = toAuthUser(claims);
    if (user.sessionId === undefined && !sessionlessTokensAllowed()) {
      throw new UnauthorizedException();
    }
    request.user = user;
    return true;
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
  const { sub, tenant_id: tenantId, role, name, exp, sid, pwd_change: pwdChange } = claims;
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
