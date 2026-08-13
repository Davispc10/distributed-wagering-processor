import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, ID_GENERATOR, type Clock, type IdGenerator } from '@shared/Clock';
import { UNIT_OF_WORK, isUniqueViolation, type UnitOfWork } from '@shared/persistence/UnitOfWork';
import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { Money } from '@modules/kernel/domain/Money';
import { LedgerDirection } from '@modules/kernel/domain/LedgerDirection';
import type { IntegrationEvent } from '@modules/kernel/domain/event/IntegrationEvent';
import { BusinessRuleError } from '@modules/kernel/domain/error/KernelErrors';
import { PayloadHasher } from '@modules/kernel/application/PayloadHasher';
import {
  OUTBOX_REPOSITORY,
  type OutboxRepository,
} from '@modules/messaging/application/port/MessagingPorts';
import {
  WAGER_TRANSACTION_REPOSITORY,
  type WagerTransactionRepository,
} from '@modules/wagering/application/port/WagerTransactionRepository';
import { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';
import { WagerTransactionProcessed } from '@modules/wagering/domain/event/WagerTransactionEvents';
import { Wallet } from '@modules/wallet/domain/Wallet';
import { WalletLedgerEntry } from '@modules/wallet/domain/WalletLedgerEntry';
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

export interface OpenWalletInput {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

export interface OpenWalletOutput {
  wallet: Wallet;
}

/**
 * Saldo inicial > 0 gera uma transação `OPENING` com lançamento CREDIT na mesma
 * transação SQL: sem ela, a wallet nasceria com saldo que o ledger não explica.
 */
@Injectable()
export class OpenWalletUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(JOURNAL_REPOSITORY) private readonly journals: JournalRepository,
    @Inject(WAGER_TRANSACTION_REPOSITORY)
    private readonly transactions: WagerTransactionRepository,
    @Inject(OUTBOX_REPOSITORY) private readonly outbox: OutboxRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    private readonly hasher: PayloadHasher,
    private readonly journalFactory: JournalFactory,
  ) {}

  async execute(input: OpenWalletInput): Promise<OpenWalletOutput> {
    try {
      return await this.uow.run(() => this.runTransaction(input));
    } catch (error: unknown) {
      // Duas aberturas simultâneas: o índice único decide o vencedor.
      if (isUniqueViolation(error, 'wallets_player_currency_uk')) {
        throw new BusinessRuleError(
          FailureCode.WalletAlreadyExists,
          `já existe uma wallet para o player ${input.playerId} em ${input.initialBalance.currency}`,
        );
      }
      throw error;
    }
  }

  private async runTransaction(input: OpenWalletInput): Promise<OpenWalletOutput> {
    const currency = input.initialBalance.currency;

    const duplicate = await this.wallets.findByPlayerAndCurrency(input.playerId, currency);
    if (duplicate) {
      throw new BusinessRuleError(
        FailureCode.WalletAlreadyExists,
        `já existe uma wallet para o player ${input.playerId} em ${currency}`,
      );
    }

    const now = this.clock.now();
    const walletId = this.ids.next();

    // Nasce com o saldo inicial e version = 1: o lançamento OPENING descreve o
    // crédito que a abertura já embutiu, então não incrementa a version de novo.
    const wallet = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      at: now,
    });

    await this.wallets.insert(wallet);

    if (input.initialBalance.isZero()) {
      return { wallet };
    }

    const externalId = `opening:${walletId}`;
    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: 'internal',
      externalTransactionId: externalId,
      idempotencyKey: `internal:${externalId}`,
      payloadHash: this.hasher.hash({
        providerId: 'internal',
        externalTransactionId: externalId,
        playerId: input.playerId,
        walletId,
        roundId: 'opening',
        gameId: 'opening',
        kind: WagerTransactionKind.Opening,
        money: input.initialBalance.toJSON(),
      }),
      walletId,
      playerId: input.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: input.initialBalance,
      createdAt: now,
    });

    const entry = WalletLedgerEntry.create({
      id: this.ids.next(),
      walletId,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: input.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: input.initialBalance,
      createdAt: now,
    });

    transaction.markProcessed(undefined, now, wallet.balance);

    // Transação antes do lançamento: FK de wallet_ledger_entries.transaction_id.
    await this.transactions.insert(transaction);
    await this.wallets.insertLedgerEntry(entry);
    await this.journals.record(this.journalFactory.build(entry, WagerTransactionKind.Opening));

    const ctx = {
      eventId: this.ids.next(),
      correlationId: input.correlationId,
      occurredAt: now,
    };
    const events: IntegrationEvent<unknown>[] = [
      WagerTransactionProcessed.from(transaction, wallet.balance.toJSON(), ctx),
      WalletBalanceChanged.from(wallet, entry, {
        ...ctx,
        eventId: this.ids.next(),
      }),
    ];
    await this.outbox.enqueue(events);

    return { wallet };
  }
}
