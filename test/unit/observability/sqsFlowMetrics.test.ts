import { describe, expect, it } from 'bun:test';
import { AppConfig } from '@shared/config/AppConfig';
import { loadEnv } from '@shared/config/env';
import type { SqsClientProvider } from '@shared/messaging/SqsClientProvider';
import { MetricsService } from '@shared/observability/MetricsService';
import { SqsEventPublisher } from '@modules/messaging/infra/sqs/SqsEventPublisher';
import type { OutboxMessage } from '@modules/messaging/domain/OutboxMessage';

const makeConfig = (): AppConfig => new AppConfig(loadEnv({}));

/** O publisher só usa `client.send` e `queueUrl`; o resto do provider é irrelevante aqui. */
const makeSqs = (send: (command: unknown) => Promise<unknown>): SqsClientProvider =>
  ({
    client: { send },
    queueUrl: (name: string) => Promise.resolve(`http://localhost:4566/000000000000/${name}`),
  }) as unknown as SqsClientProvider;

const makeMessage = (): OutboxMessage =>
  ({
    id: 'evt-1',
    aggregateId: 'w-1',
    eventType: 'WagerTransactionProcessed',
    payload: { correlationId: 'corr-1' },
  }) as unknown as OutboxMessage;

const counterValue = async (metrics: MetricsService, name: string): Promise<number> => {
  const metric = metrics.registry.getSingleMetric(name);
  if (!metric) return 0;
  const snapshot = await metric.get();
  return snapshot.values[0]?.value ?? 0;
};

describe('métricas de fluxo SQS', () => {
  it('conta a mensagem publicada com a fila como label', async () => {
    const metrics = new MetricsService();
    const publisher = new SqsEventPublisher(
      makeSqs(() => Promise.resolve({})),
      makeConfig(),
      metrics,
    );

    await publisher.publish(makeMessage());

    const snapshot = await metrics.registry.getSingleMetric('sqs_messages_sent_total')?.get();
    expect(snapshot?.values[0]?.value).toBe(1);
    expect(snapshot?.values[0]?.labels).toEqual({ queue: 'wager-events.fifo' });
  });

  it('NÃO conta quando o envio falha — senão o painel mentiria sobre o que saiu', async () => {
    const metrics = new MetricsService();
    const publisher = new SqsEventPublisher(
      makeSqs(() => Promise.reject(new Error('SQS indisponível'))),
      makeConfig(),
      metrics,
    );

    await expect(publisher.publish(makeMessage())).rejects.toThrow('SQS indisponível');
    expect(await counterValue(metrics, 'sqs_messages_sent_total')).toBe(0);
  });
});
