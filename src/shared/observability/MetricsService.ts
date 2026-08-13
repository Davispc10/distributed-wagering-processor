import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry: Registry;

  readonly transactionsTotal: Counter<'kind' | 'status'>;

  readonly duplicatesDetected: Counter<'source'>;

  readonly retriesTotal: Counter<'reason'>;

  readonly dlqMessagesTotal: Counter<'queue'>;

  readonly sqsMessagesSentTotal: Counter<'queue'>;
  readonly sqsMessagesReceivedTotal: Counter<'queue'>;
  readonly sqsMessagesDeletedTotal: Counter<'queue'>;

  readonly lockConflictsTotal: Counter<'operation'>;

  readonly outboxLagSeconds: Gauge<string>;
  readonly outboxPendingTotal: Gauge<string>;

  readonly sqsQueueDepth: Gauge<'queue' | 'state'>;

  readonly processingDuration: Histogram<'kind' | 'source' | 'outcome'>;

  readonly reconciliationMismatchTotal: Counter<string>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry });

    this.transactionsTotal = new Counter({
      name: 'wager_transactions_total',
      help: 'Transações de aposta por kind e status final',
      labelNames: ['kind', 'status'] as const,
      registers: [this.registry],
    });

    this.duplicatesDetected = new Counter({
      name: 'wager_duplicates_total',
      help: 'Duplicatas detectadas, por origem (http, sqs, inbox, payload_conflict)',
      labelNames: ['source'] as const,
      registers: [this.registry],
    });

    this.retriesTotal = new Counter({
      name: 'wager_retries_total',
      help: 'Retries por motivo (transient_db, sqs_visibility, outbox_publish, pending_reference)',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });

    this.dlqMessagesTotal = new Counter({
      name: 'sqs_dlq_messages_total',
      help: 'Mensagens enviadas para a DLQ',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    });

    this.sqsMessagesSentTotal = new Counter({
      name: 'sqs_messages_sent_total',
      help: 'Mensagens publicadas no SQS, por fila',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    });

    this.sqsMessagesReceivedTotal = new Counter({
      name: 'sqs_messages_received_total',
      help: 'Mensagens recebidas do SQS, por fila. Long polling vazio não conta',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    });

    this.sqsMessagesDeletedTotal = new Counter({
      name: 'sqs_messages_deleted_total',
      help: 'Mensagens deletadas do SQS após ack, por fila',
      labelNames: ['queue'] as const,
      registers: [this.registry],
    });

    this.lockConflictsTotal = new Counter({
      name: 'wallet_lock_conflicts_total',
      help: 'Conflitos de lock de wallet (lock_timeout, deadlock, serialization failure)',
      labelNames: ['operation'] as const,
      registers: [this.registry],
    });

    this.outboxLagSeconds = new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Idade do evento não publicado mais antigo, em segundos',
      registers: [this.registry],
    });

    this.outboxPendingTotal = new Gauge({
      name: 'outbox_pending_total',
      help: 'Eventos aguardando publicação',
      registers: [this.registry],
    });

    this.sqsQueueDepth = new Gauge({
      name: 'sqs_queue_depth',
      help: 'Mensagens na fila por estado. Aproximado por natureza no SQS',
      labelNames: ['queue', 'state'] as const,
      registers: [this.registry],
    });

    this.processingDuration = new Histogram({
      name: 'wager_processing_duration_seconds',
      help: 'Latência de processamento de uma transação',
      labelNames: ['kind', 'source', 'outcome'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.reconciliationMismatchTotal = new Counter({
      name: 'reconciliation_mismatch_total',
      help: 'Reconciliações em que o saldo materializado divergiu do ledger',
      registers: [this.registry],
    });
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
