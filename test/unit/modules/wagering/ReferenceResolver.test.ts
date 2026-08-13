import { describe, expect, it } from 'bun:test';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { Money } from '@modules/kernel/domain/Money';
import { BusinessRuleError } from '@modules/kernel/domain/error/KernelErrors';
import { ReferenceResolver } from '@modules/wagering/application/service/ReferenceResolver';
import type { WagerTransactionRepository } from '@modules/wagering/application/port/WagerTransactionRepository';
import { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';
import { WagerTransactionStatus } from '@modules/wagering/domain/enum/WagerTransactionStatus';

/**
 * Regras 7.1–7.5 da seção 7. O repositório é um duplo em memória porque a regra
 * é de aplicação: a garantia persistente equivalente (índice único parcial de
 * dupla reversão) é exercida contra o PostgreSQL real em `constraints.test.ts`.
 */

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const AT = new Date('2026-08-11T00:00:00.000Z');

interface TxOverrides {
  id?: string;
  providerId?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  externalTransactionId?: string;
  currency?: string;
}

const make = (
  kind: WagerTransactionKind,
  amount: string,
  overrides: TxOverrides = {},
  referenceExternalTransactionId?: string,
): WagerTransaction =>
  WagerTransaction.create({
    id: overrides.id ?? `t-${kind}`,
    providerId: overrides.providerId ?? 'provider-a',
    externalTransactionId: overrides.externalTransactionId ?? `ext-${kind}`,
    idempotencyKey: `key-${overrides.id ?? kind}`,
    payloadHash: 'hash-1',
    walletId: overrides.walletId ?? 'w-1',
    playerId: overrides.playerId ?? 'p-1',
    roundId: overrides.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: Money.from({ amount, currency: overrides.currency ?? 'BRL' }),
    createdAt: AT,
    ...(referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId } : {}),
  });

const processed = (transaction: WagerTransaction): WagerTransaction => {
  transaction.markProcessed(undefined, AT, brl('0.00'));
  return transaction;
};

/** Só os três métodos que o resolver usa; o resto lança se for chamado. */
const repo = (options: {
  reference?: WagerTransaction | null;
  alreadyReversed?: boolean;
}): WagerTransactionRepository =>
  ({
    findByProviderAndExternalId: () => Promise.resolve(options.reference ?? null),
    hasProcessedReversal: () => Promise.resolve(options.alreadyReversed ?? false),
    findByIdempotencyKey: () => Promise.reject(new Error('não deveria ser chamado')),
    findById: () => Promise.reject(new Error('não deveria ser chamado')),
    insert: () => Promise.reject(new Error('não deveria ser chamado')),
    update: () => Promise.reject(new Error('não deveria ser chamado')),
    claimDuePendingReferences: () => Promise.reject(new Error('não deveria ser chamado')),
  }) satisfies WagerTransactionRepository;

const failureCodeOf = async (
  resolver: ReferenceResolver,
  transaction: WagerTransaction,
): Promise<FailureCode | null> => {
  try {
    await resolver.resolve(transaction);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessRuleError);
    return (error as BusinessRuleError).failureCode;
  }
};

describe('ReferenceResolver — referência ausente (seção 7.8)', () => {
  it('devolve not_found em vez de rejeitar: a referência pode chegar depois', async () => {
    const resolver = new ReferenceResolver(repo({ reference: null }));
    const refund = make(WagerTransactionKind.Refund, '25.00', {}, 'ext-BET');

    expect(await resolver.resolve(refund)).toEqual({ outcome: 'not_found' });
  });

  /**
   * `create` já barra isto; o resolver é a segunda linha, para a linha antiga
   * que vier do banco por `rehydrate` — que de propósito não revalida.
   */
  it('sem referenceExternalTransactionId é REFERENCE_REQUIRED', async () => {
    const resolver = new ReferenceResolver(repo({}));
    const refund = WagerTransaction.rehydrate({
      id: 't-refund',
      providerId: 'provider-a',
      externalTransactionId: 'ext-refund',
      idempotencyKey: 'key-refund',
      payloadHash: 'hash-1',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      createdAt: AT,
      status: WagerTransactionStatus.PendingReference,
      referenceAttempts: 0,
    });

    expect(refund.referenceExternalTransactionId).toBeUndefined();
    expect(await failureCodeOf(resolver, refund)).toBe(FailureCode.ReferenceRequired);
  });
});

describe('ReferenceResolver — escopo da referência (regra 7.2)', () => {
  const cases: { campo: string; overrides: TxOverrides }[] = [
    { campo: 'provider', overrides: { providerId: 'provider-b' } },
    { campo: 'player', overrides: { playerId: 'p-outro' } },
    { campo: 'wallet', overrides: { walletId: 'w-outra' } },
    { campo: 'rodada', overrides: { roundId: 'round-outra' } },
  ];

  for (const { campo, overrides } of cases) {
    it(`recusa referência de outro ${campo}`, async () => {
      const reference = processed(
        make(WagerTransactionKind.Bet, '25.00', { id: 'ref-1', ...overrides }),
      );
      const resolver = new ReferenceResolver(repo({ reference }));
      const refund = make(WagerTransactionKind.Refund, '25.00', {}, 'ext-BET');

      expect(await failureCodeOf(resolver, refund)).toBe(FailureCode.ReferenceScopeMismatch);
    });
  }

  it('recusa referência em outra moeda', async () => {
    const reference = processed(
      make(WagerTransactionKind.Bet, '25.00', { id: 'ref-1', currency: 'USD' }),
    );
    const resolver = new ReferenceResolver(repo({ reference }));
    const refund = make(WagerTransactionKind.Refund, '25.00', {}, 'ext-BET');

    expect(await failureCodeOf(resolver, refund)).toBe(FailureCode.ReferenceScopeMismatch);
  });
});

