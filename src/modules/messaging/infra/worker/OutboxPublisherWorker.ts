import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '@shared/config/AppConfig';
import { CLOCK, type Clock } from '@shared/Clock';
import { UNIT_OF_WORK, type UnitOfWork } from '@shared/persistence/UnitOfWork';
import { CorrelationContext } from '@shared/observability/CorrelationContext';
import { LoggerService } from '@shared/observability/LoggerService';
import { MetricsService } from '@shared/observability/MetricsService';
import {
  EVENT_PUBLISHER,
  OUTBOX_REPOSITORY,
  type EventPublisher,
  type OutboxRepository,
} from '@modules/messaging/application/port/MessagingPorts';

/**
 * Se o processo morrer entre commit e publicação, o lease expira e outro
 * publisher assume — a duplicata é segura porque o consumidor deduplica.
 *
 * A publicação acontece FORA da transação do claim: manter a transação aberta
 * durante uma chamada de rede seguraria locks pela latência do SQS.
 */
@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly log;
  private readonly workerId: string;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: AppConfig,
    private readonly metrics: MetricsService,
    logger: LoggerService,
  ) {
    this.log = logger.child('OutboxPublisherWorker');
    this.workerId = `${config.instanceId}:outbox`;
  }

  onModuleInit(): void {
    this.scheduleNext(0);
    this.log.info({ workerId: this.workerId }, 'outbox publisher iniciado');
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // Interromper no meio deixaria o lease preso até expirar.
    await this.inFlight;
    this.log.info('outbox publisher parado');
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
      const published = await this.publishBatch();
      await this.reportLag();
      this.scheduleNext(published > 0 ? 0 : this.config.outbox.pollIntervalMs);
    } catch (error: unknown) {
      this.log.error({ err: this.messageOf(error) }, 'ciclo do outbox publisher falhou');
      this.scheduleNext(this.config.outbox.pollIntervalMs);
    } finally {
      this.running = false;
    }
  }

  private async publishBatch(): Promise<number> {
    const now = this.clock.now();
    const { batchSize, leaseSeconds, maxAttempts } = this.config.outbox;

    const batch = await this.uow.run(() =>
      this.outbox.claimBatch(this.workerId, batchSize, leaseSeconds, now),
    );

    if (batch.length === 0) return 0;

    const publishedIds: string[] = [];

    for (const message of batch) {
      if (this.stopped) break;

      await CorrelationContext.run(
        { correlationId: this.correlationIdOf(message.payload), messageId: message.id },
        async () => {
          try {
            await this.publisher.publish(message);
            publishedIds.push(message.id);
          } catch (error: unknown) {
            message.scheduleRetry(this.clock.now());
            this.metrics.retriesTotal.inc({ reason: 'outbox_publish' });

            await this.uow.run(() => this.outbox.scheduleRetry(message));

            const level = message.hasExhaustedAttempts(maxAttempts) ? 'error' : 'warn';
            this.log[level](
              {
                outboxId: message.id,
                eventType: message.eventType,
                attempts: message.attempts,
                err: this.messageOf(error),
              },
              'falha ao publicar evento',
            );
          }
        },
      );
    }

    if (publishedIds.length > 0) {
      // Marcar só APÓS publicar: morrer aqui gera duplicata, não perda.
      await this.uow.run(() => this.outbox.markPublished(publishedIds, this.clock.now()));
    }

    return publishedIds.length;
  }

  /** Roda no UoW mesmo sendo leitura: o EM global recusa operações sem RequestContext. */
  private async reportLag(): Promise<void> {
    const { lag, pending } = await this.uow.run(async () => ({
      lag: await this.outbox.oldestPendingLagSeconds(this.clock.now()),
      pending: await this.outbox.countPending(),
    }));

    this.metrics.outboxLagSeconds.set(lag);
    this.metrics.outboxPendingTotal.set(pending);
  }

  private correlationIdOf(payload: Readonly<Record<string, unknown>>): string {
    const value = payload['correlationId'];
    return typeof value === 'string' ? value : CorrelationContext.newCorrelationId();
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
