import { Decimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './error/KernelErrors';

export interface MoneyProps {
  /** String decimal com escala fixa de 2, ex.: "25.00" */
  amount: string;
  /** ISO-4217, ex.: "BRL" */
  currency: string;
}

/** ROUND_HALF_EVEN é o arredondamento correto para dinheiro; a precisão cobre NUMERIC(20,2). */
const MoneyDecimal = Decimal.clone({
  precision: 34,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

const SCALE = 2;

/** Rejeita por construção: vazio, NaN, Infinity, notação científica, milhar e 3+ casas. */
const AMOUNT_PATTERN = /^-?(0|[1-9]\d*)(\.\d{1,2})?$/;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável. Nunca usa `number`: em ponto flutuante
 * `0.1 + 0.2 !== 0.3`, o que num ledger vira divergência de centavos inexplicável.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /** Contrato de entrada: rejeita negativos, que só existem como resultado interno. */
  static from(props: MoneyProps): Money {
    const money = Money.parse(props);
    if (money.isNegative()) {
      throw new InvalidMoneyError(
        `valor monetário negativo não é aceito em contrato de entrada: "${props.amount}"`,
      );
    }
    return money;
  }

  /** Reidratação e cálculo interno: aceita negativos (lançamento invertido de ROLLBACK). */
  static parse(props: MoneyProps): Money {
    const { amount, currency } = props;

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError(`amount deve ser string decimal, recebido ${typeof amount}`);
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount inválido: "${amount}". Esperado decimal com até ${String(SCALE)} casas, sem notação científica.`,
      );
    }
    Money.assertValidCurrency(currency);

    return new Money(new MoneyDecimal(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(new MoneyDecimal(0), currency);
  }

  private static of(value: Decimal, currency: string): Money {
    return new Money(value, currency);
  }

  private static assertValidCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        `currency inválida: "${String(currency)}". Esperado código ISO-4217 com 3 letras maiúsculas.`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  abs(): Money {
    return Money.of(this.value.abs(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  hasSameAmountAs(other: Money): boolean {
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `operação entre moedas diferentes: ${this.currency} e ${other.currency}`,
      );
    }
  }
}
