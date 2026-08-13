import { Module } from '@nestjs/common';
import { KernelModule } from '@modules/kernel/KernelModule';
import { MessagingModule } from '@modules/messaging/MessagingModule';
import { WagerTransactionPersistenceModule } from '@modules/wagering/infra/persistence/WagerTransactionPersistenceModule';
import { JOURNAL_REPOSITORY } from './application/port/JournalRepository';
import { JournalFactory } from './application/service/JournalFactory';
import { WALLET_REPOSITORY } from './application/port/WalletRepository';
import { GetWalletUseCase, ListWalletLedgerUseCase } from './application/usecase/GetWalletUseCase';
import { OpenWalletUseCase } from './application/usecase/OpenWalletUseCase';
import { ReconcileWalletUseCase } from './application/usecase/ReconcileWalletUseCase';
import { MikroOrmJournalRepository } from './infra/persistence/MikroOrmJournalRepository';
import { MikroOrmWalletRepository } from './infra/persistence/MikroOrmWalletRepository';

@Module({
  imports: [KernelModule, MessagingModule, WagerTransactionPersistenceModule],
  providers: [
    { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
    { provide: JOURNAL_REPOSITORY, useClass: MikroOrmJournalRepository },
    JournalFactory,
    OpenWalletUseCase,
    GetWalletUseCase,
    ListWalletLedgerUseCase,
    ReconcileWalletUseCase,
  ],
  exports: [
    WALLET_REPOSITORY,
    JOURNAL_REPOSITORY,
    JournalFactory,
    WagerTransactionPersistenceModule,
    OpenWalletUseCase,
    GetWalletUseCase,
    ListWalletLedgerUseCase,
    ReconcileWalletUseCase,
  ],
})
export class WalletModule {}
