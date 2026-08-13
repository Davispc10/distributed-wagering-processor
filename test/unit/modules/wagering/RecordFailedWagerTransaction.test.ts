import { describe, expect, it } from 'bun:test';
import { AppConfig } from '@shared/config/AppConfig';
import { loadEnv } from '@shared/config/env';
import { LoggerService } from '@shared/observability/LoggerService';
import { MetricsService } from '@shared/observability/MetricsService';
import type { UnitOfWork } from '@shared/persistence/UnitOfWork';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { Money } from '@modules/kernel/domain/Money';
import { PayloadHasher } from '@modules/kernel/application/PayloadHasher';
import { SubmitWagerTransactionInput } from '@modules/wagering/application/dto/SubmitWagerTransactionInput';
import type { WagerTransactionRepository } from '@modules/wagering/application/port/WagerTransactionRepository';
import { RecordFailedWagerTransactionUseCase } from '@modules/wagering/application/usecase/RecordFailedWagerTransactionUseCase';
import { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';
import { WagerTransactionStatus } from '@modules/wagering/domain/enum/WagerTransactionStatus';
import type { WalletRepository } from '@modules/wallet/application/port/WalletRepository';
import { Wallet } from '@modules/wallet/domain/Wallet';

/**
 * `FAILED` é o terminal de erro PERMANENTE de infraestrutura (seção 6.3). Sem
 * este caminho o estado existiria no enum e nunca no banco, e a operação sumiria
 * junto com a mensagem descartada na DLQ.
 */

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const NOW = new Date('2026-08-11T12:00:00.000Z');

const uow: UnitOfWork = { run: <T>(work: () => Promise<T>) => work() };

const input = (
  overrides: { kind?: WagerTransactionKind; amount?: string } = {},
): SubmitWagerTransactionInput =>
  SubmitWagerTransactionInput.fromMessage({
    idempotencyKey: 'provider-a:ext-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    playerId: 'p-1',
    walletId: 'w-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: overrides.kind ?? WagerTransactionKind.Bet,
    money: brl(overrides.amount ?? '25.00'),
    messageId: 'msg-1',
    correlationId: 'corr-1',
  });

const existingTransaction = (): WagerTransaction =>
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
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: NOW,
  });

interface Recorded {
  inserted: WagerTransaction[];
  updated: WagerTransaction[];
}

const build = (options: {
  existing?: WagerTransaction | null;
  wallet?: Wallet | null;
  onWrite?: () => never;
}): { useCase: RecordFailedWagerTransactionUseCase; recorded: Recorded } => {
  const recorded: Recorded = { inserted: [], updated: [] };

  const transactions = {
    findByIdempotencyKey: () => Promise.resolve(options.existing ?? null),
    insert: (t: WagerTransaction) => {
      options.onWrite?.();
      recorded.inserted.push(t);
      return Promise.resolve();
    },
    update: (t: WagerTransaction) => {
      options.onWrite?.();
      recorded.updated.push(t);
      return Promise.resolve();
    },
    findById: () => Promise.reject(new Error('não deveria ser chamado')),
    findByProviderAndExternalId: () => Promise.reject(new Error('não deveria ser chamado')),
    hasProcessedReversal: () => Promise.reject(new Error('não deveria ser chamado')),
    claimDuePendingReferences: () => Promise.reject(new Error('não deveria ser chamado')),
  } satisfies WagerTransactionRepository;

  const wallets = {
    findById: () =>
      Promise.resolve(
        options.wallet === undefined
          ? Wallet.open({ id: 'w-1', playerId: 'p-1', initialBalance: brl('100.00'), at: NOW })
          : options.wallet,
      ),
    findByIdForUpdate: () => Promise.reject(new Error('não deveria ser chamado')),
    findByPlayerAndCurrency: () => Promise.reject(new Error('não deveria ser chamado')),
    insert: () => Promise.reject(new Error('não deveria ser chamado')),
    update: () => Promise.reject(new Error('não deveria ser chamado')),
    insertLedgerEntry: () => Promise.reject(new Error('não deveria ser chamado')),
    listLedger: () => Promise.reject(new Error('não deveria ser chamado')),
    sumLedger: () => Promise.reject(new Error('não deveria ser chamado')),
  } satisfies WalletRepository;

  const useCase = new RecordFailedWagerTransactionUseCase(
    uow,
    transactions,
    wallets,
    { now: () => NOW },
    { next: () => 't-novo' },
    new PayloadHasher(),
    new MetricsService(),
    new LoggerService(new AppConfig(loadEnv({ LOG_LEVEL: 'fatal' }))),
  );

  return { useCase, recorded };
};

