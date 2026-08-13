import { describe, expect, it } from 'bun:test';
import { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import { Money } from '@modules/kernel/domain/Money';
import { ValidationError } from '@modules/kernel/domain/error/KernelErrors';
import { WalletLedgerEntry } from '@modules/wallet/domain/WalletLedgerEntry';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-08-11T00:00:00.000Z');

const base = {
  id: 'e-1',
  walletId: 'w-1',
  transactionId: 't-1',
  createdAt: AT,
};

describe('WalletLedgerEntry — validação aritmética na factory', () => {
  it('aceita débito consistente', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('aceita crédito consistente', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('125.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejeita débito com balanceAfter errado', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(ValidationError);
  });

  it('rejeita crédito lançado como se fosse débito', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('75.00'),
      }),
    ).toThrow(ValidationError);
  });

  it('rejeita balanceAfter negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('150.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: Money.parse({ amount: '-50.00', currency: 'BRL' }),
      }),
    ).toThrow(ValidationError);
  });

  it('rejeita valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('0.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('100.00'),
      }),
    ).toThrow(ValidationError);
  });
});

describe('WalletLedgerEntry — imutabilidade estrutural', () => {
  it('não expõe nenhum método de transição', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });

    const mutators = Object.getOwnPropertyNames(Object.getPrototypeOf(entry) as object).filter(
      (name) => /^(set|update|change|mark|apply|reject|fail)/.test(name),
    );
    expect(mutators).toEqual([]);
  });
});

describe('WalletLedgerEntry — signedAmount', () => {
  it('CREDIT é positivo, DEBIT é negativo', () => {
    const credit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('25.00'),
    });
    const debit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('25.00'),
      balanceAfter: brl('0.00'),
    });

    expect(credit.signedAmount().toString()).toBe('25.00');
    expect(debit.signedAmount().toString()).toBe('-25.00');
  });

  it('a soma dos signedAmount reconstrói o saldo — base da reconciliação', () => {
    const entries = [
      { direction: LedgerDirection.Credit, money: '1000.00', before: '0.00', after: '1000.00' },
      { direction: LedgerDirection.Debit, money: '25.00', before: '1000.00', after: '975.00' },
      { direction: LedgerDirection.Credit, money: '50.00', before: '975.00', after: '1025.00' },
      { direction: LedgerDirection.Debit, money: '80.00', before: '1025.00', after: '945.00' },
    ].map((e, i) =>
      WalletLedgerEntry.create({
        ...base,
        id: `e-${String(i)}`,
        direction: e.direction,
        money: brl(e.money),
        balanceBefore: brl(e.before),
        balanceAfter: brl(e.after),
      }),
    );

    const reconstructed = entries.reduce(
      (acc, entry) => acc.add(entry.signedAmount()),
      Money.zero('BRL'),
    );

    expect(reconstructed.toString()).toBe('945.00');
    expect(reconstructed.equals(entries[entries.length - 1]!.balanceAfter)).toBe(true);
  });
});
