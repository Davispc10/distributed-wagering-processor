import { Module } from '@nestjs/common';
import { WageringModule } from '@modules/wagering/WageringModule';
import { WalletModule } from '@modules/wallet/WalletModule';
import { MessagingModule } from '@modules/messaging/MessagingModule';
import { PendingReferenceWorker } from '@modules/wagering/infra/worker/PendingReferenceWorker';
import { ErrorClassifier } from './ErrorClassifier';
import { WagerTransactionConsumer } from './WagerTransactionConsumer';

/**
 * "Worker" e não "Consumer": além do consumidor SQS, registra o
 * `PendingReferenceWorker`, que varre o banco por polling e não toca em fila.
 */
@Module({
  imports: [WageringModule, WalletModule, MessagingModule],
  providers: [ErrorClassifier, WagerTransactionConsumer, PendingReferenceWorker],
})
export class WageringWorkerModule {}
