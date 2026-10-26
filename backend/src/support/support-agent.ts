/** Authenticated support agent, derived only from a verified support token (research R3). */
export interface SupportAgent {
  id: string;
  sessionId: string;
  name: string;
  mustChangePassword: boolean;
}

/** Shape of the HTTP request once JwtAuthGuard has verified a support token (research R3). */
export interface SupportRequest {
  supportAgent?: SupportAgent;
  /** Set by Express (honours the trust proxy setting). */
  ip?: string;
}
