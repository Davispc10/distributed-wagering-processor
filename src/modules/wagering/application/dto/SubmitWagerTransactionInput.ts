import type { FailureCode } from '@modules/kernel/domain/FailureCode';
import type { Money } from '@modules/kernel/domain/Money';
import type { WagerTransaction } from '@modules/wagering/domain/WagerTransaction';
import type { WagerTransactionKind } from '@modules/wagering/domain/enum/WagerTransactionKind';

/**
 * O `messageId` faz parte da origem, não é um campo opcional solto: só existe
 * quando a submissão vem da fila, e ali é obrigatório porque é a chave do inbox.
 * Modelado como união discriminada, o compilador impede construir uma submissão
 * SQS sem ele — antes isso só estourava em runtime.
 */
export type SubmissionOrigin = { source: 'http' } | { source: 'sqs'; messageId: string };

export interface WagerOperationProps {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  causationId?: string;
}

/**
 * Entrada do use case central, com uma factory por adapter.
 *
 * As factories existem para que o controller HTTP e o consumidor SQS não
 * repitam a montagem dos 12 campos nem precisem lembrar de casar `source` com
 * `messageId`.
 */
export class SubmitWagerTransactionInput {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly origin: SubmissionOrigin;

  private constructor(props: WagerOperationProps, origin: SubmissionOrigin) {
    this.idempotencyKey = props.idempotencyKey;
    this.providerId = props.providerId;
    this.externalTransactionId = props.externalTransactionId;
    this.playerId = props.playerId;
    this.walletId = props.walletId;
    this.roundId = props.roundId;
    this.gameId = props.gameId;
    this.kind = props.kind;
    this.money = props.money;
    if (props.referenceExternalTransactionId !== undefined) {
      this.referenceExternalTransactionId = props.referenceExternalTransactionId;
    }
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.origin = origin;
  }

  static fromHttp(props: WagerOperationProps): SubmitWagerTransactionInput {
    return new SubmitWagerTransactionInput(props, { source: 'http' });
  }

  static fromMessage(
    props: WagerOperationProps & { messageId: string },
  ): SubmitWagerTransactionInput {
    return new SubmitWagerTransactionInput(props, {
      source: 'sqs',
      messageId: props.messageId,
    });
  }

  get source(): SubmissionOrigin['source'] {
    return this.origin.source;
  }

  /** Só a origem SQS registra inbox; o `messageId` vem tipado, sem checagem em runtime. */
  inboxMessageId(): string | null {
    return this.origin.source === 'sqs' ? this.origin.messageId : null;
  }

  /** Campos de negócio que entram no `payloadHash` — transporte fica de fora. */
  toHashablePayload(): {
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: string;
    money: { amount: string; currency: string };
    referenceExternalTransactionId?: string;
  } {
    return {
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      playerId: this.playerId,
      walletId: this.walletId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money.toJSON(),
      ...(this.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: this.referenceExternalTransactionId }
        : {}),
    };
  }
}

/**
 * Union em vez de campos opcionais: o adapter mapeia `outcome` para status sem
 * inspecionar combinações, e o compilador cobra todo caso novo em cada adapter.
 */
export type SubmitWagerTransactionOutput =
  | {
      outcome: 'processed';
      transaction: WagerTransaction;
      balance: Money;
      idempotentReplay: false;
    }
  | {
      outcome: 'replay';
      transaction: WagerTransaction;
      balance: Money;
      idempotentReplay: true;
    }
  | {
      outcome: 'rejected';
      transaction: WagerTransaction;
      balance: Money;
      failureCode: FailureCode;
      idempotentReplay: boolean;
    }
  | {
      outcome: 'pending_reference';
      transaction: WagerTransaction;
      balance: Money;
      idempotentReplay: boolean;
    }
  /** Mensagem SQS já processada anteriormente: apenas dê ack. */
  | { outcome: 'duplicate_message' };
