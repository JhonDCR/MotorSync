import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { isAuthRole, type AuthUser } from './auth-user.js';

interface RequestWithHeaders {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}

const BEARER = /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*)$/;

/**
 * Global guard (research R3): only HS256 bearer tokens signed with JWT_SECRET are accepted.
 * The tenant comes exclusively from the verified token, never from headers, body or query.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithHeaders>();
    const token = extractBearer(request.headers.authorization);
    if (!token) throw new UnauthorizedException();

    let claims: Record<string, unknown>;
    try {
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException();
    }

    request.user = toAuthUser(claims);
    return true;
  }
}

function extractBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  return BEARER.exec(header)?.[1] ?? null;
}

function toAuthUser(claims: Record<string, unknown>): AuthUser {
  const { sub, tenant_id: tenantId, role, name, exp } = claims;
  if (
    typeof sub !== 'string' ||
    !isUUID(sub) ||
    typeof tenantId !== 'string' ||
    !isUUID(tenantId) ||
    !isAuthRole(role) ||
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    typeof exp !== 'number'
  ) {
    throw new UnauthorizedException();
  }
  return { userId: sub, tenantId, role, name: name.trim() };
}
