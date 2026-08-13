import { EntitySchema } from '@mikro-orm/postgresql';

export class OutboxMessageModel {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
  lockedBy?: string | null;
  lockedUntil?: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageModel>({
  class: OutboxMessageModel,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'occurred_at' },
    attempts: { type: 'integer' },
    nextAttemptAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'next_attempt_at',
      nullable: true,
    },
    publishedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'published_at',
      nullable: true,
    },
    lockedBy: { type: 'string', fieldName: 'locked_by', nullable: true },
    lockedUntil: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'locked_until',
      nullable: true,
    },
  },
});
