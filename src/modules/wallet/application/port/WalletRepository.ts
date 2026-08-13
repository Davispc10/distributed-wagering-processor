import type { Money } from '@modules/kernel/domain/Money';
import type { Wallet } from '@modules/wallet/domain/Wallet';
import type { WalletLedgerEntry } from '@modules/wallet/domain/WalletLedgerEntry';

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor?: string;
}

export interface LedgerQuery {
  walletId: string;
  limit: number;
  cursor?: string;
}

export interface LedgerSum {
  total: Money;
  entryCount: number;
}

export interface WalletRepository {
  /**
   * SEMPRE o primeiro lock da transação: a ordem fixa elimina deadlock cíclico.
   * Serializa a mesma wallet sem impedir que wallets diferentes sigam juntas.
   */
  findByIdForUpdate(walletId: string): Promise<Wallet | null>;

  findById(walletId: string): Promise<Wallet | null>;

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;

  insert(wallet: Wallet): Promise<void>;

  update(wallet: Wallet): Promise<void>;

  insertLedgerEntry(entry: WalletLedgerEntry): Promise<void>;

  listLedger(query: LedgerQuery): Promise<LedgerPage>;

  /** Base da reconciliação. */
  sumLedger(walletId: string, currency: string): Promise<LedgerSum>;
}
