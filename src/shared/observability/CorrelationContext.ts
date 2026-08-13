import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Propaga o `correlationId` sem passar parâmetro pela stack inteira, tanto no
 * HTTP quanto por mensagem no consumidor SQS.
 */
export interface CorrelationScope {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<CorrelationScope>();

export const CorrelationContext = {
  run<T>(scope: Partial<CorrelationScope>, fn: () => T): T {
    const resolved: CorrelationScope = {
      ...storage.getStore(),
      ...scope,
      correlationId: scope.correlationId ?? storage.getStore()?.correlationId ?? randomUUID(),
    };
    return storage.run(resolved, fn);
  },

  get(): CorrelationScope | undefined {
    return storage.getStore();
  },

  get correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },

  /** Para `transactionId` e `walletId`, que só são conhecidos no meio do processamento. */
  enrich(fields: Omit<Partial<CorrelationScope>, 'correlationId'>): void {
    const current = storage.getStore();
    if (!current) return;
    Object.assign(current, fields);
  },

  newCorrelationId(): string {
    return randomUUID();
  },
};
