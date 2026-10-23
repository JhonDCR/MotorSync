/**
 * Error of an authenticated request that also needs work committed apart from the request
 * transaction (which rolls back), for example counting a failed current password (US5-AC4).
 *
 * The work must NOT run while the request still holds its pool connection: that connection keeps
 * the user_sessions row locked (SessionValidator, research R6), and a second connection asked for
 * meanwhile can exhaust the pool and hang every request of the session (T049). So the handler
 * throws this error and TenantTransactionInterceptor rolls back, releases the connection, runs
 * `afterRelease` and then rethrows `response`, the error the client gets.
 */
export class AfterReleaseError extends Error {
  constructor(
    readonly response: Error,
    readonly afterRelease: () => Promise<unknown>,
  ) {
    super(response.message);
    this.name = 'AfterReleaseError';
  }
}
