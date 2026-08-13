import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '@shared/Clock';
import { UNIT_OF_WORK, type UnitOfWork } from '@shared/persistence/UnitOfWork';
import { LoggerService } from '@shared/observability/LoggerService';
import { MetricsService } from '@shared/observability/MetricsService';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { PayloadHasher } from '@modules/kernel/application/PayloadHasher';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '@modules/wallet/application/port/WalletRepository';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@modules/wagering/application/port/WagerTransactionRepository';
import { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import { WagerTransactionStatus } from '@modules/wagering/domain/enum/WagerTransactionStatus';
import type { SubmitWagerTransactionInput } from '@modules/wagering/application/dto/SubmitWagerTransactionInput';

export type RecordFailureOutcome =
  /** Linha `FAILED` gravada — a operação ficou auditável. */
  | 'recorded'
  /** Já era terminal: PROCESSED/REJECTED/FAILED não são sobrescritos. */
  | 'already_terminal'
  /** Payload não forma uma transação válida (ou a wallet não existe): só DLQ. */
  | 'not_recordable';

/**
 * `FAILED` é o estado terminal de erro PERMANENTE de infraestrutura (seção 6.3).
 * Existe para deixar rastro: mandar a mensagem para a DLQ e não gravar nada faz
 * a operação sumir do banco, e o provedor fica sem resposta em
 * `GET /providers/:id/wagering/transactions/:externalId`.
 *
 * É best-effort de propósito — falhar ao auditar nunca pode impedir a DLQ.
 */
@Injectable()
export class RecordFailedWagerTransactionUseCase {
  private readonly log;

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly hasher: PayloadHasher,
    private readonly metrics: MetricsService,
    logger: LoggerService,
  ) {
    this.log = logger.child('RecordFailedWagerTransactionUseCase');
  }

  async execute(
    input: SubmitWagerTransactionInput,
    failureCode: FailureCode = FailureCode.InfrastructureUnavailable,
  ): Promise<RecordFailureOutcome> {
    try {
      return await this.uow.run(() => this.record(input, failureCode));
    } catch (error: unknown) {
      // Auditar é desejável; bloquear a DLQ por causa disso, não.
      this.log.error(
        { idempotencyKey: input.idempotencyKey, err: this.messageOf(error) },
        'não foi possível registrar a transação como FAILED',
      );
      return 'not_recordable';
    }
  }

  private async record(
    input: SubmitWagerTransactionInput,
    failureCode: FailureCode,
  ): Promise<RecordFailureOutcome> {
    const now = this.clock.now();
    const existing = await this.transactions.findByIdempotencyKey(input.idempotencyKey);

    if (existing) {
      // PROCESSED e REJECTED já são a verdade auditada; FAILED não os apaga.
      if (existing.isTerminal()) return 'already_terminal';

      existing.fail(failureCode, now);
      await this.transactions.update(existing);
      this.countFailed(input);
      return 'recorded';
    }

    // `wager_transactions.wallet_id` tem FK: sem wallet, a linha não existe.
    const wallet = await this.wallets.findById(input.walletId);
    if (!wallet) return 'not_recordable';

    const transaction = this.tryCreate(input, now);
    if (!transaction) return 'not_recordable';

    transaction.fail(failureCode, now);
    await this.transactions.insert(transaction);
    this.countFailed(input);
    return 'recorded';
  }

  /**
   * Um payload que nem forma transação válida (valor não positivo, reversão sem
   * referência) não tem o que auditar além da própria DLQ — as mesmas
   * `CHECK`s do schema recusariam a linha.
   */
  private tryCreate(input: SubmitWagerTransactionInput, now: Date): WagerTransaction | null {
    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: this.hasher.hash(input.toHashablePayload()),
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
    } catch {
      return null;
    }
  }

  private countFailed(input: SubmitWagerTransactionInput): void {
    this.metrics.transactionsTotal.inc({
      kind: input.kind,
      status: WagerTransactionStatus.Failed,
    });
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
