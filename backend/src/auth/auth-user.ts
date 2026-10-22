export const AUTH_ROLES = ['asesor', 'admin'] as const;

export type AuthRole = (typeof AUTH_ROLES)[number];

/** Authenticated user, derived only from a verified JWT (research R3, principle I). */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: AuthRole;
  name: string;
}

/** Shape of the HTTP request once JwtAuthGuard has run. */
export interface AuthenticatedRequest {
  user?: AuthUser;
}

export function isAuthRole(value: unknown): value is AuthRole {
  return typeof value === 'string' && (AUTH_ROLES as readonly string[]).includes(value);
}
