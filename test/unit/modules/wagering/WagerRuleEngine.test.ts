import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import { Money } from '@modules/kernel/domain/Money';
import { BusinessRuleError } from '@modules/kernel/domain/error/KernelErrors';
import { WagerRuleEngine } from '@modules/wagering/application/service/WagerRuleEngine';
import { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';
import { Wallet } from '@modules/wallet/domain/Wallet';

/**
 * Regras da tabela da seção 7: efeito no saldo e direção do lançamento por
 * `kind`, e a distinção entre aposta sem saldo e reversão sem saldo.
 */

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-08-11T00:00:00.000Z');

const rules = new WagerRuleEngine();

const wallet = (balance: string): Wallet =>
  Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl(balance), at: AT });

const tx = (
  kind: WagerTransactionKind,
  amount = '25.00',
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction =>
  WagerTransaction.create({
    id: `t-${kind}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind}`,
    idempotencyKey: `provider-a:ext-${kind}`,
    payloadHash: 'hash-1',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    createdAt: AT,
    ...(kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback
      ? { referenceExternalTransactionId: 'ext-BET' }
      : {}),
    ...overrides,
  });

/** Referência já aplicada, como o `ReferenceResolver` entregaria. */
const processedReference = (kind: WagerTransactionKind, amount = '25.00'): WagerTransaction => {
  const reference = tx(kind, amount);
  reference.markProcessed(undefined, AT, brl('0.00'));
  return reference;
};

describe('WagerRuleEngine — BET', () => {
  it('debita quando há saldo', () => {
    const decision = rules.decide(tx(WagerTransactionKind.Bet), wallet('100.00'));
    expect(decision).toEqual({ effect: 'move', direction: LedgerDirection.Debit });
  });

  it('aceita a aposta que zera o saldo exatamente', () => {
    const decision = rules.decide(tx(WagerTransactionKind.Bet, '100.00'), wallet('100.00'));
    expect(decision.effect).toBe('move');
  });

  it('rejeita sem saldo com INSUFFICIENT_FUNDS', () => {
    try {
      rules.decide(tx(WagerTransactionKind.Bet, '150.00'), wallet('100.00'));
      throw new Error('deveria ter rejeitado');
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleError);
      expect((error as BusinessRuleError).failureCode).toBe(FailureCode.InsufficientFunds);
    }
  });

  it('a decisão não move o saldo — quem aplica é a wallet', () => {
    const w = wallet('100.00');
    rules.decide(tx(WagerTransactionKind.Bet), w);
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
  });
});

describe('WagerRuleEngine — WIN', () => {
  it('credita sem exigir saldo', () => {
    const decision = rules.decide(tx(WagerTransactionKind.Win, '999.00'), wallet('0.00'));
    expect(decision).toEqual({ effect: 'move', direction: LedgerDirection.Credit });
  });
});

describe('WagerRuleEngine — LOSS', () => {
  it('não move saldo e não gera lançamento', () => {
    expect(rules.decide(tx(WagerTransactionKind.Loss), wallet('100.00'))).toEqual({
      effect: 'none',
    });
  });

  it('vale mesmo com saldo zero — LOSS nunca é rejeitado por saldo', () => {
    expect(rules.decide(tx(WagerTransactionKind.Loss, '500.00'), wallet('0.00'))).toEqual({
      effect: 'none',
    });
  });
});

describe('WagerRuleEngine — REFUND', () => {
  it('credita de volta o valor da BET', () => {
    const decision = rules.decide(
      tx(WagerTransactionKind.Refund),
      wallet('0.00'),
      processedReference(WagerTransactionKind.Bet),
    );
    expect(decision).toEqual({ effect: 'move', direction: LedgerDirection.Credit });
  });
});

describe('WagerRuleEngine — ROLLBACK', () => {
  it('de uma BET credita: inverte o débito', () => {
    const decision = rules.decide(
      tx(WagerTransactionKind.Rollback),
      wallet('0.00'),
      processedReference(WagerTransactionKind.Bet),
    );
    expect(decision).toEqual({ effect: 'move', direction: LedgerDirection.Credit });
  });

  it('de um WIN debita: inverte o crédito', () => {
    const decision = rules.decide(
      tx(WagerTransactionKind.Rollback),
      wallet('100.00'),
      processedReference(WagerTransactionKind.Win),
    );
    expect(decision).toEqual({ effect: 'move', direction: LedgerDirection.Debit });
  });

  it('de um REFUND debita', () => {
    const decision = rules.decide(
      tx(WagerTransactionKind.Rollback),
      wallet('100.00'),
      processedReference(WagerTransactionKind.Refund),
    );
    expect(decision).toEqual({ effect: 'move', direction: LedgerDirection.Debit });
  });
});

describe('WagerRuleEngine — seção 7.9: reversão negativa tem código próprio', () => {
  /**
   * Aposta sem saldo é rotina; reversão sem saldo significa que o dinheiro já
   * saiu e exige intervenção humana. Colapsar os dois faria o segundo sumir.
   */
  it('ROLLBACK que deixaria a wallet negativa usa REVERSAL_INSUFFICIENT_FUNDS', () => {
    try {
      rules.decide(
        tx(WagerTransactionKind.Rollback, '100.00'),
        wallet('20.00'),
        processedReference(WagerTransactionKind.Win, '100.00'),
      );
      throw new Error('deveria ter rejeitado');
    } catch (error) {
      expect((error as BusinessRuleError).failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    }
  });

  it('o código é DIFERENTE do de uma aposta sem saldo', () => {
    const betCode = (() => {
      try {
        rules.decide(tx(WagerTransactionKind.Bet, '100.00'), wallet('20.00'));
        return null;
      } catch (error) {
        return (error as BusinessRuleError).failureCode;
      }
    })();

    const reversalCode = (() => {
      try {
        rules.decide(
          tx(WagerTransactionKind.Rollback, '100.00'),
          wallet('20.00'),
          processedReference(WagerTransactionKind.Win, '100.00'),
        );
        return null;
      } catch (error) {
        return (error as BusinessRuleError).failureCode;
      }
    })();

    expect(betCode).toBe(FailureCode.InsufficientFunds);
    expect(reversalCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(betCode).not.toBe(reversalCode);
  });
});
