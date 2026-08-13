import { Injectable } from '@nestjs/common';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import { BusinessRuleError } from '@modules/kernel/domain/error/KernelErrors';
import type { Wallet } from '@modules/wallet/domain/Wallet';
import type { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';

export type WagerDecision =
  | { effect: 'move'; direction: LedgerDirection }
  /** LOSS: registra o desfecho sem tocar no saldo e sem gerar lançamento. */
  | { effect: 'none' };

@Injectable()
export class WagerRuleEngine {
  decide(
    transaction: WagerTransaction,
    wallet: Wallet,
    reference?: WagerTransaction,
  ): WagerDecision {
    if (!transaction.affectsBalance()) {
      return { effect: 'none' };
    }

    const direction = transaction.ledgerDirectionFor(reference);

    if (direction === LedgerDirection.Debit) {
      this.assertSufficientBalance(transaction, wallet);
    }

    return { effect: 'move', direction };
  }

  /**
   * Dois códigos distintos de propósito: aposta sem saldo é situação normal, mas
   * reversão que deixaria a wallet negativa significa que o dinheiro já saiu e a
   * reversão chegou tarde — exige intervenção humana, não retry. Colapsar os dois
   * faria o segundo sumir no ruído do primeiro.
   */
  private assertSufficientBalance(transaction: WagerTransaction, wallet: Wallet): void {
    if (wallet.hasSufficientBalance(transaction.money)) return;

    const isReversal =
      transaction.kind === WagerTransactionKind.Rollback ||
      transaction.kind === WagerTransactionKind.Refund;

    if (isReversal) {
      throw new BusinessRuleError(
        FailureCode.ReversalInsufficientFunds,
        `reversão de ${transaction.money.toString()} deixaria a wallet negativa ` +
          `(saldo ${wallet.balance.toString()}); requer investigação operacional`,
      );
    }

    throw new BusinessRuleError(
      FailureCode.InsufficientFunds,
      `saldo insuficiente: disponível ${wallet.balance.toString()}, requerido ${transaction.money.toString()}`,
    );
  }
}
