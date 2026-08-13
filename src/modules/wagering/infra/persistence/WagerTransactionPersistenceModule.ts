import { Module } from '@nestjs/common';
import { WAGER_TRANSACTION_REPOSITORY } from '@modules/wagering/application/port/WagerTransactionRepository';
import { MikroOrmWagerTransactionRepository } from './MikroOrmWagerTransactionRepository';

/**
 * Só o binding, sem use case: quebra o ciclo entre WalletModule (que grava a
 * transação OPENING) e WageringModule (que precisa do WALLET_REPOSITORY).
 * `forwardRef` esconderia o acoplamento em vez de resolvê-lo.
 */
@Module({
  providers: [
    { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroOrmWagerTransactionRepository },
  ],
  exports: [WAGER_TRANSACTION_REPOSITORY],
})
export class WagerTransactionPersistenceModule {}
