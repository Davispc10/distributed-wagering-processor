import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import { Money } from '@modules/kernel/domain/Money';
import {
  BusinessRuleError,
  CurrencyMismatchError,
} from '@modules/kernel/domain/error/KernelErrors';
import { Wallet } from '@modules/wallet/domain/Wallet';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-08-11T00:00:00.000Z');

const openWallet = (balance = '100.00'): Wallet =>
  Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(balance), at: AT });

describe('Wallet — abertura', () => {
  it('nasce com version 1', () => {
    expect(openWallet().version).toBe(1);
  });

  it('herda a moeda do saldo inicial', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '10.00', currency: 'USD' }),
    });
    expect(wallet.currency).toBe('USD');
  });

  it('aceita saldo inicial zero', () => {
    expect(openWallet('0.00').balance.isZero()).toBe(true);
  });
});

describe('Wallet — débito', () => {
  it('reduz o saldo e devolve o movimento', () => {
    const wallet = openWallet('100.00');
    const movement = wallet.debit(brl('25.00'), AT);

    expect(wallet.balance.toString()).toBe('75.00');
    expect(movement.direction).toBe(LedgerDirection.Debit);
    expect(movement.balanceBefore.toString()).toBe('100.00');
    expect(movement.balanceAfter.toString()).toBe('75.00');
    expect(movement.money.toString()).toBe('25.00');
  });

  it('permite zerar o saldo exatamente', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('100.00'), AT);
    expect(wallet.balance.toString()).toBe('0.00');
  });

  it('rejeita débito acima do saldo com INSUFFICIENT_FUNDS', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(brl('100.01'), AT)).toThrow(BusinessRuleError);

    try {
      wallet.debit(brl('100.01'), AT);
    } catch (e) {
      expect((e as BusinessRuleError).failureCode).toBe(FailureCode.InsufficientFunds);
    }
  });

  it('não altera o saldo quando o débito é rejeitado', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(brl('200.00'), AT)).toThrow();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  it('nunca permite saldo negativo', () => {
    const wallet = openWallet('0.00');
    expect(() => wallet.debit(brl('0.01'), AT)).toThrow(BusinessRuleError);
    expect(wallet.balance.isNegative()).toBe(false);
  });
});

describe('Wallet — crédito', () => {
  it('aumenta o saldo e devolve o movimento', () => {
    const wallet = openWallet('100.00');
    const movement = wallet.credit(brl('50.00'), AT);

    expect(wallet.balance.toString()).toBe('150.00');
    expect(movement.direction).toBe(LedgerDirection.Credit);
    expect(movement.balanceAfter.toString()).toBe('150.00');
  });
});

describe('Wallet — version', () => {
  it('incrementa a cada mudança de saldo', () => {
    const wallet = openWallet('100.00');
    expect(wallet.version).toBe(1);
    wallet.debit(brl('10.00'), AT);
    expect(wallet.version).toBe(2);
    wallet.credit(brl('10.00'), AT);
    expect(wallet.version).toBe(3);
  });

  it('NÃO incrementa quando a operação é rejeitada', () => {
    const wallet = openWallet('10.00');
    expect(() => wallet.debit(brl('999.00'), AT)).toThrow();
    expect(wallet.version).toBe(1);
  });

  it('atualiza updatedAt junto com o saldo', () => {
    const wallet = openWallet('100.00');
    const later = new Date(AT.getTime() + 60_000);
    wallet.debit(brl('1.00'), later);
    expect(wallet.updatedAt).toEqual(later);
  });
});

describe('Wallet — conflito de moeda', () => {
  const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

  it('rejeita débito em moeda diferente', () => {
    expect(() => openWallet().debit(usd('10.00'), AT)).toThrow(CurrencyMismatchError);
  });

  it('rejeita crédito em moeda diferente', () => {
    expect(() => openWallet().credit(usd('10.00'), AT)).toThrow(CurrencyMismatchError);
  });

  it('não altera o saldo quando a moeda diverge', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(usd('50.00'), AT)).toThrow();
    expect(wallet.balance.toString()).toBe('100.00');
  });
});

describe('Wallet — valores inválidos', () => {
  it('rejeita movimentação de valor zero', () => {
    expect(() => openWallet().debit(brl('0.00'), AT)).toThrow(BusinessRuleError);
    expect(() => openWallet().credit(brl('0.00'), AT)).toThrow(BusinessRuleError);
  });
});

describe('Wallet — hasSufficientBalance', () => {
  it('permite decidir o failureCode sem efeito colateral', () => {
    const wallet = openWallet('100.00');
    expect(wallet.hasSufficientBalance(brl('100.00'))).toBe(true);
    expect(wallet.hasSufficientBalance(brl('100.01'))).toBe(false);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet — apply por direção', () => {
  it('DEBIT debita, CREDIT credita', () => {
    const wallet = openWallet('100.00');
    wallet.apply(LedgerDirection.Debit, brl('30.00'), AT);
    expect(wallet.balance.toString()).toBe('70.00');
    wallet.apply(LedgerDirection.Credit, brl('30.00'), AT);
    expect(wallet.balance.toString()).toBe('100.00');
  });
});

describe('Wallet — rehydrate', () => {
  it('reconstrói o estado sem revalidar transições', () => {
    const wallet = Wallet.rehydrate({
      id: 'w-1',
      playerId: 'p-1',
      currency: 'BRL',
      balance: brl('42.50'),
      version: 7,
      createdAt: AT,
      updatedAt: AT,
    });
    expect(wallet.balance.toString()).toBe('42.50');
    expect(wallet.version).toBe(7);
  });
});
