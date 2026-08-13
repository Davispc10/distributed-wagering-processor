import { Money } from '@modules/kernel/domain/Money';
import { Wallet } from '@modules/wallet/domain/Wallet';
import type { WalletModel } from '@modules/wallet/infra/persistence/model/WalletModel';

/**
 * `numeric(20,2)` chega do driver como string e vai direto para `Money.parse`,
 * sem passar por `number` em nenhum ponto do caminho.
 */
export const WalletMapper = {
  toDomain(model: WalletModel): Wallet {
    return Wallet.rehydrate({
      id: model.id,
      playerId: model.playerId,
      currency: model.currency,
      balance: Money.parse({ amount: model.balanceAmount, currency: model.currency }),
      version: model.version,
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
    });
  },

  applyToModel(model: WalletModel, wallet: Wallet): WalletModel {
    model.id = wallet.id;
    model.playerId = wallet.playerId;
    model.currency = wallet.currency;
    model.balanceAmount = wallet.balance.toString();
    model.version = wallet.version;
    model.createdAt = wallet.createdAt;
    model.updatedAt = wallet.updatedAt;
    return model;
  },
};
