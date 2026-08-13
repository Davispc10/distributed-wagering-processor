import { EntitySchema } from '@mikro-orm/postgresql';

export class InboxMessageModel {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

/** PK composta (consumer_name, message_id): a dedup é por consumidor, não global. */
export const InboxMessageSchema = new EntitySchema<InboxMessageModel>({
  class: InboxMessageModel,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true, fieldName: 'consumer_name' },
    messageId: { type: 'string', primary: true, fieldName: 'message_id' },
    payloadHash: { type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' },
    receivedAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'received_at' },
    processedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
  },
});
