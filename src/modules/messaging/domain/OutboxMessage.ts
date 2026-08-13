import type { IntegrationEvent } from '@modules/kernel/domain/event/IntegrationEvent';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Teto do backoff: 5 minutos. Além disso, o problema não é transitório. */
const BACKOFF_CAP_SECONDS = 300;

/**
 * Gravado na mesma transação SQL da mudança financeira: no use case o evento é
 * apenas persistido, nunca publicado. Quem publica é o worker, após o commit.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.occurredAt,
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    if (this._nextAttemptAt === undefined) return true;
    return this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    this._publishedAt = at;
  }

  /** Backoff exponencial. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delaySeconds = Math.min(2 ** this._attempts, BACKOFF_CAP_SECONDS);
    this._nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
  }

  hasExhaustedAttempts(maxAttempts: number): boolean {
    return this._attempts >= maxAttempts;
  }
}
