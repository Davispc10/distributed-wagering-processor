import type { Journal } from '@modules/wallet/domain/Journal';

export const JOURNAL_REPOSITORY = Symbol('JOURNAL_REPOSITORY');

export interface JournalRepository {
  /** Na MESMA transação SQL da movimentação financeira. */
  record(journal: Journal): Promise<void>;
}
