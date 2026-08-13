import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '@shared/config/AppConfig';
import { SqsClientProvider } from '@shared/messaging/SqsClientProvider';
import { CorrelationContext } from '@shared/observability/CorrelationContext';
import { LoggerService } from '@shared/observability/LoggerService';
import { MetricsService } from '@shared/observability/MetricsService';
import { Money } from '@modules/kernel/domain/Money';
import { ValidationError } from '@modules/kernel/domain/error/KernelErrors';
import { SubmitWagerTransactionInput } from '@modules/wagering/application/dto/SubmitWagerTransactionInput';
import { RecordFailedWagerTransactionUseCase } from '@modules/wagering/application/usecase/RecordFailedWagerTransactionUseCase';
import { SubmitWagerTransactionUseCase } from '@modules/wagering/application/usecase/SubmitWagerTransactionUseCase';
import type { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';
import { ErrorClassifier } from './ErrorClassifier';
import { wagerTransactionMessageSchema } from './wagerMessageSchema';

/**
 * Chama o MESMO `SubmitWagerTransactionUseCase` do controller HTTP; o que muda é
 * só a tradução do envelope e o ciclo de ack.
 */
@Injectable()
export class WagerTransactionConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly log;
  private stopped = false;
  private loop: Promise<void> = Promise.resolve();
  /** Recebidos mas ainda não processados: devolvidos no shutdown. */
  private readonly pendingHandles = new Set<string>();

  constructor(
    private readonly sqs: SqsClientProvider,
    private readonly config: AppConfig,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly recordFailed: RecordFailedWagerTransactionUseCase,
    private readonly classifier: ErrorClassifier,
    private readonly metrics: MetricsService,
    logger: LoggerService,
  ) {
    this.log = logger.child('WagerTransactionConsumer');
  }

  onModuleInit(): void {
    this.loop = this.run();
    void this.loop;
    this.log.info({ queue: this.config.queues.wagerTransactions }, 'consumidor iniciado');
  }

  /**
   * Devolver a visibilidade das mensagens não iniciadas faz outra instância
   * pegá-las já, em vez de esperar o visibility timeout expirar.
   */
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    const deadline = this.config.shutdownGracePeriodMs;

    await Promise.race([this.loop, new Promise<void>((resolve) => setTimeout(resolve, deadline))]);

    await this.releasePending();
    this.log.info('consumidor parado');
  }

  private async run(): Promise<void> {
    const queueUrl = await this.sqs.queueUrl(this.config.queues.wagerTransactions);

    while (!this.stopped) {
      try {
        const messages = await this.receive(queueUrl);
        for (const message of messages) {
          if (this.stopped) {
            this.trackPending(message);
            continue;
          }
          await this.handle(queueUrl, message);
        }
      } catch (error: unknown) {
        if (this.stopped) break;
        this.log.error({ err: this.messageOf(error) }, 'falha no polling; nova tentativa em 1s');
        await this.sleep(1_000);
      }
    }
  }

  private async receive(queueUrl: string): Promise<Message[]> {
    const res = await this.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        WaitTimeSeconds: this.config.queues.waitTimeSeconds,
        MaxNumberOfMessages: this.config.queues.maxMessages,
        // `ApproximateReceiveCount` alimenta o backoff da visibilidade.
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    const messages = res.Messages ?? [];

    // Só conta o que veio: long polling que volta vazio viraria ruído no gráfico.
    if (messages.length > 0) {
      this.metrics.sqsMessagesReceivedTotal.inc(
        { queue: this.config.queues.wagerTransactions },
        messages.length,
      );
    }

    return messages;
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle;
    if (receiptHandle === undefined) return;

    const startedAt = performance.now();
    const parsed = this.parse(message);

    if (parsed === null) {
      // Irrecuperável: DLQ direto, sem gastar as 5 tentativas.
      await this.sendToDlq(queueUrl, message, receiptHandle, 'payload inválido');
      return;
    }

    const { data, messageId } = parsed;
    const correlationId = data.correlationId ?? CorrelationContext.newCorrelationId();

    await CorrelationContext.run(
      { correlationId, messageId, walletId: data.walletId, providerId: data.providerId },
      async () => {
        // Fora do `try` interno para que o ramo `permanent` consiga auditar a
        // operação como FAILED em vez de só descartá-la na DLQ.
        let input: SubmitWagerTransactionInput | undefined;

        try {
          input = SubmitWagerTransactionInput.fromMessage({
            idempotencyKey: data.idempotencyKey,
            providerId: data.providerId,
            externalTransactionId: data.externalTransactionId,
            playerId: data.playerId,
            walletId: data.walletId,
            roundId: data.roundId,
            gameId: data.gameId,
            kind: data.kind as WagerTransactionKind,
            money: Money.from(data.money),
            ...(data.referenceExternalTransactionId !== undefined
              ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
              : {}),
            messageId,
            correlationId,
          });

          const result = await this.submit.execute(input);

          // ACK SOMENTE APÓS O COMMIT — o use case já commitou ao retornar.
          await this.ack(queueUrl, receiptHandle);

          this.metrics.processingDuration.observe(
            { kind: data.kind, source: 'sqs', outcome: result.outcome },
            (performance.now() - startedAt) / 1000,
          );
          this.log.info({ outcome: result.outcome, kind: data.kind }, 'mensagem processada');
        } catch (error: unknown) {
          await this.handleFailure(queueUrl, message, receiptHandle, error, input);
        }
      },
    );
  }

  private async handleFailure(
    queueUrl: string,
    message: Message,
    receiptHandle: string,
    error: unknown,
    input?: SubmitWagerTransactionInput,
  ): Promise<void> {
    const classification = this.classifier.classify(error);
    const detail = this.messageOf(error);

    switch (classification) {
      case 'business':
        // Terminal: o REJECTED já foi commitado; manter na fila só a faria voltar.
        await this.ack(queueUrl, receiptHandle);
        this.log.warn({ err: detail }, 'mensagem rejeitada por regra de negócio; ack');
        return;

      case 'permanent': {
        // Erro permanente é terminal E auditável: a linha FAILED responde ao
        // provedor em `GET /providers/:id/wagering/transactions/:externalId`,
        // coisa que uma mensagem parada na DLQ não faz.
        if (input) {
          const outcome = await this.recordFailed.execute(input);
          this.log.warn(
            { idempotencyKey: input.idempotencyKey, auditOutcome: outcome, err: detail },
            'erro permanente; transação auditada antes da DLQ',
          );
        }
        await this.sendToDlq(queueUrl, message, receiptHandle, detail);
        return;
      }

      case 'transient': {
        const receiveCount = Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1');
        // Backoff exponencial na visibilidade, com teto de 5 min.
        const visibility = Math.min(2 ** receiveCount, 300);

        await this.sqs.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: visibility,
          }),
        );

        // `lockConflictsTotal` é contada no `MikroOrmUnitOfWork`, onde o
        // SQLSTATE ainda está disponível — e vale para HTTP e SQS.
        this.metrics.retriesTotal.inc({ reason: 'transient' });

        this.log.warn(
          { err: detail, receiveCount, visibilityTimeout: visibility },
          'falha transitória; visibilidade devolvida com backoff',
        );
        return;
      }
    }
  }

  private parse(message: Message): { messageId: string; data: ParsedData } | null {
    try {
      const body: unknown = JSON.parse(message.Body ?? '{}');
      const result = wagerTransactionMessageSchema.safeParse(body);
      if (!result.success) return null;
      return { messageId: result.data.messageId, data: result.data.data as ParsedData };
    } catch {
      return null;
    }
  }

  private async ack(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.sqs.client.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }),
    );
    this.pendingHandles.delete(receiptHandle);
    this.metrics.sqsMessagesDeletedTotal.inc({ queue: this.config.queues.wagerTransactions });
  }

  /**
   * A redrive policy do broker levaria para a DLQ após 5 recebimentos, mas
   * esperar por um payload que nunca será válido só atrasa o diagnóstico.
   */
  private async sendToDlq(
    queueUrl: string,
    message: Message,
    receiptHandle: string,
    reason: string,
  ): Promise<void> {
    const dlqUrl = await this.sqs.queueUrl(this.config.queues.wagerTransactionsDlq);

    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? '{}',
        MessageGroupId: 'dlq',
        MessageDeduplicationId: message.MessageId ?? `${Date.now()}`,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 256) },
        },
      }),
    );

    await this.ack(queueUrl, receiptHandle);
    this.metrics.dlqMessagesTotal.inc({ queue: this.config.queues.wagerTransactions });
    this.log.error({ reason }, 'mensagem enviada para a DLQ');
  }

  private trackPending(message: Message): void {
    if (message.ReceiptHandle !== undefined) this.pendingHandles.add(message.ReceiptHandle);
  }

  private async releasePending(): Promise<void> {
    if (this.pendingHandles.size === 0) return;

    const queueUrl = await this.sqs.queueUrl(this.config.queues.wagerTransactions);
    await Promise.allSettled(
      [...this.pendingHandles].map((handle) =>
        this.sqs.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: handle,
            VisibilityTimeout: 0,
          }),
        ),
      ),
    );

    this.log.info({ released: this.pendingHandles.size }, 'visibilidade devolvida no shutdown');
    this.pendingHandles.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private messageOf(error: unknown): string {
    if (error instanceof ValidationError) return error.message;
    return error instanceof Error ? error.message : String(error);
  }
}

interface ParsedData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  correlationId?: string;
}
