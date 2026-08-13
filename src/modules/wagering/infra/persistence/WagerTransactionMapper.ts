import type { FailureCode } from '@modules/kernel/domain/FailureCode';
import { Money } from '@modules/kernel/domain/Money';
import { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import type { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';
import type { WagerTransactionStatus } from '@modules/wagering/domain/enum/WagerTransactionStatus';
import type { WagerTransactionModel } from '@modules/wagering/infra/persistence/model/WagerTransactionModel';

export const WagerTransactionMapper = {
  toDomain(model: WagerTransactionModel): WagerTransaction {
    const observedBalance =
      model.observedBalanceAmount != null && model.observedBalanceCurrency != null
        ? Money.parse({
            amount: model.observedBalanceAmount,
            currency: model.observedBalanceCurrency,
          })
        : undefined;

    return WagerTransaction.rehydrate({
      id: model.id,
      providerId: model.providerId,
      externalTransactionId: model.externalTransactionId,
      idempotencyKey: model.idempotencyKey,
      payloadHash: model.payloadHash,
      walletId: model.walletId,
      playerId: model.playerId,
      roundId: model.roundId,
      gameId: model.gameId,
      kind: model.kind as WagerTransactionKind,
      money: Money.parse({ amount: model.moneyAmount, currency: model.moneyCurrency }),
      ...(model.referenceExternalTransactionId != null
        ? { referenceExternalTransactionId: model.referenceExternalTransactionId }
        : {}),
      createdAt: model.createdAt,
      status: model.status as WagerTransactionStatus,
      ...(model.referenceTransactionId != null
        ? { referenceTransactionId: model.referenceTransactionId }
        : {}),
      ...(model.failureCode != null ? { failureCode: model.failureCode as FailureCode } : {}),
      ...(model.processedAt != null ? { processedAt: model.processedAt } : {}),
      ...(observedBalance !== undefined ? { observedBalance } : {}),
      referenceAttempts: model.referenceAttempts,
      ...(model.nextAttemptAt != null ? { nextAttemptAt: model.nextAttemptAt } : {}),
    });
  },

  applyToModel(model: WagerTransactionModel, tx: WagerTransaction): WagerTransactionModel {
    model.id = tx.id;
    model.providerId = tx.providerId;
    model.externalTransactionId = tx.externalTransactionId;
    model.idempotencyKey = tx.idempotencyKey;
    model.payloadHash = tx.payloadHash;
    model.walletId = tx.walletId;
    model.playerId = tx.playerId;
    model.roundId = tx.roundId;
    model.gameId = tx.gameId;
    model.kind = tx.kind;
    model.moneyAmount = tx.money.toString();
    model.moneyCurrency = tx.money.currency;
    model.referenceExternalTransactionId = tx.referenceExternalTransactionId ?? null;
    model.referenceTransactionId = tx.referenceTransactionId ?? null;
    model.status = tx.status;
    model.failureCode = tx.failureCode ?? null;
    model.observedBalanceAmount = tx.observedBalance?.toString() ?? null;
    model.observedBalanceCurrency = tx.observedBalance?.currency ?? null;
    model.referenceAttempts = tx.referenceAttempts;
    model.nextAttemptAt = tx.nextAttemptAt ?? null;
    model.createdAt = tx.createdAt;
    model.processedAt = tx.processedAt ?? null;
    return model;
  },
};
