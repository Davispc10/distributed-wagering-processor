import type { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import { Money } from '@modules/kernel/domain/Money';
import { WalletLedgerEntry } from '@modules/wallet/domain/WalletLedgerEntry';
import type { WalletLedgerEntryModel } from '@modules/wallet/infra/persistence/model/WalletLedgerEntryModel';

export const LedgerEntryMapper = {
  toDomain(model: WalletLedgerEntryModel): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: model.id,
      walletId: model.walletId,
      transactionId: model.transactionId,
      direction: model.direction as LedgerDirection,
      money: Money.parse({ amount: model.moneyAmount, currency: model.moneyCurrency }),
      balanceBefore: Money.parse({ amount: model.balanceBefore, currency: model.moneyCurrency }),
      balanceAfter: Money.parse({ amount: model.balanceAfter, currency: model.moneyCurrency }),
      createdAt: model.createdAt,
    });
  },

  applyToModel(model: WalletLedgerEntryModel, entry: WalletLedgerEntry): WalletLedgerEntryModel {
    model.id = entry.id;
    model.walletId = entry.walletId;
    model.transactionId = entry.transactionId;
    model.direction = entry.direction;
    model.moneyAmount = entry.money.toString();
    model.moneyCurrency = entry.money.currency;
    model.balanceBefore = entry.balanceBefore.toString();
    model.balanceAfter = entry.balanceAfter.toString();
    model.createdAt = entry.createdAt;
    return model;
  },
};
