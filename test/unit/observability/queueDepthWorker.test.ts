import { describe, expect, it } from 'bun:test';
import { AppConfig } from '@shared/config/AppConfig';
import { loadEnv } from '@shared/config/env';
import type { SqsClientProvider } from '@shared/messaging/SqsClientProvider';
import { LoggerService } from '@shared/observability/LoggerService';
import { MetricsService } from '@shared/observability/MetricsService';
import { QueueDepthWorker } from '@modules/messaging/infra/worker/QueueDepthWorker';

const makeConfig = (): AppConfig => new AppConfig(loadEnv({}));

const makeSqs = (attributes: Record<string, string>): SqsClientProvider =>
  ({
    client: { send: () => Promise.resolve({ Attributes: attributes }) },
    queueUrl: (name: string) => Promise.resolve(`http://localhost:4566/000000000000/${name}`),
  }) as unknown as SqsClientProvider;

const makeWorker = (
  attributes: Record<string, string>,
  metrics: MetricsService,
): QueueDepthWorker => {
  const config = makeConfig();
  return new QueueDepthWorker(makeSqs(attributes), config, metrics, new LoggerService(config));
};

const gaugeFor = async (
  metrics: MetricsService,
  queue: string,
  state: string,
): Promise<number | undefined> => {
  const snapshot = await metrics.registry.getSingleMetric('sqs_queue_depth')?.get();
  return snapshot?.values.find((v) => v.labels['queue'] === queue && v.labels['state'] === state)
    ?.value;
};

/** `sample()` é privado: o teste exercita um ciclo sem depender do agendador. */
const sampleOnce = (worker: QueueDepthWorker): Promise<void> =>
  (worker as unknown as { sample(): Promise<void> }).sample();

describe('QueueDepthWorker', () => {
  it('mapeia os três atributos do SQS para os estados do gauge', async () => {
    const metrics = new MetricsService();
    const worker = makeWorker(
      {
        ApproximateNumberOfMessages: '7',
        ApproximateNumberOfMessagesNotVisible: '2',
        ApproximateNumberOfMessagesDelayed: '1',
      },
      metrics,
    );

    await sampleOnce(worker);

    expect(await gaugeFor(metrics, 'wager-transactions.fifo', 'visible')).toBe(7);
    expect(await gaugeFor(metrics, 'wager-transactions.fifo', 'not_visible')).toBe(2);
    expect(await gaugeFor(metrics, 'wager-transactions.fifo', 'delayed')).toBe(1);
  });

  it('cobre as três filas: entrada, DLQ e eventos', async () => {
    const metrics = new MetricsService();
    const worker = makeWorker({ ApproximateNumberOfMessages: '3' }, metrics);

    await sampleOnce(worker);

    expect(await gaugeFor(metrics, 'wager-transactions.fifo', 'visible')).toBe(3);
    expect(await gaugeFor(metrics, 'wager-transactions-dlq.fifo', 'visible')).toBe(3);
    expect(await gaugeFor(metrics, 'wager-events.fifo', 'visible')).toBe(3);
  });

  it('ignora atributo ausente em vez de zerar o gauge — ausência não é zero', async () => {
    const metrics = new MetricsService();
    const worker = makeWorker({ ApproximateNumberOfMessages: '5' }, metrics);

    await sampleOnce(worker);

    expect(await gaugeFor(metrics, 'wager-transactions.fifo', 'not_visible')).toBeUndefined();
  });

  it('para limpo no shutdown sem deixar timer pendurado', async () => {
    const metrics = new MetricsService();
    const worker = makeWorker({ ApproximateNumberOfMessages: '0' }, metrics);

    worker.onModuleInit();
    await worker.onApplicationShutdown();

    // Um segundo shutdown não pode explodir nem reagendar nada.
    await worker.onApplicationShutdown();
  });
});
