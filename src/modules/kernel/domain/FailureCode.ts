/**
 * O provedor precisa decidir, sem ler a mensagem de erro, se reenvia, corrige o
 * payload ou desiste.
 */
export enum FailureCode {
  ValidationError = 'VALIDATION_ERROR',

  /** Mesma idempotency key com payload diferente. NÃO é replay. */
  IdempotencyPayloadMismatch = 'IDEMPOTENCY_PAYLOAD_MISMATCH',

  /**
   * Mesmo (providerId, externalTransactionId) submetido sob outra idempotency
   * key. O provedor está reusando um id externo — reenviar nunca resolve.
   */
  DuplicateProviderTransaction = 'DUPLICATE_PROVIDER_TRANSACTION',

  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  WalletCurrencyMismatch = 'WALLET_CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',

  /** Aposta sem saldo: o jogador precisa depositar. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão deixaria a wallet negativa: exige investigação operacional, não retry. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',

  ReferenceRequired = 'REFERENCE_REQUIRED',
  /** Referência não apareceu dentro do TTL. Terminal. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referência de outro provider, player, wallet, moeda ou rodada. */
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',
  /** REFUND só reverte BET; ROLLBACK reverte BET, WIN ou REFUND. */
  ReferenceKindNotReversible = 'REFERENCE_KIND_NOT_REVERSIBLE',
  /** Reversão parcial está fora de escopo: o valor deve ser igual ao da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',

  /** OPENING é interno: não pode chegar pela API nem pela fila. */
  InvalidTransactionKind = 'INVALID_TRANSACTION_KIND',

  InfrastructureUnavailable = 'INFRASTRUCTURE_UNAVAILABLE',
}
