import { Inject, Injectable } from '@nestjs/common';
import { ID_GENERATOR, type IdGenerator } from '@shared/Clock';
import { LedgerDirection, invertDirection } from '@modules/kernel/domain/LedgerDirection';
import type { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';
import { Journal, LedgerAccount, counterpartAccountFor } from '@modules/wallet/domain/Journal';
import type { WalletLedgerEntry } from '@modules/wallet/domain/WalletLedgerEntry';

/**
 * Duas linhas que se anulam: a perna do jogador (`PLAYER_LIABILITY`) e a
 * contrapartida da casa.
 */
@Injectable()
export class JournalFactory {
  constructor(@Inject(ID_GENERATOR) private readonly ids: IdGenerator) {}

  build(entry: WalletLedgerEntry, kind: WagerTransactionKind): Journal {
    const counterpart = counterpartAccountFor(kind, entry.direction);

    // A contrapartida vai na direção inversa para a soma fechar em zero.
    const playerDirection = entry.direction;
    const counterpartDirection = invertDirection(entry.direction);

    return Journal.create({
      id: this.ids.next(),
      transactionId: entry.transactionId,
      walletId: entry.walletId,
      description: `${kind} ${entry.money.toString()} ${entry.money.currency}`,
      lines: [
        {
          id: this.ids.next(),
          accountCode: LedgerAccount.PlayerLiability,
          direction: playerDirection,
          amount: entry.money,
        },
        {
          id: this.ids.next(),
          accountCode: counterpart,
          direction: counterpartDirection,
          amount: entry.money,
        },
      ],
    });
  }

  /** Exposto para teste. */
  static counterpartDirection(walletDirection: LedgerDirection): LedgerDirection {
    return invertDirection(walletDirection);
  }
}
