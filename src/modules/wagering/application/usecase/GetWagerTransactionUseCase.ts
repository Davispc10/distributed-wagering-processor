import { Inject, Injectable } from '@nestjs/common';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { BusinessRuleError } from '@modules/kernel/domain/error/KernelErrors';
import type { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@modules/wagering/application/port/WagerTransactionRepository';

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
  ) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.transactions.findById(transactionId);
    if (!transaction) {
      throw new BusinessRuleError(
        FailureCode.ValidationError,
        `transação ${transactionId} não encontrada`,
      );
    }
    return transaction;
  }

  async byProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const transaction = await this.transactions.findByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    if (!transaction) {
      throw new BusinessRuleError(
        FailureCode.ValidationError,
        `transação ${externalTransactionId} do provedor ${providerId} não encontrada`,
      );
    }
    return transaction;
  }
}
