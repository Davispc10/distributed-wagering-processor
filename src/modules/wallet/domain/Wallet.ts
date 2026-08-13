import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import type { Money } from '@modules/kernel/domain/Money';
import {
  BusinessRuleError,
  CurrencyMismatchError,
} from '@modules/kernel/domain/error/KernelErrors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A wallet devolve isto em vez de só mudar o saldo: a invariante "toda alteração
 * de saldo tem um lançamento" fica mais difícil de violar quando o agregado
 * entrega os dados do lançamento junto com a mudança.
 */
export interface WalletMovement {
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at?: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new BusinessRuleError(
        FailureCode.ValidationError,
        'saldo inicial não pode ser negativo',
      );
    }
    const at = props.at ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      at,
      at,
    );
  }

  /**
   * Reconstrução a partir da persistência — não revalida transições. Revalidar
   * na leitura rejeitaria estados historicamente válidos sempre que uma regra
   * mudasse, e o banco ficaria ilegível justamente para reconciliar.
   */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Sem efeito colateral: quem chama decide qual failureCode levantar. */
  hasSufficientBalance(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /**
   * Lança INSUFFICIENT_FUNDS. Reversões devem checar `hasSufficientBalance`
   * antes e levantar REVERSAL_INSUFFICIENT_FUNDS, que é situação diferente.
   */
  debit(money: Money, at: Date): WalletMovement {
    this.assertPositive(money);
    this.assertSameCurrency(money);

    if (this._balance.isLessThan(money)) {
      throw new BusinessRuleError(
        FailureCode.InsufficientFunds,
        `saldo insuficiente: disponível ${this._balance.toString()}, requerido ${money.toString()}`,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(money);
    this.applyBalance(balanceAfter, at);

    return { direction: LedgerDirection.Debit, money, balanceBefore, balanceAfter };
  }

  credit(money: Money, at: Date): WalletMovement {
    this.assertPositive(money);
    this.assertSameCurrency(money);

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(money);
    this.applyBalance(balanceAfter, at);

    return { direction: LedgerDirection.Credit, money, balanceBefore, balanceAfter };
  }

  /** Usado por ROLLBACK, que inverte a direção da referência. */
  apply(direction: LedgerDirection, money: Money, at: Date): WalletMovement {
    return direction === LedgerDirection.Debit ? this.debit(money, at) : this.credit(money, at);
  }

  /** `version` incrementa somente quando o saldo muda — um LOSS não a move. */
  private applyBalance(next: Money, at: Date): void {
    if (next.equals(this._balance)) return;
    this._balance = next;
    this._version += 1;
    this._updatedAt = at;
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) {
      throw new BusinessRuleError(
        FailureCode.ValidationError,
        `movimentação exige valor positivo, recebido ${money.toString()}`,
      );
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `moeda da operação (${money.currency}) difere da moeda da wallet (${this.currency})`,
      );
    }
  }
}
