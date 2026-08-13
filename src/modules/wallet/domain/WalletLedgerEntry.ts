import { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import type { Money } from '@modules/kernel/domain/Money';
import { ValidationError } from '@modules/kernel/domain/error/KernelErrors';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Sem campos mutáveis e sem métodos de transição: a imutabilidade é estrutural.
 * No banco é reforçada por trigger — convenção de código não impede um UPDATE
 * ad-hoc em produção.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /**
   * `balanceAfter` que não fecha com `balanceBefore ± money` corromperia a
   * reconciliação em silêncio. A mesma regra existe como CHECK no banco.
   */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    if (!props.money.isPositive()) {
      throw new ValidationError(
        `lançamento exige valor positivo, recebido ${props.money.toString()}`,
      );
    }
    if (props.balanceAfter.isNegative()) {
      throw new ValidationError(
        `lançamento produziria saldo negativo: ${props.balanceAfter.toString()}`,
      );
    }
    if (!entry.isBalanced()) {
      throw new ValidationError(
        `lançamento desbalanceado: ${props.balanceBefore.toString()} ${props.direction} ` +
          `${props.money.toString()} deveria resultar em ` +
          `${entry.expectedBalanceAfter().toString()}, mas veio ${props.balanceAfter.toString()}`,
      );
    }

    return entry;
  }

  /** Reconstrução a partir da persistência — não revalida a aritmética. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    return this.expectedBalanceAfter().equals(this.balanceAfter);
  }

  /** Valor com sinal: positivo para CREDIT, negativo para DEBIT. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  private expectedBalanceAfter(): Money {
    return this.balanceBefore.add(this.signedAmount());
  }
}
