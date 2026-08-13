import { Inject, Injectable } from '@nestjs/common';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { BusinessRuleError } from '@modules/kernel/domain/error/KernelErrors';
import type { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import {
  REFUNDABLE_KINDS,
  ROLLBACKABLE_KINDS,
  WagerTransactionKind,
} from '@modules/wagering/domain/enum/WagerTransactionKind';
import { WagerTransactionStatus } from '@modules/wagering/domain/enum/WagerTransactionStatus';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@modules/wagering/application/port/WagerTransactionRepository';

export type ReferenceResolution =
  | { outcome: 'resolved'; reference: WagerTransaction }
  /** A referência ainda não chegou — reprocessar depois (seção 7.8). */
  | { outcome: 'not_found' };

/**
 * Resolve por `(providerId, referenceExternalTransactionId)` — id do provedor,
 * não interno. A referência precisa ser do mesmo provider, player, wallet,
 * moeda e rodada: sem isso, adivinhar um id externo permitiria reverter
 * transação de outro provedor ou jogador.
 */
@Injectable()
export class ReferenceResolver {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
  ) {}

  async resolve(transaction: WagerTransaction): Promise<ReferenceResolution> {
    const externalId = transaction.referenceExternalTransactionId;
    if (externalId === undefined) {
      throw new BusinessRuleError(
        FailureCode.ReferenceRequired,
        `${transaction.kind} exige referenceExternalTransactionId`,
      );
    }

    const reference = await this.transactions.findByProviderAndExternalId(
      transaction.providerId,
      externalId,
    );

    if (!reference) return { outcome: 'not_found' };

    this.assertScope(transaction, reference);
    this.assertProcessed(reference);
    this.assertReversibleKind(transaction, reference);
    this.assertSameAmount(transaction, reference);
    await this.assertNotAlreadyReversed(transaction, reference);

    return { outcome: 'resolved', reference };
  }

  private assertScope(transaction: WagerTransaction, reference: WagerTransaction): void {
    const mismatches: string[] = [];
    if (reference.providerId !== transaction.providerId) mismatches.push('provider');
    if (reference.playerId !== transaction.playerId) mismatches.push('player');
    if (reference.walletId !== transaction.walletId) mismatches.push('wallet');
    if (reference.money.currency !== transaction.money.currency) mismatches.push('moeda');
    if (reference.roundId !== transaction.roundId) mismatches.push('rodada');

    if (mismatches.length > 0) {
      throw new BusinessRuleError(
        FailureCode.ReferenceScopeMismatch,
        `referência pertence a outro escopo (${mismatches.join(', ')})`,
      );
    }
  }

  private assertProcessed(reference: WagerTransaction): void {
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new BusinessRuleError(
        FailureCode.ReferenceNotProcessed,
        `referência está em ${reference.status}; só é possível reverter uma transação PROCESSED`,
      );
    }
  }

  private assertReversibleKind(transaction: WagerTransaction, reference: WagerTransaction): void {
    const allowed =
      transaction.kind === WagerTransactionKind.Refund ? REFUNDABLE_KINDS : ROLLBACKABLE_KINDS;

    if (!allowed.includes(reference.kind)) {
      throw new BusinessRuleError(
        FailureCode.ReferenceKindNotReversible,
        `${transaction.kind} não pode reverter ${reference.kind} (permitido: ${allowed.join(', ')})`,
      );
    }
  }

  /** Reversão parcial está fora de escopo. */
  private assertSameAmount(transaction: WagerTransaction, reference: WagerTransaction): void {
    if (!transaction.money.equals(reference.money)) {
      throw new BusinessRuleError(
        FailureCode.ReferenceAmountMismatch,
        `valor da reversão (${transaction.money.toString()}) difere do valor da referência ` +
          `(${reference.money.toString()}); reversão parcial não é suportada`,
      );
    }
  }

  /** A garantia real é o índice único parcial; isto só troca o erro por um failureCode. */
  private async assertNotAlreadyReversed(
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): Promise<void> {
    const alreadyReversed = await this.transactions.hasProcessedReversal(
      reference.id,
      transaction.kind,
    );
    if (alreadyReversed) {
      throw new BusinessRuleError(
        FailureCode.ReferenceAlreadyReversed,
        `a referência ${reference.externalTransactionId} já foi revertida por um ${transaction.kind}`,
      );
    }
  }
}
