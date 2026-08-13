import { EntitySchema } from '@mikro-orm/postgresql';

export class WagerTransactionModel {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  moneyAmount!: string;
  moneyCurrency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  observedBalanceAmount?: string | null;
  observedBalanceCurrency?: string | null;
  referenceAttempts!: number;
  nextAttemptAt?: Date | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionModel>({
  class: WagerTransactionModel,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', columnType: 'char(64)', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    moneyAmount: { type: 'string', columnType: 'numeric(20,2)', fieldName: 'money_amount' },
    moneyCurrency: { type: 'string', columnType: 'char(3)', fieldName: 'money_currency' },
    referenceExternalTransactionId: {
      type: 'string',
      fieldName: 'reference_external_transaction_id',
      nullable: true,
    },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    observedBalanceAmount: {
      type: 'string',
      columnType: 'numeric(20,2)',
      fieldName: 'observed_balance_amount',
      nullable: true,
    },
    observedBalanceCurrency: {
      type: 'string',
      columnType: 'char(3)',
      fieldName: 'observed_balance_currency',
      nullable: true,
    },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextAttemptAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'next_attempt_at',
      nullable: true,
    },
    createdAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' },
    processedAt: {
      type: 'Date',
      columnType: 'timestamptz',
      fieldName: 'processed_at',
      nullable: true,
    },
  },
});
