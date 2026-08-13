import { Module } from '@nestjs/common';
import { MessagingModule } from '@modules/messaging/MessagingModule';
import { EVENT_PUBLISHER } from '@modules/messaging/application/port/MessagingPorts';
import { SqsEventPublisher } from '@modules/messaging/infra/sqs/SqsEventPublisher';
import { OutboxPublisherWorker } from './OutboxPublisherWorker';

/**
 * Só no `WorkerModule`: rodando também na API, a taxa de publicação de eventos
 * ficaria acoplada à capacidade de tráfego HTTP.
 */
@Module({
  imports: [MessagingModule],
  providers: [{ provide: EVENT_PUBLISHER, useClass: SqsEventPublisher }, OutboxPublisherWorker],
})
export class OutboxPublisherModule {}
