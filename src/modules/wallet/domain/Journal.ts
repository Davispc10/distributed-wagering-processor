import { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import type { Money } from '@modules/kernel/domain/Money';
import { ValidationError } from '@modules/kernel/domain/error/KernelErrors';
import { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';

/**
 * `PLAYER_LIABILITY` é passivo: o saldo do jogador é dinheiro que a casa deve a
 * ele. Por isso uma aposta debita o passivo e credita a receita.
 */
export enum LedgerAccount {
  PlayerLiability = 'PLAYER_LIABILITY',
  HouseRevenue = 'HOUSE_REVENUE',
  HousePayout = 'HOUSE_PAYOUT',
  PlayerDeposits = 'PLAYER_DEPOSITS',
}

export interface JournalLine {
  id: string;
  accountCode: LedgerAccount;
  direction: LedgerDirection;
  amount: Money;
}

export interface CreateJournalProps {
  id: string;
  transactionId: string;
  walletId: string;
  description: string;
  lines: JournalLine[];
}

/**
 * Aditivo: `WalletLedgerEntry` continua sendo a fonte da verdade do saldo. O
 * journal acrescenta a contrapartida — de onde veio e para onde foi.
 */
export class Journal {
  private constructor(
    public readonly id: string,
    public readonly transactionId: string,
    public readonly walletId: string,
    public readonly description: string,
    public readonly currency: string,
    public readonly lines: readonly JournalLine[],
  ) {}

  static create(props: CreateJournalProps): Journal {
    if (props.lines.length < 2) {
      throw new ValidationError('um journal de partidas dobradas exige ao menos duas linhas');
    }

    const currency = props.lines[0]!.amount.currency;
    if (props.lines.some((line) => line.amount.currency !== currency)) {
      throw new ValidationError('todas as linhas do journal devem usar a mesma moeda');
    }

    const journal = new Journal(
      props.id,
      props.transactionId,
      props.walletId,
      props.description,
      currency,
      Object.freeze([...props.lines]),
    );

    if (!journal.isBalanced()) {
      throw new ValidationError(
        `journal desbalanceado: débitos ${journal.totalFor(LedgerDirection.Debit).toString()} ` +
          `!= créditos ${journal.totalFor(LedgerDirection.Credit).toString()}`,
      );
    }

    return journal;
  }

  isBalanced(): boolean {
    return this.totalFor(LedgerDirection.Debit).equals(this.totalFor(LedgerDirection.Credit));
  }

  totalFor(direction: LedgerDirection): Money {
    return this.lines
      .filter((line) => line.direction === direction)
      .reduce(
        (sum, line) => sum.add(line.amount),
        this.lines[0]!.amount.subtract(this.lines[0]!.amount),
      );
  }
}

/**
 * OPENING → PLAYER_DEPOSITS · BET e REFUND → HOUSE_REVENUE · WIN → HOUSE_PAYOUT ·
 * ROLLBACK → a conta da referência que ele desfaz.
 */
export function counterpartAccountFor(
  kind: WagerTransactionKind,
  walletDirection: LedgerDirection,
): LedgerAccount {
  switch (kind) {
    case WagerTransactionKind.Opening:
      return LedgerAccount.PlayerDeposits;
    case WagerTransactionKind.Bet:
    case WagerTransactionKind.Refund:
      return LedgerAccount.HouseRevenue;
    case WagerTransactionKind.Win:
      return LedgerAccount.HousePayout;
    case WagerTransactionKind.Rollback:
      // Creditar o jogador desfaz uma aposta (receita); debitar desfaz um ganho.
      return walletDirection === LedgerDirection.Credit
        ? LedgerAccount.HouseRevenue
        : LedgerAccount.HousePayout;
    case WagerTransactionKind.Loss:
      throw new ValidationError('LOSS não produz lançamento contábil');
  }
}