describe('RecordFailedWagerTransaction — transação já existente', () => {
  it('marca a transação não terminal como FAILED', async () => {
    const existing = existingTransaction();
    const { useCase, recorded } = build({ existing });

    const outcome = await useCase.execute(input(), FailureCode.InfrastructureUnavailable);

    expect(outcome).toBe('recorded');
    expect(existing.status).toBe(WagerTransactionStatus.Failed);
    expect(existing.failureCode).toBe(FailureCode.InfrastructureUnavailable);
    expect(existing.processedAt).toEqual(NOW);
    expect(recorded.updated).toHaveLength(1);
    expect(recorded.inserted).toHaveLength(0);
  });

  /** PROCESSED é a verdade auditada; FAILED não a apaga. */
  it('NÃO sobrescreve uma transação já PROCESSED', async () => {
    const existing = existingTransaction();
    existing.markProcessed(undefined, NOW, brl('75.00'));
    const { useCase, recorded } = build({ existing });

    expect(await useCase.execute(input())).toBe('already_terminal');
    expect(existing.status).toBe(WagerTransactionStatus.Processed);
    expect(recorded.updated).toHaveLength(0);
  });

  it('NÃO sobrescreve uma transação já REJECTED', async () => {
    const existing = existingTransaction();
    existing.reject(FailureCode.InsufficientFunds, NOW);
    const { useCase } = build({ existing });

    expect(await useCase.execute(input())).toBe('already_terminal');
    expect(existing.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});

describe('RecordFailedWagerTransaction — transação inexistente', () => {
  it('grava uma linha nova já em FAILED', async () => {
    const { useCase, recorded } = build({ existing: null });

    expect(await useCase.execute(input())).toBe('recorded');
    expect(recorded.inserted).toHaveLength(1);
    expect(recorded.inserted[0]?.status).toBe(WagerTransactionStatus.Failed);
    expect(recorded.inserted[0]?.idempotencyKey).toBe('provider-a:ext-1');
  });

  /** FK `wager_transactions.wallet_id`: a linha órfã nem poderia ser gravada. */
  it('desiste quando a wallet não existe', async () => {
    const { useCase, recorded } = build({ existing: null, wallet: null });

    expect(await useCase.execute(input())).toBe('not_recordable');
    expect(recorded.inserted).toHaveLength(0);
  });

  it('desiste quando o payload nem forma transação válida', async () => {
    const { useCase, recorded } = build({ existing: null });

    // Valor zero: `create` recusa, e o `CHECK (money_amount > 0)` também.
    expect(await useCase.execute(input({ amount: '0.00' }))).toBe('not_recordable');
    expect(recorded.inserted).toHaveLength(0);
  });

  it('REFUND sem referência não vira linha FAILED — o CHECK do schema recusaria', async () => {
    const { useCase, recorded } = build({ existing: null });

    expect(await useCase.execute(input({ kind: WagerTransactionKind.Refund }))).toBe(
      'not_recordable',
    );
    expect(recorded.inserted).toHaveLength(0);
  });
});

describe('RecordFailedWagerTransaction — best-effort', () => {
  /** Auditar é desejável; impedir a DLQ por causa disso seria pior. */
  it('falha de banco ao auditar não propaga: devolve not_recordable', async () => {
    const { useCase } = build({
      existing: existingTransaction(),
      onWrite: () => {
        throw new Error('conexão perdida');
      },
    });

    expect(await useCase.execute(input())).toBe('not_recordable');
  });
});
