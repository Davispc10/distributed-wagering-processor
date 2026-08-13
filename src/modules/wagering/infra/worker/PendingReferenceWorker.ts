import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '@shared/config/AppConfig';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '@shared/Clock';
import { UNIT_OF_WORK, type UnitOfWork } from '@shared/persistence/UnitOfWork';
import { CorrelationContext } from '@shared/observability/CorrelationContext';
import { LoggerService } from '@shared/observability/LoggerService';
import { MetricsService } from '@shared/observability/MetricsService';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import type { Money } from '@modules/kernel/domain/Money';
import { BusinessRuleError } from '@modules/kernel/domain/error/KernelErrors';
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from '@modules/messaging/application/port/MessagingPorts';
import { WalletLedgerEntry } from '@modules/wallet/domain/WalletLedgerEntry';
import type { Wallet } from '@modules/wallet/domain/Wallet';
import { WalletBalanceChanged } from '@modules/wallet/domain/event/WalletBalanceChanged';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '@modules/wallet/application/port/WalletRepository';
import {
  JOURNAL_REPOSITORY,
  type JournalRepository,
} from '@modules/wallet/application/port/JournalRepository';
import { JournalFactory } from '@modules/wallet/application/service/JournalFactory';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@modules/wagering/application/port/WagerTransactionRepository';
import { ReferenceResolver } from '@modules/wagering/application/service/ReferenceResolver';
import { WagerRuleEngine } from '@modules/wagering/application/service/WagerRuleEngine';
import type { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import { WagerTransactionStatus } from '@modules/wagering/domain/enum/WagerTransactionStatus';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '@modules/wagering/domain/event/WagerTransactionEvents';

const CLAIM_BATCH_SIZE = 50;

/**
 * Backoff exponencial até o limite de tentativas; esgotado, a transação vira
 * REJECTED com REFERENCE_NOT_FOUND em vez de ficar pendurada para sempre.
 */
@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly log;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(JOURNAL_REPOSITORY) private readonly journals: JournalRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly references: ReferenceResolver,
    private readonly rules: WagerRuleEngine,
    private readonly journalFactory: JournalFactory,
    private readonly config: AppConfig,
    private readonly metrics: MetricsService,
    logger: LoggerService,
  ) {
    this.log = logger.child('PendingReferenceWorker');
  }

  onModuleInit(): void {
    this.schedule(this.config.pendingReference.pollIntervalMs);
    this.log.info('worker de referências pendentes iniciado');
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
    this.log.info('worker de referências pendentes parado');
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
      void this.inFlight;
    }, delayMs);
  }

  private async tick(): Promise<void> {
    try {
      const processed = await this.processDue();
      this.schedule(processed > 0 ? 0 : this.config.pendingReference.pollIntervalMs);
    } catch (error: unknown) {
      this.log.error({ err: this.messageOf(error) }, 'ciclo de referências pendentes falhou');
      this.schedule(this.config.pendingReference.pollIntervalMs);
    }
  }

  private async processDue(): Promise<number> {
    const now = this.clock.now();

    const due = await this.uow.run(() =>
      this.transactions.claimDuePendingReferences(now, CLAIM_BATCH_SIZE),
    );

    if (due.length === 0) return 0;

    let handled = 0;
    for (const transaction of due) {
      if (this.stopped) break;
      await CorrelationContext.run(
        { correlationId: CorrelationContext.newCorrelationId(), transactionId: transaction.id },
        async () => {
          if (await this.retryOne(transaction.id, transaction.walletId)) handled += 1;
        },
      );
    }
    return handled;
  }

  /**
   * `claimDuePendingReferences` NÃO é um lease: o `FOR UPDATE SKIP LOCKED` morre
   * junto com a transação do claim, então dois workers pegam a mesma linha. Quem
   * serializa é o lock da wallet — e por isso ele vem primeiro, como em todo o
   * resto do sistema.
   *
   * Reler a transação ANTES do lock não adianta: os dois leem PENDING_REFERENCE,
   * o vencedor processa e o perdedor decide em cima de estado obsoleto —
   * gravando REJECTED por cima de um PROCESSED que já lançou no ledger.
   */
  private async retryOne(transactionId: string, walletId: string): Promise<boolean> {
    return this.uow.run(async () => {
      const wallet = await this.wallets.findByIdForUpdate(walletId);
      if (!wallet) return false;

      // Só DEPOIS do lock o estado é confiável. Não inverta estas duas linhas:
      // test/concurrency/pendingReference.test.ts falha se você inverter.
      const transaction = await this.transactions.findById(transactionId);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) {
        return false;
      }

      const now = this.clock.now();
      this.metrics.retriesTotal.inc({ reason: 'pending_reference' });

      try {
        const resolution = await this.references.resolve(transaction);

        if (resolution.outcome === 'not_found') {
          transaction.scheduleReferenceRetry(now, this.config.pendingReference.backoffCapSeconds);

          if (transaction.hasExhaustedReferenceAttempts(this.config.pendingReference.maxAttempts)) {
            await this.reject(
              transaction,
              wallet.balance,
              new BusinessRuleError(
                FailureCode.ReferenceNotFound,
                `referência ${String(transaction.referenceExternalTransactionId)} não apareceu ` +
                  `após ${String(this.config.pendingReference.maxAttempts)} tentativas`,
              ),
              now,
            );
            return true;
          }

          await this.transactions.update(transaction);
          return true;
        }

        await this.applyResolved(transaction, wallet, resolution.reference, now);
        return true;
      } catch (error: unknown) {
        if (error instanceof BusinessRuleError) {
          await this.reject(transaction, wallet.balance, error, now);
          return true;
        }
        throw error;
      }
    });
  }

  private async applyResolved(
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction,
    now: Date,
  ): Promise<void> {
    const decision = this.rules.decide(transaction, wallet, reference);
    let entry: WalletLedgerEntry | undefined;

    if (decision.effect === 'move') {
      const movement = wallet.apply(decision.direction, transaction.money, now);
      entry = WalletLedgerEntry.create({
        id: this.ids.next(),
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: movement.direction,
        money: movement.money,
        balanceBefore: movement.balanceBefore,
        balanceAfter: movement.balanceAfter,
        createdAt: now,
      });
    }

    transaction.markProcessed(reference.id, now, wallet.balance);
    await this.transactions.update(transaction);

    if (entry) {
      await this.wallets.insertLedgerEntry(entry);
      await this.wallets.update(wallet);
      await this.journals.record(this.journalFactory.build(entry, transaction.kind));
    }

    const ctx = {
      eventId: this.ids.next(),
      correlationId: CorrelationContext.correlationId ?? CorrelationContext.newCorrelationId(),
      occurredAt: now,
    };

    const events = [
      WagerTransactionProcessed.from(transaction, wallet.balance.toJSON(), ctx),
      ...(entry
        ? [WalletBalanceChanged.from(wallet, entry, { ...ctx, eventId: this.ids.next() })]
        : []),
    ];
    await this.outbox.enqueue(events);

    this.metrics.transactionsTotal.inc({
      kind: transaction.kind,
      status: WagerTransactionStatus.Processed,
    });
    this.log.info({ transactionId: transaction.id }, 'referência resolvida; transação processada');
  }

  private async reject(
    transaction: WagerTransaction,
    balance: Money,
    error: BusinessRuleError,
    now: Date,
  ): Promise<void> {
    transaction.reject(error.failureCode, now, balance);
    await this.transactions.update(transaction);

    await this.outbox.enqueue([
      WagerTransactionRejected.from(transaction, error.failureCode, {
        eventId: this.ids.next(),
        correlationId: CorrelationContext.correlationId ?? CorrelationContext.newCorrelationId(),
        occurredAt: now,
      }),
    ]);

    this.metrics.transactionsTotal.inc({
      kind: transaction.kind,
      status: WagerTransactionStatus.Rejected,
    });
    this.log.warn(
      { transactionId: transaction.id, failureCode: error.failureCode },
      'referência pendente rejeitada',
    );
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
