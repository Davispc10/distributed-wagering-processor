import { GetQueueAttributesCommand, type QueueAttributeName } from '@aws-sdk/client-sqs';
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '@shared/config/AppConfig';
import { SqsClientProvider } from '@shared/messaging/SqsClientProvider';
import { LoggerService } from '@shared/observability/LoggerService';
import { MetricsService } from '@shared/observability/MetricsService';

const STATE_BY_ATTRIBUTE: ReadonlyArray<readonly [QueueAttributeName, string]> = [
  ['ApproximateNumberOfMessages', 'visible'],
  ['ApproximateNumberOfMessagesNotVisible', 'not_visible'],
  ['ApproximateNumberOfMessagesDelayed', 'delayed'],
];

/**
 * Profundidade de fila não existe como evento: só dá para amostrar. Roda no
 * processo worker porque é lá que já vivem as outras métricas de mensageria.
 *
 * Os dois workers reportam a MESMA série — os painéis usam `max by (queue)`,
 * nunca `sum`, senão o número aparece dobrado.
 */
@Injectable()
export class QueueDepthWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly log;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly sqs: SqsClientProvider,
    private readonly config: AppConfig,
    private readonly metrics: MetricsService,
    logger: LoggerService,
  ) {
    this.log = logger.child('QueueDepthWorker');
  }

  onModuleInit(): void {
    this.scheduleNext(0);
    this.log.info('queue depth worker iniciado');
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
    this.log.info('queue depth worker parado');
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
      void this.inFlight;
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      await this.sample();
    } catch (error: unknown) {
      // Broker fora do ar não pode derrubar o worker: o gauge segura o último
      // valor conhecido e o próximo ciclo tenta de novo.
      this.log.warn({ err: this.messageOf(error) }, 'amostragem de profundidade falhou');
    } finally {
      this.running = false;
      this.scheduleNext(this.config.queueDepth.pollIntervalMs);
    }
  }

  private async sample(): Promise<void> {
    const { wagerTransactions, wagerTransactionsDlq, wagerEvents } = this.config.queues;

    for (const queue of [wagerTransactions, wagerTransactionsDlq, wagerEvents]) {
      if (this.stopped) return;
      await this.sampleQueue(queue);
    }
  }

  private async sampleQueue(queue: string): Promise<void> {
    const queueUrl = await this.sqs.queueUrl(queue);

    const res = await this.sqs.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: STATE_BY_ATTRIBUTE.map(([attribute]) => attribute),
      }),
    );

    for (const [attribute, state] of STATE_BY_ATTRIBUTE) {
      const raw = res.Attributes?.[attribute];
      // Atributo ausente é diferente de zero: não sobrescreve o último valor.
      if (raw === undefined) continue;

      const value = Number(raw);
      if (!Number.isFinite(value)) continue;

      this.metrics.sqsQueueDepth.set({ queue, state }, value);
    }
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
