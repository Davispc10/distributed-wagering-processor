import { Inject, Injectable } from '@nestjs/common';
import { LoggerService } from '@shared/observability/LoggerService';
import { MetricsService } from '@shared/observability/MetricsService';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import type { Money } from '@modules/kernel/domain/Money';
import { BusinessRuleError } from '@modules/kernel/domain/error/KernelErrors';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '@modules/wallet/application/port/WalletRepository';

export interface ReconcileWalletOutput {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Divergências NÃO são corrigidas silenciosamente: são logadas, contabilizadas
 * e sinalizadas. Corrigir automaticamente esconderia a causa.
 */
@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    private readonly metrics: MetricsService,
    private readonly logger: LoggerService,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletOutput> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new BusinessRuleError(FailureCode.WalletNotFound, `wallet ${walletId} não encontrada`);
    }

    const { total, entryCount } = await this.wallets.sumLedger(walletId, wallet.currency);
    const difference = wallet.balance.subtract(total);
    const consistent = difference.isZero();

    if (!consistent) {
      this.metrics.reconciliationMismatchTotal.inc();
      this.logger
        .child('ReconcileWalletUseCase')
        .error(
          { walletId, checkedEntries: entryCount, walletVersion: wallet.version },
          'divergência entre saldo materializado e ledger — NÃO corrigida automaticamente',
        );
    }

    return {
      walletId,
      storedBalance: wallet.balance,
      calculatedBalance: total,
      difference,
      consistent,
      checkedEntries: entryCount,
    };
  }
}
