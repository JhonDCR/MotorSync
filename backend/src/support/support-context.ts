import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager } from 'typeorm';
import type { SupportAgent } from './support-agent.js';

/** Per-request context published by SupportTransactionInterceptor (research R3, R4). */
export interface SupportContext {
  /** Manager of the request transaction, with no workshop pinned. */
  manager: EntityManager;
  /** Support agent refreshed from the database. */
  agent: SupportAgent;
  /** Client IP of the request (Express req.ip); null if unknown. */
  ip: string | null;
}

export const supportStorage = new AsyncLocalStorage<SupportContext>();

export function getSupportContext(): SupportContext {
  const context = supportStorage.getStore();
  if (!context) {
    throw new Error(
      'No support context: this code must run inside a support request',
    );
  }
  return context;
}

/** EntityManager of the current support request transaction. Throws outside a request. */
export function getSupportManager(): EntityManager {
  return getSupportContext().manager;
}
