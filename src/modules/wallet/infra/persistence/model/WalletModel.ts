import { EntitySchema } from '@mikro-orm/postgresql';

export class WalletModel {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletModel>({
  class: WalletModel,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceAmount: { type: 'string', columnType: 'numeric(20,2)', fieldName: 'balance_amount' },
    version: { type: 'integer' },
    createdAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' },
    updatedAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'updated_at' },
  },
});
