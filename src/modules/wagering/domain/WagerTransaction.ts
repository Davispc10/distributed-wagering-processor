import { FailureCode } from '@modules/kernel/domain/FailureCode';
import { LedgerDirection, invertDirection } from '@modules/kernel/domain/LedgerDirection';
import type { Money } from '@modules/kernel/domain/Money';
import {
  BusinessRuleError,
  InvalidTransactionStateError,
  ValidationError,
} from '@modules/kernel/domain/error/KernelErrors';
import { KINDS_REQUIRING_REFERENCE, WagerTransactionKind } from './enum/WagerTransactionKind';
import {
  TERMINAL_STATUSES,
  VALID_TRANSITIONS,
  WagerTransactionStatus,
} from './enum/WagerTransactionStatus';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  referenceAttempts: number;
  nextAttemptAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _referenceAttempts: number = 0,
    private _nextAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new ValidationError(
        `transação exige valor positivo, recebido ${props.money.toString()}`,
      );
    }

    const requiresReference = KINDS_REQUIRING_REFERENCE.includes(props.kind);
    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new BusinessRuleError(
        FailureCode.ReferenceRequired,
        `${props.kind} exige referenceExternalTransactionId`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.referenceAttempts,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /**
   * Saldo no momento da decisão, guardado aqui porque LOSS e REJECTED não geram
   * lançamento — o ledger não serve como fonte universal para o replay.
   */
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance: Money,
  ): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    if (referenceTransactionId !== undefined) {
      this._referenceTransactionId = referenceTransactionId;
    }
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  markPendingReference(nextAttemptAt: Date): void {
    this.assertCanTransitionTo(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    this._nextAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    if (observedBalance !== undefined) this._observedBalance = observedBalance;
    this._nextAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertCanTransitionTo(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Backoff exponencial `2^n` segundos, limitado pelo teto. */
  scheduleReferenceRetry(now: Date, backoffCapSeconds: number): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `só é possível reagendar referência em PENDING_REFERENCE, status atual ${this._status}`,
      );
    }
    this._referenceAttempts += 1;
    const delaySeconds = Math.min(2 ** this._referenceAttempts, backoffCapSeconds);
    this._nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000);
  }

  hasExhaustedReferenceAttempts(maxAttempts: number): boolean {
    return this._referenceAttempts >= maxAttempts;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  /** LOSS registra o desfecho sem mover saldo — e portanto sem ledger. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.includes(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK depende da referência: reverter uma BET credita, reverter um WIN debita. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError(
            'ROLLBACK precisa da transação referenciada para determinar a direção do lançamento',
          );
        }
        return invertDirection(reference.ledgerDirectionFor());
      }

      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS não produz lançamento no ledger');
    }
  }

  private assertCanTransitionTo(next: WagerTransactionStatus): void {
    const allowed = VALID_TRANSITIONS[this._status];
    if (!allowed.includes(next)) {
      throw new InvalidTransactionStateError(
        `transição inválida: ${this._status} → ${next} (transação ${this.id}). ` +
          `Estados terminais não mudam; isto é erro de programação, não caminho de negócio.`,
      );
    }
  }
}
