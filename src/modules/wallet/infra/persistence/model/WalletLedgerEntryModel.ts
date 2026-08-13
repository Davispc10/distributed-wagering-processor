import { EntitySchema } from '@mikro-orm/postgresql';

export class WalletLedgerEntryModel {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  moneyAmount!: string;
  moneyCurrency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryModel>({
  class: WalletLedgerEntryModel,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    moneyAmount: { type: 'string', columnType: 'numeric(20,2)', fieldName: 'money_amount' },
    moneyCurrency: { type: 'string', columnType: 'char(3)', fieldName: 'money_currency' },
    balanceBefore: { type: 'string', columnType: 'numeric(20,2)', fieldName: 'balance_before' },
    balanceAfter: { type: 'string', columnType: 'numeric(20,2)', fieldName: 'balance_after' },
    createdAt: { type: 'Date', columnType: 'timestamptz', fieldName: 'created_at' },
  },
});
