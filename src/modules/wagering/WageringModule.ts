import { Module } from '@nestjs/common';
import { KernelModule } from '@modules/kernel/KernelModule';
import { MessagingModule } from '@modules/messaging/MessagingModule';
import { WalletModule } from '@modules/wallet/WalletModule';
import { ReferenceResolver } from './application/service/ReferenceResolver';
import { WagerRuleEngine } from './application/service/WagerRuleEngine';
import { GetWagerTransactionUseCase } from './application/usecase/GetWagerTransactionUseCase';
import { RecordFailedWagerTransactionUseCase } from './application/usecase/RecordFailedWagerTransactionUseCase';
import { SubmitWagerTransactionUseCase } from './application/usecase/SubmitWagerTransactionUseCase';
import { WagerTransactionPersistenceModule } from './infra/persistence/WagerTransactionPersistenceModule';

/**
 * Exporta o `SubmitWagerTransactionUseCase` para que o controller HTTP e o
 * consumidor SQS usem a mesma instância — por isso a lógica não vive no controller.
 */
@Module({
  imports: [KernelModule, MessagingModule, WalletModule, WagerTransactionPersistenceModule],
  providers: [
    WagerRuleEngine,
    ReferenceResolver,
    SubmitWagerTransactionUseCase,
    RecordFailedWagerTransactionUseCase,
    GetWagerTransactionUseCase,
  ],
  exports: [
    WagerTransactionPersistenceModule,
    SubmitWagerTransactionUseCase,
    RecordFailedWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    ReferenceResolver,
    WagerRuleEngine,
  ],
})
export class WageringModule {}
