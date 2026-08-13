import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '@shared/config/AppConfig';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '@shared/Clock';
import { UNIT_OF_WORK, isUniqueViolation, type UnitOfWork } from '@shared/persistence/UnitOfWork';
import { MetricsService } from '@shared/observability/MetricsService';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import type { IntegrationEvent } from '@modules/kernel/domain/event/IntegrationEvent';
import {
  BusinessRuleError,
  DuplicateProviderTransactionError,
  IdempotencyConflictError,
  TransientInfrastructureError,
} from '@modules/kernel/domain/error/KernelErrors';
import { PayloadHasher } from '@modules/kernel/application/PayloadHasher';
import {
  INBOX_REPOSITORY,
  OUTBOX_REPOSITORY,
  type InboxRepository,
  type OutboxRepository,
} from '@modules/messaging/application/port/MessagingPorts';
import { InboxMessage } from '@modules/messaging/domain/InboxMessage';
import { WalletBalanceChanged } from '@modules/wallet/domain/event/WalletBalanceChanged';
import { WalletLedgerEntry } from '@modules/wallet/domain/WalletLedgerEntry';
import type { Wallet } from '@modules/wallet/domain/Wallet';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '@modules/wallet/application/port/WalletRepository';
import {
  JOURNAL_REPOSITORY,
  type JournalRepository,
} from '@modules/wallet/application/port/JournalRepository';
import { JournalFactory } from '@modules/wallet/application/service/JournalFactory';
import { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import {
  SUBMITTABLE_KINDS,
  WagerTransactionKind,
} from '@modules/wagering/domain/enum/WagerTransactionKind';
import { WagerTransactionStatus } from '@modules/wagering/domain/enum/WagerTransactionStatus';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '@modules/wagering/domain/event/WagerTransactionEvents';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@modules/wagering/application/port/WagerTransactionRepository';
import { ReferenceResolver } from '@modules/wagering/application/service/ReferenceResolver';
import {
  WagerRuleEngine,
  type WagerDecision,
} from '@modules/wagering/application/service/WagerRuleEngine';
import type {
  SubmitWagerTransactionInput,
  SubmitWagerTransactionOutput,
} from '@modules/wagering/application/dto/SubmitWagerTransactionInput';

export const WAGER_CONSUMER_NAME = 'wager-transaction-consumer';

/**
 * O mesmo use case atende HTTP e SQS, dentro de UMA transação SQL que cobre
 * inbox, transação, ledger, saldo e outbox. Fluxo completo em ARCHITECTURE.md §5.
 */
@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(JOURNAL_REPOSITORY) private readonly journals: JournalRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(INBOX_REPOSITORY) private readonly inbox: InboxRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly hasher: PayloadHasher,
    private readonly rules: WagerRuleEngine,
    private readonly references: ReferenceResolver,
    private readonly journalFactory: JournalFactory,
    private readonly metrics: MetricsService,
    private readonly config: AppConfig,
  ) {}

  async execute(input: SubmitWagerTransactionInput): Promise<SubmitWagerTransactionOutput> {
    this.assertSubmittableKind(input.kind);

    const payloadHash = this.hasher.hash(input.toHashablePayload());

    try {
      return await this.uow.run(() => this.runTransaction(input, payloadHash));
    } catch (error: unknown) {
      // Última linha de defesa: duas concorrentes com a mesma chave em wallets
      // diferentes só são barradas pelo índice único.
      if (isUniqueViolation(error, 'wager_transactions_idempotency_key_uk')) {
        this.metrics.duplicatesDetected.inc({ source: input.source });
        throw new IdempotencyConflictError(
          input.idempotencyKey,
          `a idempotency key "${input.idempotencyKey}" já está em uso por outra transação`,
        );
      }

      // A busca por idempotency key não enxerga esta colisão: são unicidades
      // distintas. Trocar a key passa pela primeira e só o índice do par barra.
      // Reenviar jamais resolve, então precisa ser 409 terminal — como 500 o
      // provedor retentaria, e na fila gastaria 5 reentregas antes da DLQ.
      if (isUniqueViolation(error, 'wager_transactions_provider_external_uk')) {
        this.metrics.duplicatesDetected.inc({ source: input.source });
        throw new DuplicateProviderTransactionError(
          input.providerId,
          input.externalTransactionId,
          `a transação "${input.externalTransactionId}" do provedor "${input.providerId}" ` +
            `já existe sob outra idempotency key`,
        );
      }

      // O lock da wallet serializa duas reversões da mesma referência, então o
      // `assertNotAlreadyReversed` normalmente decide antes. Se o índice ainda
      // assim disparar, o provedor precisa ver 422 com o código da regra — um
      // 500 sugeriria que reenviar resolve.
      if (isUniqueViolation(error, 'wager_transactions_single_reversal_uk')) {
        throw new BusinessRuleError(
          FailureCode.ReferenceAlreadyReversed,
          `a referência ${String(input.referenceExternalTransactionId)} já foi revertida ` +
            `por um ${input.kind}`,
        );
      }

      throw error;
    }
  }

  private async runTransaction(
    input: SubmitWagerTransactionInput,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionOutput> {
    const now = this.clock.now();

    const inboxMessageId = input.inboxMessageId();
    let inboxMessage: InboxMessage | undefined;

    if (inboxMessageId !== null) {
      const claim = await this.inbox.claim(
        InboxMessage.receive({
          messageId: inboxMessageId,
          consumerName: WAGER_CONSUMER_NAME,
          payloadHash,
          receivedAt: now,
        }),
      );

      if (claim.outcome === 'already_processed') {
        this.metrics.duplicatesDetected.inc({ source: 'inbox' });
        return { outcome: 'duplicate_message' };
      }

      if (claim.outcome === 'in_flight') {
        // Devolver a visibilidade é mais seguro que esperar: se a outra
        // instância falhar, a mensagem volta sozinha.
        throw new TransientInfrastructureError(
          `mensagem ${inboxMessageId} em processamento por outra instância`,
        );
      }

      inboxMessage = claim.message;
    }

    // SEMPRE o primeiro lock da transação: a ordem fixa elimina deadlock, e
    // travar antes do dedup faz duas entregas simultâneas se serializarem — a
    // segunda já vê a primeira como PROCESSED e vira replay, não débito duplo.
    const wallet = await this.wallets.findByIdForUpdate(input.walletId);
    if (!wallet) {
      // Única rejeição não persistida: wallet_id tem FK para wallets.
      throw new BusinessRuleError(
        FailureCode.WalletNotFound,
        `wallet ${input.walletId} não encontrada`,
      );
    }

    const existing = await this.transactions.findByIdempotencyKey(input.idempotencyKey);

    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        this.metrics.duplicatesDetected.inc({ source: 'payload_conflict' });
        throw new IdempotencyConflictError(
          input.idempotencyKey,
          `a idempotency key "${input.idempotencyKey}" já foi usada com um payload diferente`,
        );
      }

      if (existing.isTerminal()) {
        this.metrics.duplicatesDetected.inc({ source: input.source });
        await this.finishInbox(inboxMessage, now);
        return this.replayOf(existing, wallet);
      }
      // PENDING_REFERENCE segue adiante para nova tentativa de resolução.
    }

    const transaction = existing ?? this.createTransaction(input, payloadHash, now);

    const result = await this.applyDecision(transaction, wallet, existing !== null, now, input);

    await this.finishInbox(inboxMessage, now);

    return result;
  }

  private async applyDecision(
    transaction: WagerTransaction,
    wallet: Wallet,
    isExisting: boolean,
    now: Date,
    input: SubmitWagerTransactionInput,
  ): Promise<SubmitWagerTransactionOutput> {
    const events: IntegrationEvent<unknown>[] = [];
    let reference: WagerTransaction | undefined;

    // Dentro do caminho de rejeição, não antes dele: moeda divergente e wallet
    // de outro player são decisões de negócio como qualquer outra e precisam
    // ficar auditáveis como REJECTED, com evento — não sumir num rollback.
    try {
      this.assertWalletScope(transaction, wallet);
    } catch (error: unknown) {
      if (error instanceof BusinessRuleError) {
        return this.rejectTransaction(transaction, wallet, error, isExisting, now, input, events);
      }
      throw error;
    }

    if (transaction.requiresReference()) {
      try {
        const resolution = await this.references.resolve(transaction);

        if (resolution.outcome === 'not_found') {
          return this.handleMissingReference(transaction, wallet, isExisting, now, input, events);
        }
        reference = resolution.reference;
      } catch (error: unknown) {
        if (error instanceof BusinessRuleError) {
          return this.rejectTransaction(transaction, wallet, error, isExisting, now, input, events);
        }
        throw error;
      }
    }

    let decision: WagerDecision;
    try {
      decision = this.rules.decide(transaction, wallet, reference);
    } catch (error: unknown) {
      if (error instanceof BusinessRuleError) {
        return this.rejectTransaction(transaction, wallet, error, isExisting, now, input, events);
      }
      throw error;
    }

    // Calculado antes de qualquer escrita: o saldo final precisa ir para
    // `observed_balance` na própria transação.
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

    // A transação vem ANTES do lançamento: wallet_ledger_entries.transaction_id
    // tem FK para wager_transactions. Indiferente para a atomicidade,
    // obrigatório para a FK.
    transaction.markProcessed(reference?.id, now, wallet.balance);
    await this.persistTransaction(transaction, isExisting);

    if (entry) {
      await this.wallets.insertLedgerEntry(entry);
      await this.wallets.update(wallet);
      await this.journals.record(this.journalFactory.build(entry, transaction.kind));
    }

    events.push(
      WagerTransactionProcessed.from(
        transaction,
        wallet.balance.toJSON(),
        this.eventContext(input, now),
      ),
    );
    // WalletBalanceChanged somente quando o saldo muda.
    if (entry) {
      events.push(WalletBalanceChanged.from(wallet, entry, this.eventContext(input, now)));
    }
    await this.outbox.enqueue(events);

    this.metrics.transactionsTotal.inc({
      kind: transaction.kind,
      status: WagerTransactionStatus.Processed,
    });

    return {
      outcome: 'processed',
      transaction,
      balance: wallet.balance,
      idempotentReplay: false,
    };
  }

  /**
   * Rejeição de negócio TAMBÉM commita: a transação REJECTED é auditável e gera
   * evento, sem lançamento nem mudança de saldo. Rollback apagaria o rastro e o
   * provedor reenviaria a mesma operação inválida para sempre.
   */
  private async rejectTransaction(
    transaction: WagerTransaction,
    wallet: Wallet,
    error: BusinessRuleError,
    isExisting: boolean,
    now: Date,
    input: SubmitWagerTransactionInput,
    events: IntegrationEvent<unknown>[],
  ): Promise<SubmitWagerTransactionOutput> {
    transaction.reject(error.failureCode, now, wallet.balance);
    await this.persistTransaction(transaction, isExisting);

    events.push(
      WagerTransactionRejected.from(transaction, error.failureCode, this.eventContext(input, now)),
    );
    await this.outbox.enqueue(events);

    this.metrics.transactionsTotal.inc({
      kind: transaction.kind,
      status: WagerTransactionStatus.Rejected,
    });

    return {
      outcome: 'rejected',
      transaction,
      balance: wallet.balance,
      failureCode: error.failureCode,
      idempotentReplay: false,
    };
  }

  /** Referência ausente → PENDING_REFERENCE e reprocessamento agendado (seção 7.8). */
  private async handleMissingReference(
    transaction: WagerTransaction,
    wallet: Wallet,
    isExisting: boolean,
    now: Date,
    input: SubmitWagerTransactionInput,
    events: IntegrationEvent<unknown>[],
  ): Promise<SubmitWagerTransactionOutput> {
    const { maxAttempts, backoffCapSeconds } = this.config.pendingReference;

    if (transaction.status === WagerTransactionStatus.PendingReference) {
      transaction.scheduleReferenceRetry(now, backoffCapSeconds);

      if (transaction.hasExhaustedReferenceAttempts(maxAttempts)) {
        const error = new BusinessRuleError(
          FailureCode.ReferenceNotFound,
          `a referência ${String(transaction.referenceExternalTransactionId)} não apareceu ` +
            `após ${String(maxAttempts)} tentativas`,
        );
        return this.rejectTransaction(transaction, wallet, error, isExisting, now, input, events);
      }
    } else {
      transaction.markPendingReference(new Date(now.getTime() + 1_000));
    }

    await this.persistTransaction(transaction, isExisting);

    events.push(WagerTransactionPendingReference.from(transaction, this.eventContext(input, now)));
    await this.outbox.enqueue(events);

    this.metrics.transactionsTotal.inc({
      kind: transaction.kind,
      status: WagerTransactionStatus.PendingReference,
    });

    return {
      outcome: 'pending_reference',
      transaction,
      balance: wallet.balance,
      idempotentReplay: false,
    };
  }

  /** Devolve o resultado original, com o saldo observado naquele momento — não o de agora. */
  private replayOf(transaction: WagerTransaction, wallet: Wallet): SubmitWagerTransactionOutput {
    const balance = transaction.observedBalance ?? wallet.balance;

    if (transaction.status === WagerTransactionStatus.Rejected) {
      return {
        outcome: 'rejected',
        transaction,
        balance,
        failureCode: transaction.failureCode ?? FailureCode.ValidationError,
        idempotentReplay: true,
      };
    }

    return { outcome: 'replay', transaction, balance, idempotentReplay: true };
  }

  private createTransaction(
    input: SubmitWagerTransactionInput,
    payloadHash: string,
    now: Date,
  ): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money,
      ...(input.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
      createdAt: now,
    });
  }

  private async persistTransaction(
    transaction: WagerTransaction,
    isExisting: boolean,
  ): Promise<void> {
    if (isExisting) {
      await this.transactions.update(transaction);
    } else {
      await this.transactions.insert(transaction);
    }
  }

  /** Só chega aqui a mensagem que ESTA transação reivindicou; nunca uma duplicata. */
  private async finishInbox(message: InboxMessage | undefined, now: Date): Promise<void> {
    if (message === undefined) return;
    message.markProcessed(now);
    await this.inbox.markProcessed(message);
  }

  private assertSubmittableKind(kind: WagerTransactionKind): void {
    if (!SUBMITTABLE_KINDS.includes(kind)) {
      throw new BusinessRuleError(
        FailureCode.InvalidTransactionKind,
        `${kind} é interno e não pode ser submetido pela API nem pela fila`,
      );
    }
  }

  private assertWalletScope(transaction: WagerTransaction, wallet: Wallet): void {
    if (wallet.playerId !== transaction.playerId) {
      throw new BusinessRuleError(
        FailureCode.PlayerWalletMismatch,
        `a wallet ${wallet.id} não pertence ao player ${transaction.playerId}`,
      );
    }
    if (wallet.currency !== transaction.money.currency) {
      throw new BusinessRuleError(
        FailureCode.WalletCurrencyMismatch,
        `moeda da operação (${transaction.money.currency}) difere da moeda da wallet (${wallet.currency})`,
      );
    }
  }

  private eventContext(
    input: SubmitWagerTransactionInput,
    now: Date,
  ): { eventId: string; correlationId: string; causationId?: string; occurredAt: Date } {
    return {
      eventId: this.ids.next(),
      correlationId: input.correlationId,
      ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
      occurredAt: now,
    };
  }
}
