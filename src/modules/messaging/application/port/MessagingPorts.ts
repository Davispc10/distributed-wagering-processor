import type { IntegrationEvent } from '@modules/kernel/domain/event/IntegrationEvent';
import type { InboxMessage } from '@modules/messaging/domain/InboxMessage';
import type { OutboxMessage } from '@modules/messaging/domain/OutboxMessage';

export const INBOX_REPOSITORY = Symbol('INBOX_REPOSITORY');
export const OUTBOX_REPOSITORY = Symbol('OUTBOX_REPOSITORY');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

export type InboxClaim =
  /** Primeira vez: siga o processamento com esta instância da mensagem. */
  | { outcome: 'claimed'; message: InboxMessage }
  /** Já processada anteriormente: apenas dê ack, sem reprocessar. */
  | { outcome: 'already_processed'; message: InboxMessage }
  /** Outra instância está processando agora: devolva a visibilidade. */
  | { outcome: 'in_flight' };

export interface InboxRepository {
  /** A corrida entre duas entregas da mesma mensagem é resolvida pelo banco. */
  claim(message: InboxMessage): Promise<InboxClaim>;

  /** Persiste o `processedAt` já aplicado na entidade. */
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  /** Na MESMA transação da mudança financeira. */
  enqueue(events: IntegrationEvent<unknown>[]): Promise<void>;

  /** `SKIP LOCKED` permite N publishers sem que um espere o outro. */
  claimBatch(
    workerId: string,
    batchSize: number,
    leaseSeconds: number,
    now: Date,
  ): Promise<OutboxMessage[]>;

  markPublished(ids: string[], at: Date): Promise<void>;

  scheduleRetry(message: OutboxMessage): Promise<void>;

  /** Idade do evento não publicado mais antigo, em segundos. */
  oldestPendingLagSeconds(now: Date): Promise<number>;

  countPending(): Promise<number>;
}

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
