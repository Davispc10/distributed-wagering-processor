import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import { Money } from '@modules/kernel/domain/Money';
import {
  BusinessRuleError,
  InvalidTransactionStateError,
} from '@modules/kernel/domain/error/KernelErrors';
import { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';
import { WagerTransactionStatus } from '@modules/wagering/domain/enum/WagerTransactionStatus';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-08-11T00:00:00.000Z');

const make = (
  kind: WagerTransactionKind,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction =>
  WagerTransaction.create({
    id: 't-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'w-1',
    playerId: 'p-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    createdAt: AT,
    ...overrides,
  });

describe('WagerTransaction — criação', () => {
  it('nasce em PENDING', () => {
    expect(make(WagerTransactionKind.Bet).status).toBe(WagerTransactionStatus.Pending);
  });

  it('rejeita valor não positivo', () => {
    expect(() => make(WagerTransactionKind.Bet, { money: brl('0.00') })).toThrow();
  });

  it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    '%s sem referência é rejeitado com REFERENCE_REQUIRED',
    (kind) => {
      try {
        make(kind);
        throw new Error('deveria ter lançado');
      } catch (e) {
        expect(e).toBeInstanceOf(BusinessRuleError);
        expect((e as BusinessRuleError).failureCode).toBe(FailureCode.ReferenceRequired);
      }
    },
  );

  it.each([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss])(
    '%s não exige referência',
    (kind) => {
      expect(make(kind).requiresReference()).toBe(false);
    },
  );
});

describe('WagerTransaction — efeito no saldo', () => {
  it.each([
    [WagerTransactionKind.Bet, true],
    [WagerTransactionKind.Win, true],
    [WagerTransactionKind.Opening, true],
    [WagerTransactionKind.Loss, false],
  ])('%s afeta saldo: %s', (kind, expected) => {
    expect(make(kind).affectsBalance()).toBe(expected);
  });
});

describe('WagerTransaction — direção do lançamento', () => {
  it('BET debita', () => {
    expect(make(WagerTransactionKind.Bet).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
  });

  it.each([WagerTransactionKind.Win, WagerTransactionKind.Opening])('%s credita', (kind) => {
    expect(make(kind).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('REFUND credita', () => {
    const refund = make(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: 'ext-bet',
    });
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('ROLLBACK de BET credita (inverte o débito)', () => {
    const bet = make(WagerTransactionKind.Bet);
    const rollback = make(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'ext-bet',
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });

  it('ROLLBACK de WIN debita (inverte o crédito)', () => {
    const win = make(WagerTransactionKind.Win);
    const rollback = make(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'ext-win',
    });
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it('ROLLBACK sem referência é erro de programação', () => {
    const rollback = make(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: 'ext-1',
    });
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  it('LOSS não produz lançamento', () => {
    expect(() => make(WagerTransactionKind.Loss).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransaction — máquina de estados', () => {
  it('PENDING → PROCESSED grava saldo observado e processedAt', () => {
    const tx = make(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, AT, brl('975.00'));

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toEqual(AT);
    expect(tx.observedBalance?.toString()).toBe('975.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING → REJECTED grava failureCode', () => {
    const tx = make(WagerTransactionKind.Bet);
    tx.reject(FailureCode.InsufficientFunds, AT, brl('10.00'));

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.observedBalance?.toString()).toBe('10.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING → PENDING_REFERENCE → PROCESSED', () => {
    const tx = make(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(new Date(AT.getTime() + 1000));
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);

    tx.markProcessed('t-ref', AT, brl('100.00'));
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe('t-ref');
  });

  it.each([
    ['PROCESSED', (tx: WagerTransaction) => tx.markProcessed(undefined, AT, brl('1.00'))],
    ['REJECTED', (tx: WagerTransaction) => tx.reject(FailureCode.InsufficientFunds, AT)],
    ['FAILED', (tx: WagerTransaction) => tx.fail(FailureCode.InfrastructureUnavailable, AT)],
  ])('%s é terminal: qualquer nova transição é erro de programação', (_label, terminate) => {
    const tx = make(WagerTransactionKind.Bet);
    terminate(tx);

    expect(() => tx.markProcessed(undefined, AT, brl('1.00'))).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.reject(FailureCode.InsufficientFunds, AT)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.InfrastructureUnavailable, AT)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markPendingReference(AT)).toThrow(InvalidTransactionStateError);
  });

  it('PENDING_REFERENCE não volta para PENDING_REFERENCE', () => {
    const tx = make(WagerTransactionKind.Refund, { referenceExternalTransactionId: 'ext-bet' });
    tx.markPendingReference(AT);
    expect(() => tx.markPendingReference(AT)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction — backoff da referência pendente', () => {
  it('cresce exponencialmente e respeita o teto', () => {
    const tx = make(WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'ext-1' });
    tx.markPendingReference(AT);

    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      tx.scheduleReferenceRetry(AT, 60);
      delays.push((tx.nextAttemptAt!.getTime() - AT.getTime()) / 1000);
    }

    expect(delays).toEqual([2, 4, 8, 16, 32, 60, 60, 60]);
    expect(tx.referenceAttempts).toBe(8);
  });

  it('hasExhaustedReferenceAttempts respeita o limite configurado', () => {
    const tx = make(WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'ext-1' });
    tx.markPendingReference(AT);

    expect(tx.hasExhaustedReferenceAttempts(3)).toBe(false);
    tx.scheduleReferenceRetry(AT, 60);
    tx.scheduleReferenceRetry(AT, 60);
    tx.scheduleReferenceRetry(AT, 60);
    expect(tx.hasExhaustedReferenceAttempts(3)).toBe(true);
  });

  it('só reagenda em PENDING_REFERENCE', () => {
    const tx = make(WagerTransactionKind.Bet);
    expect(() => tx.scheduleReferenceRetry(AT, 60)).toThrow(InvalidTransactionStateError);
  });

  it('markProcessed limpa o agendamento', () => {
    const tx = make(WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'ext-1' });
    tx.markPendingReference(AT);
    tx.scheduleReferenceRetry(AT, 60);
    tx.markProcessed('t-ref', AT, brl('1.00'));
    expect(tx.nextAttemptAt).toBeUndefined();
  });
});

describe('WagerTransaction — idempotência por payload', () => {
  it('mesmo hash é replay', () => {
    expect(make(WagerTransactionKind.Bet).matchesPayload('hash-1')).toBe(true);
  });

  it('hash diferente é conflito, não replay', () => {
    expect(make(WagerTransactionKind.Bet).matchesPayload('hash-2')).toBe(false);
  });
});

describe('WagerTransaction — rehydrate', () => {
  it('reconstrói estado terminal sem revalidar transições', () => {
    const tx = WagerTransaction.rehydrate({
      id: 't-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      payloadHash: 'hash-1',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'round-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Bet,
      money: brl('25.00'),
      createdAt: AT,
      status: WagerTransactionStatus.Processed,
      processedAt: AT,
      observedBalance: brl('975.00'),
      referenceAttempts: 0,
    });

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.observedBalance?.toString()).toBe('975.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('rehydrate de REFUND sem referência não revalida a exigência', () => {
    expect(() =>
      WagerTransaction.rehydrate({
        id: 't-1',
        providerId: 'provider-a',
        externalTransactionId: 'ext-1',
        idempotencyKey: 'k',
        payloadHash: 'h',
        walletId: 'w-1',
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Refund,
        money: brl('25.00'),
        createdAt: AT,
        status: WagerTransactionStatus.Rejected,
        referenceAttempts: 0,
      }),
    ).not.toThrow();
  });
});
