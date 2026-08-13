import { FailureCode } from '@modules/kernel/domain/FailureCode';

export abstract class DomainError extends Error {
  abstract readonly failureCode: FailureCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Terminal e auditável: persiste a transação como REJECTED e gera evento. */
export class BusinessRuleError extends DomainError {
  constructor(
    readonly failureCode: FailureCode,
    message: string,
  ) {
    super(message);
  }
}

export class ValidationError extends DomainError {
  readonly failureCode = FailureCode.ValidationError;
}

export class InvalidMoneyError extends ValidationError {}

export class CurrencyMismatchError extends DomainError {
  readonly failureCode = FailureCode.WalletCurrencyMismatch;
}

/**
 * Separado de BusinessRuleError de propósito: NÃO gera transação REJECTED,
 * porque nada foi decidido sobre a operação — houve conflito de chave.
 *
 * A base existe para que filtro HTTP e classificador da fila reconheçam a
 * FAMÍLIA, não uma lista de classes. Foi justamente uma violação de unicidade
 * fora dessa lista que escapava como 500 no HTTP e como `transient` na fila,
 * gastando 5 reentregas antes da DLQ.
 */
export abstract class ConflictError extends DomainError {}

export class IdempotencyConflictError extends ConflictError {
  readonly failureCode = FailureCode.IdempotencyPayloadMismatch;

  constructor(
    readonly idempotencyKey: string,
    message: string,
  ) {
    super(message);
  }
}

/** O par (providerId, externalTransactionId) já existe sob outra key. */
export class DuplicateProviderTransactionError extends ConflictError {
  readonly failureCode = FailureCode.DuplicateProviderTransaction;

  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Transição a partir de estado terminal: erro de programação, não caminho de
 * negócio. Não deve virar 4xx — sugeriria ao provedor que ele pode corrigir.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly failureCode = FailureCode.ValidationError;
}

/** Retentável (banco fora, lock timeout, throttle) — nunca vira transação REJECTED. */
export class TransientInfrastructureError extends DomainError {
  readonly failureCode = FailureCode.InfrastructureUnavailable;

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
