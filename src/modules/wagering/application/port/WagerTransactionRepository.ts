import type { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';

export const WAGER_TRANSACTION_REPOSITORY = Symbol('WAGER_TRANSACTION_REPOSITORY');

export interface WagerTransactionRepository {
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null>;

  findById(id: string): Promise<WagerTransaction | null>;

  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;

  insert(transaction: WagerTransaction): Promise<void>;

  update(transaction: WagerTransaction): Promise<void>;

  /** A garantia real é o índice único parcial; isto só troca o erro por um failureCode. */
  hasProcessedReversal(referenceTransactionId: string, kind: string): Promise<boolean>;

  /** `SKIP LOCKED` para múltiplos workers não disputarem as mesmas linhas. */
  claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]>;
}
