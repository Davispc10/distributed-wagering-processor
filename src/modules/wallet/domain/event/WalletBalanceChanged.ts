import type { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import type { MoneyProps } from '@modules/kernel/domain/Money';
import { IntegrationEvent, type EventContext } from '@modules/kernel/domain/event/IntegrationEvent';
import type { Wallet } from '@modules/wallet/domain/Wallet';
import type { WalletLedgerEntry } from '@modules/wallet/domain/WalletLedgerEntry';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/**
 * Somente quando o saldo muda. LOSS e rejeição não incrementam a `version`, e um
 * consumidor com saldo espelhado receberia evento sem delta.
 */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