describe('ReferenceResolver — só reverte PROCESSED', () => {
  it('recusa referência ainda não processada', async () => {
    const reference = make(WagerTransactionKind.Bet, '25.00', { id: 'ref-1' });
    const resolver = new ReferenceResolver(repo({ reference }));
    const refund = make(WagerTransactionKind.Refund, '25.00', {}, 'ext-BET');

    expect(await failureCodeOf(resolver, refund)).toBe(FailureCode.ReferenceNotProcessed);
  });

  it('recusa referência REJECTED', async () => {
    const reference = make(WagerTransactionKind.Bet, '25.00', { id: 'ref-1' });
    reference.reject(FailureCode.InsufficientFunds, AT);
    const resolver = new ReferenceResolver(repo({ reference }));
    const refund = make(WagerTransactionKind.Refund, '25.00', {}, 'ext-BET');

    expect(await failureCodeOf(resolver, refund)).toBe(FailureCode.ReferenceNotProcessed);
  });
});

describe('ReferenceResolver — kinds reversíveis (regra 7.3)', () => {
  it('REFUND reverte BET', async () => {
    const reference = processed(make(WagerTransactionKind.Bet, '25.00', { id: 'ref-1' }));
    const resolver = new ReferenceResolver(repo({ reference }));
    const refund = make(WagerTransactionKind.Refund, '25.00', {}, 'ext-BET');

    expect(await resolver.resolve(refund)).toEqual({ outcome: 'resolved', reference });
  });

  for (const kind of [WagerTransactionKind.Win, WagerTransactionKind.Refund]) {
    it(`REFUND NÃO reverte ${kind}`, async () => {
      const reference = processed(
        make(
          kind,
          '25.00',
          { id: 'ref-1' },
          kind === WagerTransactionKind.Refund ? 'x' : undefined,
        ),
      );
      const resolver = new ReferenceResolver(repo({ reference }));
      const refund = make(WagerTransactionKind.Refund, '25.00', {}, 'ext-BET');

      expect(await failureCodeOf(resolver, refund)).toBe(FailureCode.ReferenceKindNotReversible);
    });
  }

  for (const kind of [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]) {
    it(`ROLLBACK reverte ${kind}`, async () => {
      const reference = processed(
        make(
          kind,
          '25.00',
          { id: 'ref-1' },
          kind === WagerTransactionKind.Refund ? 'x' : undefined,
        ),
      );
      const resolver = new ReferenceResolver(repo({ reference }));
      const rollback = make(WagerTransactionKind.Rollback, '25.00', {}, 'ext-BET');

      expect(await resolver.resolve(rollback)).toEqual({ outcome: 'resolved', reference });
    });
  }

  it('ROLLBACK NÃO reverte LOSS — não houve movimento a inverter', async () => {
    const reference = processed(make(WagerTransactionKind.Loss, '25.00', { id: 'ref-1' }));
    const resolver = new ReferenceResolver(repo({ reference }));
    const rollback = make(WagerTransactionKind.Rollback, '25.00', {}, 'ext-BET');

    expect(await failureCodeOf(resolver, rollback)).toBe(FailureCode.ReferenceKindNotReversible);
  });
});

describe('ReferenceResolver — valor igual ao da referência (regra 7.5)', () => {
  it('recusa reversão parcial', async () => {
    const reference = processed(make(WagerTransactionKind.Bet, '25.00', { id: 'ref-1' }));
    const resolver = new ReferenceResolver(repo({ reference }));
    const refund = make(WagerTransactionKind.Refund, '10.00', {}, 'ext-BET');

    expect(await failureCodeOf(resolver, refund)).toBe(FailureCode.ReferenceAmountMismatch);
  });

  it('recusa reversão MAIOR que a referência', async () => {
    const reference = processed(make(WagerTransactionKind.Bet, '25.00', { id: 'ref-1' }));
    const resolver = new ReferenceResolver(repo({ reference }));
    const refund = make(WagerTransactionKind.Refund, '30.00', {}, 'ext-BET');

    expect(await failureCodeOf(resolver, refund)).toBe(FailureCode.ReferenceAmountMismatch);
  });
});

describe('ReferenceResolver — dupla reversão (regra 7.4)', () => {
  it('recusa a segunda reversão do mesmo tipo', async () => {
    const reference = processed(make(WagerTransactionKind.Bet, '25.00', { id: 'ref-1' }));
    const resolver = new ReferenceResolver(repo({ reference, alreadyReversed: true }));
    const refund = make(WagerTransactionKind.Refund, '25.00', {}, 'ext-BET');

    expect(await failureCodeOf(resolver, refund)).toBe(FailureCode.ReferenceAlreadyReversed);
  });
});
