import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '@shared/config/AppConfig';
import { SqsClientProvider } from '@shared/messaging/SqsClientProvider';
import { MetricsService } from '@shared/observability/MetricsService';
import type { EventPublisher } from '@modules/messaging/application/port/MessagingPorts';
import type { OutboxMessage } from '@modules/messaging/domain/OutboxMessage';

/**
 * `MessageGroupId = aggregateId` ordena por wallet sem serializar wallets
 * diferentes. A dedup por `eventId` é otimização; quem garante é o inbox.
 */
@Injectable()
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SqsClientProvider,
    private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    const queue = this.config.queues.wagerEvents;
    const queueUrl = await this.sqs.queueUrl(queue);

    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );

    // Depois do send: falha de rede não pode aparecer como mensagem publicada.
    this.metrics.sqsMessagesSentTotal.inc({ queue });
  }
}
